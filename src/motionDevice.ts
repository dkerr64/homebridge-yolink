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
 * initMotionDetector
 *
 */
export async function initMotionSensor(deviceClass: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = deviceClass.platform;
  const accessory: PlatformAccessory = deviceClass.accessory;
  const device = accessory.context.device;

  deviceClass.motionService = accessory.getService(platform.Service.MotionSensor) || accessory.addService(platform.Service.MotionSensor);
  deviceClass.motionService.setCharacteristic(platform.Characteristic.Name, device.name);
  deviceClass.motionService.getCharacteristic(platform.Characteristic.MotionDetected)
    .onGet(handleGet.bind(deviceClass));
  // Call get handler to initialize data fields to current state
  deviceClass.motionService.getCharacteristic(platform.Characteristic.MotionDetected).getValue();
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

  this.motionService.updateCharacteristic(platform.Characteristic.StatusLowBattery, (device.data.state.battery <= 1)
    ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
    : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  platform.liteLog('Device state for ' + device.name + ' (' + device.deviceId + ') is: ' + device.data.state.state);

  await releaseSemaphore();
  return (device.data.state.state === 'alert');
}

/***********************************************************************
 * mqttMotionDetector
 *
 */
export async function mqttMotionSensor(deviceClass: YoLinkPlatformAccessory, data): Promise<void> {
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
      // falls through
    case 'StatusChange':
      device.data.state.battery = data.data.battery;
      device.data.state.state = data.data.state;
      deviceClass.motionService
        .updateCharacteristic(platform.Characteristic.StatusLowBattery,
          (data.data.battery <= 1)
            ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
        .updateCharacteristic(platform.Characteristic.MotionDetected,
          (data.data.state === 'alert') ? true : false );
      break;
    case 'setOpenRemind':
      // I don't know what this is intended for.  I have seen it from the YoLink
      // outdoor motion sensor.  It does not carry either motion state or battery
      // state fields, so there is nothing we can update.  Sample packet...
      // {"event":"MotionSensor.setOpenRemind","time":1658089933504,"msgid":"1658089933504",
      // "data":{"alertInterval":1,"ledAlarm":false,"nomotionDelay":1,"sensitivity":2,
      // "loraInfo":{"signal":-87,"gatewayId":"<redacted>","gateways":1}},"deviceId":"<redacted>"}
      break;
    default:
      platform.log.warn('Unsupported mqtt event: \'' + data.event + '\'\n'
        + 'Please report at https://github.com/dkerr64/homebridge-yolink/issues\n'
        + JSON.stringify(data));
  }

  await releaseSemaphore();
}