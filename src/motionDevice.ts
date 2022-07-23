/***********************************************************************
 * YoLink motion and vibration sensor device support.
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
  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  deviceClass.refreshDataTimer(handleGet.bind(deviceClass));
}

/***********************************************************************
 * handleGet
 *
 * This is an example of JSON object returned.  Two examples here, one
 * from a motion sensor, 2nd one from a vibration sensor.  Parameters
 * we care abour are the same across both.
 *  {
 *    "online": true,
 *    "state": {
 *      "alertInterval": 1,
 *      "battery": 4,
 *      "devTemperature": 21,
 *      "ledAlarm": false,
 *      "nomotionDelay": 1,
 *      "sensitivity": 2,
 *      "state": "normal",
 *      "version": "050c",
 *      "stateChangedAt": 1658492889682,
 *      "batteryType": "Li"
 *    },
 *    "deviceId": "abcdef1234567890",
 *    "reportAt": "2022-07-22T12:28:09.682Z"
 *  }
 * ========
 *  {
 *    "online": true,
 *    "state": {
 *      "alertInterval": 60,
 *      "battery": 4,
 *      "devTemperature": 23,
 *      "noVibrationDelay": 1,
 *      "sensitivity": 5,
 *      "state": "normal",
 *      "version": "0106"
 *    },
 *    "deviceId": "abcdef1234567890",
 *    "reportAt": "2022-07-22T15:23:56.808Z"
 *  }
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  const device = this.accessory.context.device;
  let rc = false;

  if (await this.checkDeviceState(platform, device) && device.data.online) {
    this.motionService
      .updateCharacteristic(platform.Characteristic.StatusLowBattery, (device.data.state.battery <= 1)
        ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
      .updateCharacteristic(platform.Characteristic.StatusActive, true)
      .updateCharacteristic(platform.Characteristic.StatusFault, false);
    platform.liteLog('Device state for ' + device.name + ' (' + device.deviceId + ') is: ' + device.data.state.state);
    rc = (device.data.state.state === 'alert');
  } else {
    platform.log.error('Device offline or other error for '+ device.name + ' (' + device.deviceId + ')');
    this.motionService
      .updateCharacteristic(platform.Characteristic.StatusActive, false)
      .updateCharacteristic(platform.Characteristic.StatusFault, true);
  }

  await releaseSemaphore();
  return (rc);
}

/***********************************************************************
 * mqttMotionDetector
 *
 * Example of message received.
 *  {
 *    "event": "MotionSensor.Report",
 *    "time": 1658507233165,
 *    "msgid": "1658507233164",
 *    "data": {
 *      "state": "normal",
 *      "battery": 4,
 *      "version": "050c",
 *      "ledAlarm": false,
 *      "alertInterval": 1,
 *      "nomotionDelay": 1,
 *      "sensitivity": 2,
 *      "devTemperature": 30,
 *      "batteryType": "Li",
 *      "loraInfo": {
 *        "signal": -88,
 *        "gatewayId": "abcdef1234567890",
 *        "gateways": 1
 *      }
 *    },
 *    "deviceId": "abcdef1234567890"
 *  }
 *===========
 *  {
 *    "event": "VibrationSensor.Alert",
 *    "time": 1658511110122,
 *    "msgid": "1658511110122",
 *    "data": {
 *      "state": "alert",
 *      "battery": 4,
 *      "alertInterval": 60,
 *      "noVibrationDelay": 1,
 *      "sensitivity": 5,
 *      "devTemperature": 22,
 *      "loraInfo": {
 *        "signal": -79,
 *        "gatewayId": "abcdef1234567890",
 *        "gateways": 1
 *       }
 *    },
 *    "deviceId": "abcdef1234567890"
 *  }
 */
export async function mqttMotionSensor(deviceClass: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = deviceClass.platform;

  // serialize access to device data.
  const releaseSemaphore = await deviceClass.deviceSemaphore.acquire();
  const device = deviceClass.accessory.context.device;
  device.updateTime = Math.floor(new Date().getTime() / 1000) + deviceClass.config.refreshAfter;
  const event = message.event.split('.');

  switch (event[1]) {
    case 'Alert':
      // falls through
    case 'Report':
      // falls through
    case 'StatusChange':
      // if we received a message then device must be online
      device.data.online = true;
      // Merge received data into existing data object
      Object.assign(device.data.state, message.data);
      deviceClass.motionService
        .updateCharacteristic(platform.Characteristic.StatusLowBattery,
          (message.data.battery <= 1)
            ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
        .updateCharacteristic(platform.Characteristic.MotionDetected,
          (message.data.state === 'alert') ? true : false )
        .updateCharacteristic(platform.Characteristic.StatusActive, true)
        .updateCharacteristic(platform.Characteristic.StatusFault, false);
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
      platform.log.warn('Unsupported mqtt event: \'' + message.event + '\'\n'
        + 'Please report at https://github.com/dkerr64/homebridge-yolink/issues\n'
        + JSON.stringify(message));
  }

  await releaseSemaphore();
}