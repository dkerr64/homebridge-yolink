/***********************************************************************
 * YoLink temperature / humidity sensor device support
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

Error.stackTraceLimit = 100;

/***********************************************************************
 * initThermoHydroDevice
 * Initialise the temperature and humidity device services.
 */
export async function initThermoHydroDevice(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device = accessory.context.device;

  if (this.config.hide === 'thermo') {
    platform.log.info(`Hide Thermometer service because config.[${device.deviceId}].hide is set to "thermo"`);
  } else {
    // Not trying to hide the thermometer service.
    this.thermoService = accessory.getService(platform.Service.TemperatureSensor)
                      || accessory.addService(platform.Service.TemperatureSensor);
    this.thermoService.setCharacteristic(platform.Characteristic.Name, device.name);
    this.thermoService.getCharacteristic(platform.Characteristic.CurrentTemperature)
      .onGet(handleThermoGet.bind(this));
    // Call get handler to initialize data fields to current state and set
    // timer to regularly update the data.
    this.refreshDataTimer(handleThermoGet.bind(this));
  }

  if (this.config.hide === 'hydro') {
    platform.log.info(`Hide Hydrometer service because config.[${device.deviceId}].hide is set to "hydro"`);
  } else {
    // Not trying to hide the hydrometer service.
    this.hydroService = accessory.getService(platform.Service.HumiditySensor)
                     || accessory.addService(platform.Service.HumiditySensor);
    this.hydroService.setCharacteristic(platform.Characteristic.Name, device.name);
    this.hydroService.getCharacteristic(platform.Characteristic.CurrentRelativeHumidity)
      .onGet(handleHydroGet.bind(this));
    // Call get handler to initialize data fields to current state and set
    // timer to regularly update the data.
    this.refreshDataTimer(handleHydroGet.bind(this));
  }
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
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  let rc = 0;
  try {
    const device = this.accessory.context.device;
    if (await this.checkDeviceState(platform, device) && device.data.online) {
      this.updateBatteryInfo.bind(this)();
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
        platform.log.warn(`Device ${this.deviceMsgName} reports low battery`);
      }
      rc = device.data.state.temperature;
    } else {
      platform.log.error(`Device offline or other error for ${this.deviceMsgName}`);
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
    await releaseSemaphore();
  }
  return (rc);
}

/***********************************************************************
 * handleThermoGet
 * Call handleGet and return the temperature.
 */
async function handleThermoGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  await handleGet.bind(this)();
  const device = this.accessory.context.device;
  this.logDeviceState(new Date(device.data.reportAt),
    `Temperature ${device.data.state.temperature}, Battery: ${device.data.state.battery}`);
  return (device.data.state.temperature);
}

/***********************************************************************
 * handleHydroGet
 * Call handleGet and return the humidity.
 */
async function handleHydroGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  await handleGet.bind(this)();
  const device = this.accessory.context.device;
  this.logDeviceState(new Date(device.data.reportAt),
    `Humidity ${device.data.state.humidity}, Battery: ${device.data.state.battery}`);
  return (device.data.state.humidity);
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
 */
export async function mqttThermoHydroDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
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
        // I can see no way in HomeKit documentation for a thermo/hyrdro sensor
        // to generate an alert.  I think bounds testing / alerting all has to be
        // handled within HomeKit.
        // falls through
      case 'Report':
        if (!device.data) {
          // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${this.deviceMsgName} has no data field, is device offline?`);
          break;
        }
        // if we received a message then device must be online
        device.data.online = true;
        // Merge received data into existing data object
        Object.assign(device.data.state, message.data);
        platform.log.info(`${mqttMessage} Temperature: ${message.data.temperature}, Humidity: ${message.data.humidity}`);
        this.updateBatteryInfo.bind(this)();
        if (this.thermoService) {
          this.thermoService.updateCharacteristic(platform.Characteristic.CurrentTemperature, message.data.temperature);
        }
        if (this.hydroService) {
          this.hydroService.updateCharacteristic(platform.Characteristic.CurrentRelativeHumidity, message.data.humidity);
        }
        if (device.data.state.alarm.lowBattery) {
          platform.log.warn(`Device ${this.deviceMsgName} reports low battery`);
        }
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttThermoHydroDevice' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}