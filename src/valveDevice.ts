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
 * initValveDevice
 *
 */
export async function initValveDevice(deviceClass: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = deviceClass.platform;
  const accessory: PlatformAccessory = deviceClass.accessory;
  const device = accessory.context.device;

  deviceClass.valveService = accessory.getService(platform.Service.Valve) || accessory.addService(platform.Service.Valve);
  deviceClass.valveService.setCharacteristic(platform.Characteristic.Name, device.name);
  deviceClass.valveService.getCharacteristic(platform.Characteristic.Active)
    .onGet(handleGet.bind(deviceClass))
    .onSet(handleSet.bind(deviceClass));
  deviceClass.valveService.getCharacteristic(platform.Characteristic.InUse)
    .onGet(handleInUse.bind(deviceClass));
  deviceClass.valveService.getCharacteristic(platform.Characteristic.ValveType)
    .onGet(handleType.bind(deviceClass));
  // Call get handler to initialize data fields to current state
  deviceClass.valveService.getCharacteristic(platform.Characteristic.Active).getValue();
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

  this.valveService.updateCharacteristic(platform.Characteristic.StatusLowBattery, (device.data.battery <= 1)
    ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
    : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  platform.liteLog('Device state for ' + device.name + ' (' + device.deviceId + ') is: ' + device.data.state);

  await releaseSemaphore();
  return ((device.data.state === 'open')
    ? platform.api.hap.Characteristic.Active.ACTIVE
    : platform.api.hap.Characteristic.Active.INACTIVE);
}

/***********************************************************************
 * handleInUse
 *
 */
async function handleInUse(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const device = this.accessory.context.device;
  this.platform.liteLog('Valve in use state for ' + device.name + ' (' + device.deviceId + '), calling isActive?');
  // Not sure exactly what "in use" is for.  An alternative for Active so just call handleGet()?
  return(await handleGet.bind(this)());
}

/***********************************************************************
 * handleSet
 *
 */
async function handleSet(this: YoLinkPlatformAccessory, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  const device = this.accessory.context.device;
  platform.log.info('setDeviceState for ' + device.name + ' (' + device.deviceId + ')');
  const newState = (value === platform.api.hap.Characteristic.Active.ACTIVE) ? 'open' : 'close';

  const data = await platform.yolinkAPI.setDeviceState(platform, device, {'state':newState});
  device.data.state = (data) ? data.state : '';

  await releaseSemaphore();
}

/***********************************************************************
 * handleType
 *
 */
async function handleType(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  return this.platform.Characteristic.ValveType.GENERIC_VALVE;
}


/***********************************************************************
 * mqttValveDevice
 *
 */
export async function mqttValveDevice(deviceClass: YoLinkPlatformAccessory, data): Promise<void> {
  const platform: YoLinkHomebridgePlatform = deviceClass.platform;

  // serialize access to device data.
  const releaseSemaphore = await deviceClass.deviceSemaphore.acquire();
  const device = deviceClass.accessory.context.device;
  device.updateTime = Math.floor(new Date().getTime() / 1000) + deviceClass.config.refreshAfter;
  const event = data.event.split('.');

  switch (event[1]) {
    case 'Report':
    // falls through
    case 'getState':
      device.data.battery = data.data.battery;
      deviceClass.valveService
        .updateCharacteristic(platform.Characteristic.StatusLowBattery,
          (data.data.battery <= 1)
            ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
      // falls through
    case 'setState':
      device.data.state = data.data.state;
      deviceClass.valveService
        .updateCharacteristic(platform.Characteristic.Active,
          (data.data.state === 'open')
            ? platform.api.hap.Characteristic.Active.ACTIVE
            : platform.api.hap.Characteristic.Active.INACTIVE);
      break;
    default:
      platform.log.warn('Unsupported mqtt event: \'' + data.event + '\'\n'
        + 'Please report at https://github.com/dkerr64/homebridge-yolink/issues\n'
        + JSON.stringify(data));
  }

  await releaseSemaphore();
}