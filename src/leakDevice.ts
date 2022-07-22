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
 * initLeakSensor
 *
 */
export async function initLeakSensor(deviceClass: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = deviceClass.platform;
  const accessory: PlatformAccessory = deviceClass.accessory;
  const device = accessory.context.device;

  deviceClass.leakService = accessory.getService(platform.Service.LeakSensor) || accessory.addService(platform.Service.LeakSensor);
  deviceClass.leakService.setCharacteristic(platform.Characteristic.Name, device.name);
  deviceClass.leakService.getCharacteristic(platform.Characteristic.LeakDetected)
    .onGet(handleGet.bind(deviceClass));
  // Call get handler to initialize data fields to current state
  deviceClass.leakService.getCharacteristic(platform.Characteristic.LeakDetected).getValue();
}

/***********************************************************************
 * handleGet
 *
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  const device = this.accessory.context.device;
  await this.checkDeviceState(platform, device);

  this.leakService.updateCharacteristic(platform.Characteristic.StatusLowBattery, (device.data.state.battery <= 1)
    ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
    : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  platform.liteLog('Device state for ' + device.name + ' (' + device.deviceId + ') is: ' + device.data.state.state);

  await releaseSemaphore();
  return ((device.data.state.state === 'alert')
    ? platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED
    : platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
}

/***********************************************************************
 * mqttLeakSensor
 *
 */
export async function mqttLeakSensor(deviceClass: YoLinkPlatformAccessory, data): Promise<void> {
  const platform: YoLinkHomebridgePlatform = deviceClass.platform;

  // serialize access to device data.
  const releaseSemaphore = await deviceClass.deviceSemaphore.acquire();
  const device = deviceClass.accessory.context.device;
  device.updateTime = Math.floor(new Date().getTime() / 1000) + deviceClass.config.refreshAfter;
  const event = data.event.split('.');

  switch (event[1]) {
    case 'Alert':
      // falls through
    case 'StatusChange':
      // falls through
    case 'Report':
      device.data.state.battery = data.data.battery;
      device.data.state.state = data.data.state;
      deviceClass.leakService
        .updateCharacteristic(platform.Characteristic.StatusLowBattery,
          (data.data.battery <= 1)
            ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
        .updateCharacteristic(platform.Characteristic.LeakDetected,
          (data.data.state === 'alert')
            ? platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED
            : platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
      break;
    default:
      platform.log.warn('Unsupported mqtt event: \'' + data.event + '\'\n'
        + 'Please report at https://github.com/dkerr64/homebridge-yolink/issues\n'
        + JSON.stringify(data));
  }

  await releaseSemaphore();
}