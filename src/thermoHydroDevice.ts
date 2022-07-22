/***********************************************************************
 * YoLink device list
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initThermoHydroDevice
 *
 */
export async function initThermoHydroDevice(deviceClass: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = deviceClass.platform;
  const accessory: PlatformAccessory = deviceClass.accessory;
  const device = accessory.context.device;

  deviceClass.thermoService = accessory.getService(platform.Service.TemperatureSensor)
                           || accessory.addService(platform.Service.TemperatureSensor);
  deviceClass.thermoService.setCharacteristic(platform.Characteristic.Name, device.name);
  deviceClass.thermoService.getCharacteristic(platform.Characteristic.CurrentTemperature)
    .onGet(handleThermoGet.bind(deviceClass));

  deviceClass.hydroService = accessory.getService(platform.Service.HumiditySensor)
                           || accessory.addService(platform.Service.HumiditySensor);
  deviceClass.hydroService.setCharacteristic(platform.Characteristic.Name, device.name);
  deviceClass.hydroService.getCharacteristic(platform.Characteristic.CurrentRelativeHumidity)
    .onGet(handleHydroGet.bind(deviceClass));
  // Call get handler to initialize data fields to current state
  deviceClass.thermoService.getCharacteristic(platform.Characteristic.CurrentTemperature).getValue();
}

/***********************************************************************
 * updateAlert
 *
 */
function updateAlert(deviceClass: YoLinkPlatformAccessory, data): void {
  const platform = deviceClass.platform;
  platform.verboseLog('Update thermo/hydro from:' + JSON.stringify(data));

  deviceClass.thermoService.updateCharacteristic(platform.Characteristic.StatusLowBattery, (data.battery <= 1)
    ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
    : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  deviceClass.hydroService.updateCharacteristic(platform.Characteristic.StatusLowBattery, (data.battery <= 1)
    ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
    : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

  if (data.alarm.lowBattery) {
    deviceClass.thermoService.updateCharacteristic(platform.Characteristic.StatusLowBattery,
      platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    deviceClass.hydroService.updateCharacteristic(platform.Characteristic.StatusLowBattery,
      platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
  } else {
    deviceClass.thermoService.updateCharacteristic(platform.Characteristic.StatusLowBattery,
      platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    deviceClass.hydroService.updateCharacteristic(platform.Characteristic.StatusLowBattery,
      platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  }
  if (data.alarm.lowTemp || data.alarm.highTemp) {
    deviceClass.thermoService.updateCharacteristic(platform.Characteristic.StatusActive, true);
  } else {
    deviceClass.thermoService.updateCharacteristic(platform.Characteristic.StatusActive, false);
  }
  if (data.alarm.lowHumidity || data.alarm.highHumidity) {
    deviceClass.hydroService.updateCharacteristic(platform.Characteristic.StatusActive, true);
  } else {
    deviceClass.hydroService.updateCharacteristic(platform.Characteristic.StatusActive, false);
  }
}

/***********************************************************************
 * handleThermoGet
 *
 */
async function handleThermoGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  const device = this.accessory.context.device;
  await this.checkDeviceState(platform, device);

  updateAlert(this, device.data.state);
  platform.liteLog('Device state for ' + device.name + ' (' + device.deviceId + ') (temperature) is: ' + device.data.state.temperature);

  await releaseSemaphore();
  return (device.data.state.temperature);
}

/***********************************************************************
 * handleHydroGet
 *
 */
async function handleHydroGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  const device = this.accessory.context.device;
  await this.checkDeviceState(platform, device);

  updateAlert(this, device.data.state);
  platform.liteLog('Device state for ' + device.name + ' (' + device.deviceId + ') (humidity) is: ' + device.data.state.humidity);

  await releaseSemaphore();
  return (device.data.state.humidity);
}

/***********************************************************************
 * mqttThermoHydroDevice
 *
 */
export async function mqttThermoHydroDevice(deviceClass: YoLinkPlatformAccessory, data): Promise<void> {
  const platform: YoLinkHomebridgePlatform = deviceClass.platform;

  // serialize access to device data.
  const releaseSemaphore = await deviceClass.deviceSemaphore.acquire();
  const device = deviceClass.accessory.context.device;
  device.updateTime = Math.floor(new Date().getTime() / 1000) + deviceClass.config.refreshAfter;
  const event = data.event.split('.');

  switch (event[1]) {
    case 'Alert':
      // falls through
    case 'Report':
      updateAlert(deviceClass, data.data);
      device.data.state.battery = data.data.battery;
      device.data.state.state = data.data.state;
      deviceClass.thermoService.updateCharacteristic(platform.Characteristic.CurrentTemperature, data.data.temperature);
      deviceClass.hydroService.updateCharacteristic(platform.Characteristic.CurrentRelativeHumidity, data.data.humidity);
      break;
    default:
      platform.log.warn('Unsupported mqtt event: \'' + data.event + '\'\n'
        + 'Please report at https://github.com/dkerr64/homebridge-yolink/issues\n'
        + JSON.stringify(data));
  }

  await releaseSemaphore();
}