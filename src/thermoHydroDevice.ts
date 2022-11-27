/***********************************************************************
 * YoLink temperature / humidity sensor device support
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initThermoHydroDevice
 * Initialize the temperature and humidity device services.
 */
export async function initThermoHydroDevice(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  if (String(device.config.hide).toLowerCase() === 'thermo') {
    platform.log.info(`Hide Thermometer service because config.[${device.deviceId}].hide is set to "thermo"`);
    accessory.removeService(accessory.getService(platform.Service.TemperatureSensor)!);
  } else {
    // Not trying to hide the thermometer service.
    this.thermoService = accessory.getService(platform.Service.TemperatureSensor)
                      || accessory.addService(platform.Service.TemperatureSensor);
    this.thermoService.setCharacteristic(platform.Characteristic.Name, device.name);
    this.thermoService.getCharacteristic(platform.Characteristic.CurrentTemperature)
      .onGet(handleGet.bind(this, 'thermo'));
  }

  if (String(device.config.hide).toLowerCase() === 'hydro') {
    platform.log.info(`Hide Hydrometer service because config.[${device.deviceId}].hide is set to "hydro"`);
    accessory.removeService(accessory.getService(platform.Service.HumiditySensor)!);
  } else {
    // Not trying to hide the hydrometer service.
    this.hydroService = accessory.getService(platform.Service.HumiditySensor)
                     || accessory.addService(platform.Service.HumiditySensor);
    this.hydroService.setCharacteristic(platform.Characteristic.Name, device.name);
    this.hydroService.getCharacteristic(platform.Characteristic.CurrentRelativeHumidity)
      .onGet(handleGet.bind(this, 'hydro'));
  }
  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  this.refreshDataTimer(handleGet.bind(this, 'both'));
}

/***********************************************************************
 * handleGet
 *
 * This is an example of JSON object returned.
 * The only alarm state we can act on is the low battery, HomeKit does not
 * have alarm/alert state for high/low temperature or humidity, that would
 * be handled internally within HomeKit based on data returned.
 *
 *  {
 *    "online": true,
 *    "state": {
 *      "alarm": {
 *        "lowBattery": false,
 *        "lowTemp": false,
 *        "highTemp": false,
 *        "lowHumidity": false,
 *        "highHumidity": false,
 *        "period": false,
 *        "code": 0
 *      },
 *      "battery": 4,
 *      "batteryType": "Li",
 *      "humidity": 47.2,
 *      "humidityCorrection": 0,
 *      "humidityLimit": {
 *        "max": 50,
 *        "min": 0
 *      },
 *      "interval": 10,
 *      "mode": "f",
 *      "state": "normal",
 *      "tempCorrection": 0,
 *      "tempLimit": {
 *        "max": 35,
 *        "min": 18
 *      },
 *      "temperature": 25.4,
 *      "version": "0508"
 *    },
 *    "deviceId": "abcdef1234567890",
 *    "reportAt": "2022-07-22T15:32:15.899Z"
 *  }
 */
async function handleGet(this: YoLinkPlatformAccessory, sensor = 'thermo'): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  let rc = NaN;
  try {
    if (await this.checkDeviceState(platform, device) && device.data.online) {
      this.logDeviceState(device, `Temperature ${device.data.state.temperature}\u00B0C ` +
                          `(${(device.data.state.temperature*9/5+32).toFixed(1)}\u00B0F), Humidity ${device.data.state.humidity}, ` +
                          `Battery: ${device.data.state.battery} (Requested: ${sensor})`);
      if (this.thermoService) {
        this.thermoService
          .updateCharacteristic(platform.Characteristic.StatusActive, true)
          .updateCharacteristic(platform.Characteristic.StatusFault, false);
      }
      if (this.hydroService) {
        this.hydroService
          .updateCharacteristic(platform.Characteristic.StatusActive, true)
          .updateCharacteristic(platform.Characteristic.StatusFault, false);
      }
      if (device.data.state.alarm.lowBattery) {
        platform.log.warn(`Device ${device.deviceMsgName} reports low battery`);
      }
      rc = (sensor === 'hydro') ? device.data.state.humidity : device.data.state.temperature;
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
      if (this.thermoService) {
        this.thermoService
          .updateCharacteristic(platform.Characteristic.StatusActive, false)
          .updateCharacteristic(platform.Characteristic.StatusFault, true);
      }
      if (this.hydroService) {
        this.hydroService
          .updateCharacteristic(platform.Characteristic.StatusActive, false)
          .updateCharacteristic(platform.Characteristic.StatusFault, true);
      }
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in ThermoHydroDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return (rc);
}

/***********************************************************************
 * mqttThermoHydroDevice
 * Handle message received from MQTT server.
 *
 * This is an example of JSON object returned.
 * The only alarm state we can act on is the low battery, HomeKit does not
 * have alarm/alert state for high/low temperature or humidity, that would
 * be handled internally within HomeKit based on data returned.
 *  {
 *    "event": "THSensor.Report",
 *    "time": 1658507535922,
 *    "msgid": "1658507535922",
 *    "data": {
 *      "state": "normal",
 *      "alarm": {
 *        "lowBattery": false,
 *        "lowTemp": false,
 *        "highTemp": false,
 *        "lowHumidity": false,
 *        "highHumidity": false,
 *        "period": false,
 *        "code": 0
 *      },
 *      "battery": 4,
 *      "mode": "f",
 *      "interval": 10,
 *      "temperature": 25.5,
 *      "humidity": 48.1,
 *      "tempLimit": {
 *        "max": 35,
 *        "min": 18
 *      },
 *      "humidityLimit": {
 *        "max": 50,
 *        "min": 0
 *      },
 *      "tempCorrection": 0,
 *      "humidityCorrection": 0,
 *      "version": "0508",
 *      "batteryType": "Li",
 *      "loraInfo": {
 *        "signal": -64,
 *        "gatewayId": "abcdef1234567890",
 *        "gateways": 1
 *      }
 *    },
 *    "deviceId": "abcdef1234567890"
 *  }
 *
 * The newer X3 sensor also sends a DataRecord which we will quietly ignore
 * {
 *   "event": "THSensor.DataRecord",
 *   "time": 1665651601414,
 *   "msgid": "1665651601414",
 *   "data": {
 *     "records": [{
 *       "temperature": 29.2,
 *       "humidity": 63.9,
 *       "time": "2022-10-13T08:50:01.000Z"
 *     }]
 *   },
 *   "deviceId": "abcdef1234567890"
 * }
 */
export async function mqttThermoHydroDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const event = message.event.split('.');
    const batteryMsg = (device.hasBattery && message.data.battery) ? `, Battery: ${message.data.battery}`: '';
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
        this.logDeviceState(device, `Temperature ${device.data.state.temperature}\u00B0C ` +
                                              `(${(device.data.state.temperature*9/5+32).toFixed(1)}\u00B0F), `+
                                    `Humidity ${device.data.state.humidity}${alertMsg}${batteryMsg} (MQTT: ${message.event})`);
        if (this.thermoService) {
          this.thermoService.updateCharacteristic(platform.Characteristic.CurrentTemperature, message.data.temperature);
        }
        if (this.hydroService) {
          this.hydroService.updateCharacteristic(platform.Characteristic.CurrentRelativeHumidity, message.data.humidity);
        }
        if (device.data.state.alarm.lowBattery) {
          platform.log.warn(`Device ${device.deviceMsgName} reports low battery`);
        }
        break;
      case 'DataRecord':
        // No equivalent for this in HomeKit
        platform.liteLog(mqttMessage + ' ' + JSON.stringify(message));
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttThermoHydroDevice' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}