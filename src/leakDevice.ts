/***********************************************************************
 * YoLink leak sensor device support
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initLeakSensor
 * Initialise the leak sensor device services
 */
export async function initLeakSensor(deviceClass: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = deviceClass.platform;
  const accessory: PlatformAccessory = deviceClass.accessory;
  const device = accessory.context.device;

  deviceClass.leakService = accessory.getService(platform.Service.LeakSensor) || accessory.addService(platform.Service.LeakSensor);
  deviceClass.leakService.setCharacteristic(platform.Characteristic.Name, device.name);
  deviceClass.leakService.getCharacteristic(platform.Characteristic.LeakDetected)
    .onGet(handleGet.bind(deviceClass));
  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  deviceClass.refreshDataTimer(handleGet.bind(deviceClass));
}

/***********************************************************************
 * handleGet
 *
 * This is an example of JSON object returned.
 *  {
 *    "online": true,
 *    "state": {
 *      "battery": 4,
 *      "devTemperature": 25,
 *      "interval": 20,
 *      "state": "normal",
 *      "version": "030d",
 *      "sensorMode": "WaterLeak",
 *      "supportChangeMode": false,
 *      "stateChangedAt": 1656502562174
 *    },
 *    "deviceId": "abcdef1234567890",
 *    "reportAt": "2022-07-22T15:37:08.126Z"
 *  }
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  const device = this.accessory.context.device;
  let rc = platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED;

  if (await this.checkDeviceState(platform, device) && device.data.online) {
    this.leakService
      .updateCharacteristic(platform.Characteristic.StatusLowBattery, (device.data.state.battery <= 1)
        ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
      .updateCharacteristic(platform.Characteristic.StatusActive, true)
      .updateCharacteristic(platform.Characteristic.StatusFault, false);
    platform.liteLog('Device state for ' + device.name + ' (' + device.deviceId + ') is: ' + device.data.state.state);
    if (device.data.state.state === 'alert') {
      rc = platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED;
    }
  } else {
    platform.log.error('Device offline or other error for '+ device.name + ' (' + device.deviceId + ')');
    this.leakService
      .updateCharacteristic(platform.Characteristic.StatusActive, false)
      .updateCharacteristic(platform.Characteristic.StatusFault, true);
  }

  await releaseSemaphore();
  return (rc);
}

/***********************************************************************
 * mqttLeakSensor
 *
 *  {
 *    "event": "LeakSensor.Report",
 *    "time": 1658507785659,
 *    "msgid": "1658507785658",
 *    "data": {
 *      "sensorMode": "WaterLeak",
 *      "supportChangeMode": false,
 *      "state": "normal",
 *      "battery": 3,
 *      "interval": 20,
 *      "version": "030d",
 *      "devTemperature": 27,
 *      "loraInfo": {
 *        "signal": -77,
 *        "gatewayId": "abcdef1234567890",
 *        "gateways": 1
 *      },
 *      "stateChangedAt": 1656491747469
 *    },
 *    "deviceId": "abcdef1234567890"
 *  }
 */
export async function mqttLeakSensor(deviceClass: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = deviceClass.platform;

  // serialize access to device data.
  const releaseSemaphore = await deviceClass.deviceSemaphore.acquire();
  const device = deviceClass.accessory.context.device;
  device.updateTime = Math.floor(new Date().getTime() / 1000) + deviceClass.config.refreshAfter;
  const event = message.event.split('.');

  switch (event[1]) {
    case 'Alert':
      // falls through
    case 'StatusChange':
      // falls through
    case 'Report':
      // if we received a message then device must be online
      device.data.online = true;
      // Merge received data into existing data object
      Object.assign(device.data.state, message.data);
      deviceClass.leakService
        .updateCharacteristic(platform.Characteristic.StatusLowBattery,
          (message.data.battery <= 1)
            ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
        .updateCharacteristic(platform.Characteristic.LeakDetected,
          (message.data.state === 'alert')
            ? platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED
            : platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED)
        .updateCharacteristic(platform.Characteristic.StatusActive, true)
        .updateCharacteristic(platform.Characteristic.StatusFault, false);
      break;
    default:
      platform.log.warn('Unsupported mqtt event: \'' + message.event + '\'\n'
        + 'Please report at https://github.com/dkerr64/homebridge-yolink/issues\n'
        + JSON.stringify(message));
  }

  await releaseSemaphore();
}