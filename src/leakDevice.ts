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
export async function initLeakSensor(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device = accessory.context.device;

  this.leakService = accessory.getService(platform.Service.LeakSensor) || accessory.addService(platform.Service.LeakSensor);
  this.leakService.setCharacteristic(platform.Characteristic.Name, device.name);
  this.leakService.getCharacteristic(platform.Characteristic.LeakDetected)
    .onGet(handleGet.bind(this));
  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  this.refreshDataTimer(handleGet.bind(this));
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
  let rc = platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
  try {
    const device = this.accessory.context.device;
    if (await this.checkDeviceState(platform, device) && device.data.online) {
      this.leakService
        .updateCharacteristic(platform.Characteristic.StatusActive, true)
        .updateCharacteristic(platform.Characteristic.StatusFault, false);
      if (device.data.state.state === 'alert') {
        rc = platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED;
      }
      this.logDeviceState(`Leak: ${device.data.state.state}, Battery: ${device.data.state.battery}, ` +
                          `DevTemp: ${device.data.state.devTemperature}`);
    } else {
      platform.log.error(`Device offline or other error for ${this.deviceMsgName}`);
      this.leakService
        .updateCharacteristic(platform.Characteristic.StatusActive, false)
        .updateCharacteristic(platform.Characteristic.StatusFault, true);
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in LeakDevice handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
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
export async function mqttLeakSensor(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;

  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  try {
    const device = this.accessory.context.device;
    device.updateTime = Math.floor(new Date().getTime() / 1000) + this.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${this.deviceMsgName}`;
    const event = message.event.split('.');

    switch (event[1]) {
      case 'Alert':
        // falls through
      case 'StatusChange':
        // falls through
      case 'Report':
        if (!device.data) {
        // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${this.deviceMsgName} has no data field, is device offline?`);
          this.leakService.updateCharacteristic(platform.Characteristic.StatusFault, true);
          break;
        }
        // if we received a message then device must be online
        device.data.online = true;
        // Merge received data into existing data object
        Object.assign(device.data.state, message.data);
        if (!message.data.reportAt) {
          // mqtt data does not include a report time, so merging the objects leaves current
          // unchanged. As we use this to control when to log new data, update the time string.
          device.data.reportAt = this.reportAtTime.toISOString();
        }
        this.logDeviceState(`Leak: ${device.data.state.state}, Battery: ${device.data.state.battery}, ` +
                            `DevTemp: ${device.data.state.devTemperature} (MQTT: ${message.event})`);
        this.leakService
          .updateCharacteristic(platform.Characteristic.LeakDetected,
            (message.data.state === 'alert')
              ? platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED
              : platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED)
          .updateCharacteristic(platform.Characteristic.StatusActive, true)
          .updateCharacteristic(platform.Characteristic.StatusFault, false);
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttLeakSensor' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}