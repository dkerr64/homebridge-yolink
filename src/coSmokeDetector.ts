/***********************************************************************
 * YoLink CO Smoke Detector device support
 *
 * This will issue warning messages to the HomeBridge log that can then
 * be provided to author to assist in adding device support.
 *
 * Copyright (c) 2023 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initUnknownDevice
 *
 */
export async function initCoSmokeDetector(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = this.accessory.context.device;

  if (String(device.config.hide).toLowerCase() === 'co') {
    platform.log.info(`[${device.deviceMsgName}] Hide Carbon Monoxide service because config.[${device.deviceId}].hide is set to "co"`);
    accessory.removeService(accessory.getService(platform.Service.CarbonMonoxideSensor)!);
  } else {
    // Not trying to hide the carbon monoxide service.
    this.coService = accessory.getService(platform.Service.CarbonMonoxideSensor)
      || accessory.addService(platform.Service.CarbonMonoxideSensor);
    this.coService.setCharacteristic(platform.Characteristic.Name, device.name + ' CO');
  }

  if (String(device.config.hide).toLowerCase() === 'smoke') {
    platform.log.info(`[${device.deviceMsgName}] Hide Smoke service because config.[${device.deviceId}].hide is set to "smoke"`);
    accessory.removeService(accessory.getService(platform.Service.SmokeSensor)!);
  } else {
    // Not trying to hide the smoke service.
    this.smokeService = accessory.getService(platform.Service.SmokeSensor)
      || accessory.addService(platform.Service.SmokeSensor);
    this.smokeService.setCharacteristic(platform.Characteristic.Name, device.name + ' Smoke');
  }

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
  await this.refreshDataTimer(handleGetBlocking.bind(this, 'both'));

  // Once we have initial data, setup all the Homebridge handlers
  this.coService?.getCharacteristic(platform.Characteristic.CarbonMonoxideDetected)
    .onGet(handleGet.bind(this, 'co'));
  this.smokeService?.getCharacteristic(platform.Characteristic.SmokeDetected)
    .onGet(handleGet.bind(this, 'smoke'));
  this.thermoService?.getCharacteristic(platform.Characteristic.CurrentTemperature)
    .onGet(handleGet.bind(this, 'thermo'));

  platform.log.warn(`YoLink device type: '${device.type}' is not supported (${device.deviceMsgName}) (initialize)`
    + platform.reportError + JSON.stringify(device, null, 2));

  this.refreshDataTimer(handleGet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * This is an example of JSON object returned.
 *
 * {
 *   "online": true,
 *   "state": {
 *       "battery": 4,
 *       "devTemperature": 22,
 *       "interval": 120,
 *       "metadata": {
 *           "inspect": true
 *       },
 *       "sche": {
 *           "type": "disable",
 *           "day": 0,
 *           "time": "0:0"
 *       },
 *       "state": {
 *           "unexpected": false,
 *           "sLowBattery": false,
 *           "smokeAlarm": false,
 *           "gasAlarm": false,
 *           "highTempAlarm": false,
 *           "silence": false
 *       },
 *       "stateChangedAt": {
 *           "gasAlarm": 1701962206458,
 *           "smokeAlarm": 1701962206458,
 *           "unexpected": 1702128701737
 *       },
 *       "tz": 0,
 *       "version": "0202",
 *       "lastInspection": {
 *           "time": 1702128770316
 *       }
 *   },
 *   "deviceId": "abcdef0123456789",
 *   "reportAt": "2023-12-09T13:32:50.317Z"
 * }
 */
async function handleGet(this: YoLinkPlatformAccessory, sensor = 'smoke'): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  handleGetBlocking.bind(this, sensor)()
    .then((v) => {
      if (sensor === 'co') {
        this.coService.updateCharacteristic(platform.Characteristic.CarbonMonoxideDetected, v);
      } else if (sensor === 'thermo') {
        this.thermoService.updateCharacteristic(platform.Characteristic.CurrentTemperature, v);
      } else {
        this.smokeService.updateCharacteristic(platform.Characteristic.SmokeDetected, v);
      }
    });
  // Return current state of the device pending completion of the blocking function
  return ((sensor === 'co')
    ? (device.data?.state?.state.gasAlarm ? 1 : 0)
    : (sensor === 'thermo')
      ? (device.data?.state?.devTemperature ?? -270)
      : (device.data?.state?.state.smokeAlarm ? 1 : 0));
}

async function handleGetBlocking(this: YoLinkPlatformAccessory, sensor = 'smoke'): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  // default to normal lebels of CO or Smoke.
  let rc = (sensor === 'thermo') ? -270 : false;
  try {
    if (await this.checkDeviceState(platform, device) && device.data.online) {
      this.logDeviceState(device, `Smoke: ${device.data.state.state.smokeAlarm}, CO" ${device.data.state.state.gasAlarm}, ` +
        `Battery: ${device.data.state.battery} (Requested: ${sensor})`);
      this.coService?.updateCharacteristic(platform.Characteristic.StatusActive, true);
      this.coService?.updateCharacteristic(platform.Characteristic.StatusFault, false);
      this.smokeService?.updateCharacteristic(platform.Characteristic.StatusActive, true);
      this.smokeService?.updateCharacteristic(platform.Characteristic.StatusFault, false);
      this.thermoService?.updateCharacteristic(platform.Characteristic.StatusActive, true);
      this.thermoService?.updateCharacteristic(platform.Characteristic.StatusFault, false);
      if (device.data.state.state.sLowBattery) {
        platform.log.warn(`Device ${device.deviceMsgName} reports low battery`);
      }
      switch (sensor) {
        case 'thermo':
          rc = device.data.state.devTemperature;
          break;
        case 'co':
          rc = device.data.state.state.gasAlarm ? 1 : 0;
          break;
        default:
          rc = device.data.state.state.smokeAlarm ? 1 : 0;
          break;
      }
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
      this.coService?.updateCharacteristic(platform.Characteristic.StatusActive, false);
      this.coService?.updateCharacteristic(platform.Characteristic.StatusFault, true);
      this.smokeService?.updateCharacteristic(platform.Characteristic.StatusActive, false);
      this.smokeService?.updateCharacteristic(platform.Characteristic.StatusFault, true);
      this.thermoService?.updateCharacteristic(platform.Characteristic.StatusActive, false);
      this.thermoService?.updateCharacteristic(platform.Characteristic.StatusFault, true);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in ThermoHydroDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  // for both smoke and CO we return integer 1 or 0 for true/false.
  return (rc);
}

/***********************************************************************
 * mqttCoSmokeDetector
 * Handle message received from MQTT server.
 *
 * This is an example of JSON object returned.
 */
export async function mqttCoSmokeDetector(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {

    platform.log.warn(`YoLink device type: '${device.type}' is under development (${device.deviceMsgName}) (MQTT)`
      + platform.reportError + JSON.stringify(message, null, 2));

    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const event = message.event.split('.');
    const batteryMsg = (device.hasBattery && message.data.battery) ? `, Battery: ${message.data.battery}` : '';
    const alertMsg = (message.data.alertType) ? `, Alert: ${message.data.alertType}` : '';

    switch (event[1]) {
      case 'Alert':
      // I can see no way in HomeKit documentation for a thermo/hydro sensor
      // to generate an alert.  I think bounds testing / alerting all has to be
      // handled within HomeKit.
      // falls through
      case 'Report':
        if (!device.data) {
          // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
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
        this.logDeviceState(device, `Smoke: ${device.data.state.state.smokeAlarm}, CO" ${device.data.state.state.gasAlarm}, ` +
          `${alertMsg}${batteryMsg} (MQTT: ${message.event})`);
        this.coService?.updateCharacteristic(platform.Characteristic.CarbonMonoxideDetected, message.data.state.gasAlarm ? 1 : 0);
        this.smokeService?.updateCharacteristic(platform.Characteristic.SmokeDetected, message.data.state.smokeAlarm ? 1 : 0);
        if (device.data.state.sLowBattery) {
          platform.log.warn(`Device ${device.deviceMsgName} reports low battery`);
        }
        break;
      case 'DataRecord':
        // No equivalent for this in HomeKit
        platform.liteLog(mqttMessage + ' ' + JSON.stringify(message, null, 2));
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message, null, 2));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttCoSmokeDetector' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}