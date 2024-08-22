/***********************************************************************
 * YoLink motion and vibration sensor device support.
 *
 * Copyright (c) 2022-2023 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initMotionSensor
 *
 */
export async function initMotionSensor(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  this.motionService = accessory.getService(platform.Service.MotionSensor)
    || accessory.addService(platform.Service.MotionSensor);
  this.motionService.setCharacteristic(platform.Characteristic.Name, device.name);

  if (device.config.temperature) {
    // If requested add a service for the internal device temperature.
    this.thermoService = accessory.getService(platform.Service.TemperatureSensor)
      || accessory.addService(platform.Service.TemperatureSensor);
    this.thermoService.setCharacteristic(platform.Characteristic.Name, device.name + ' Temperature');
  } else {
    // If not requested then remove it if it already exists.
    accessory.removeService(accessory.getService(platform.Service.TemperatureSensor)!);
  }

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGetBlocking.bind(this));

  // Once we have initial data, setup all the Homebridge handlers
  this.motionService.getCharacteristic(platform.Characteristic.MotionDetected)
    .onGet(handleGet.bind(this));
  this.thermoService?.getCharacteristic(platform.Characteristic.CurrentTemperature)
    .onGet(handleGet.bind(this, 'thermo'));

}

/***********************************************************************
 * handleGet
 *
 * This is an example of JSON object returned.  Two examples here, one
 * from a motion sensor, 2nd one from a vibration sensor.  Parameters
 * we care about are the same across both.
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
async function handleGet(this: YoLinkPlatformAccessory, devSensor = 'main'): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  handleGetBlocking.bind(this, devSensor)()
    .then((v) => {
      if (devSensor === 'thermo') {
        this.thermoService.updateCharacteristic(platform.Characteristic.CurrentTemperature, v);
      } else {
        this.motionService.updateCharacteristic(platform.Characteristic.MotionDetected, v);
      }
    });
  // Return current state of the device pending completion of the blocking function
  return ((devSensor === 'thermo')
    ? (device.data?.state?.devTemperature ?? -270)
    : ((device.data?.state?.state === 'alert') ?? false));
}

async function handleGetBlocking(this: YoLinkPlatformAccessory, devSensor = 'main'): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  // 'main' or 'thermo' use -270 as the minimum accepted value for default
  let rc = (devSensor === 'main') ? false : -270;
  try {
    if (await this.checkDeviceState(platform, device) && device.data.online) {
      this.motionService
        .updateCharacteristic(platform.Characteristic.StatusActive, true)
        .updateCharacteristic(platform.Characteristic.StatusFault, false);
      switch (devSensor) {
        case 'thermo':
          rc = device.data.state.devTemperature;
          break;
        default:
          rc = device.data.state.state === 'alert';
      }
      this.logDeviceState(device, `Motion: ${device.data.state.state}, Battery: ${device.data.state.battery}, ` +
        `DevTemp: ${device.data.state.devTemperature}\u00B0C ` +
        `(${(device.data.state.devTemperature * 9 / 5 + 32).toFixed(1)}\u00B0F)`);
    } else {
      platform.log.error(`[${device.deviceMsgName}] Device offline or other error`);
      device.errorState = true;
      this.motionService
        .updateCharacteristic(platform.Characteristic.StatusActive, false)
        .updateCharacteristic(platform.Characteristic.StatusFault, true);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in MotionDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return (rc);
}

/***********************************************************************
 * mqttMotionSensor
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
export async function mqttMotionSensor(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const event = message.event.split('.');
    const batteryMsg = (device.hasBattery && message.data.battery) ? `, Battery: ${message.data.battery}` : '';
    const alertMsg = (message.data.alertType) ? `, Alert: ${message.data.alertType}` : '';
    const devTempMsg = (message.data.devTemperature) ? `, DevTemp: ${message.data.devTemperature}\u00B0C ` +
      `(${(message.data.devTemperature * 9 / 5 + 32).toFixed(1)}\u00B0F)` : '';

    switch (event[1]) {
      case 'Alert':
      // falls through
      case 'Report':
      // falls through
      case 'StatusChange':
        if (!device.data) {
          // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          this.motionService
            .updateCharacteristic(platform.Characteristic.StatusActive, false)
            .updateCharacteristic(platform.Characteristic.StatusFault, true);
          break;
        }
        // if we received a message then device must be online
        device.data.online = true;
        // Merge received data into existing data object
        Object.assign(device.data.state, message.data);
        if (!message.data.reportAt) {
          // mqtt data does not include a report time, so merging the objects leaves current
          // unchanged, update the time string.
          device.data.reportAt = device.reportAtTime.toISOString();
        }
        this.logDeviceState(device, `Motion: ${device.data.state.state}${alertMsg}${batteryMsg}${devTempMsg} (MQTT: ${message.event})`);
        this.motionService
          .updateCharacteristic(platform.Characteristic.MotionDetected,
            (message.data.state === 'alert') ? true : false)
          .updateCharacteristic(platform.Characteristic.StatusActive, true)
          .updateCharacteristic(platform.Characteristic.StatusFault, false);
        this.thermoService?.updateCharacteristic(platform.Characteristic.CurrentTemperature, message.data.devTemperature);
        break;
      case 'setOpenRemind':
        // This does not carry either motion state or battery
        // state fields, so there is nothing we can update.  Sample packet...
        // {"event":"MotionSensor.setOpenRemind","time":1658089933504,"msgid":"1658089933504",
        // "data":{"alertInterval":1,"ledAlarm":false,"nomotionDelay":1,"sensitivity":2,
        // "loraInfo":{"signal":-87,"gatewayId":"<redacted>","gateways":1}},"deviceId":"<redacted>"}
        platform.liteLog(mqttMessage + ' ' + JSON.stringify(message));
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttMotionSensor' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}