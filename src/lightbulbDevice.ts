/***********************************************************************
 * YoLink dimmer switch device support (as a HomeKit lightbulb)
 *
 * Copyright (c) 2022-2024 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initLightbulbDevice
 *
 */
export async function initLightbulb(this: YoLinkPlatformAccessory, onState: string, setOn: string, setOff: string): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  this.setMethod = 'setState';
  this.onState = onState;
  this.setOn = setOn;
  this.setOff = setOff;

  this.lightbulbService = accessory.getService(platform.Service.Lightbulb)
    || accessory.addService(platform.Service.Lightbulb);
  this.lightbulbService.setCharacteristic(platform.Characteristic.Name, device.name);

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGetBlocking.bind(this, 'on'));

  // Once we have initial data, setup all the Homebridge handlers
  this.lightbulbService.getCharacteristic(platform.Characteristic.On)
    .onGet(handleGet.bind(this, 'on'))
    .onSet(handleSet.bind(this, 'on'));
  this.lightbulbService.getCharacteristic(platform.Characteristic.Brightness)
    .onGet(handleGet.bind(this, 'brightness'))
    .onSet(handleSet.bind(this, 'brightness'));
}

/***********************************************************************
 * handleGet
 *
 * Example of message received,
 *
 * {
 *   "code":"000000"
 *   "time":1667520971145,
 *   "msgid":1667520971145,
 *   "method":"Dimmer.getState",
 *   "desc":"Success",
 *   "data":{
 *     "state":"open",
 *     "brightness":46,
 *     "deviceAttributes":{
 *       "gradient":{
 *         "on":2,
 *         "off":2
 *       },
 *       "led":{
 *         "status":"on",
 *         "level":"on"
 *       },
 *       "calibration":0
 *     },
 *     "delay":{
 *       "on":0,
 *       "off":0,
 *       "brightness":0
 *     },
 *     "version":"0701",
 *     "moduleVersion":"2",
 *     "time":"2022-11-03T16:16:10.000Z",
 *     "tz":0,
 *     "loraInfo":{
 *       "signal":-78,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   }
 * }
 */
async function handleGet(this: YoLinkPlatformAccessory, mode = 'on'): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  handleGetBlocking.bind(this, mode)()
    .then((v) => {
      if (mode === 'brightness') {
        this.lightbulbService.updateCharacteristic(platform.Characteristic.Brightness, v);
      } else {
        this.lightbulbService.updateCharacteristic(platform.Characteristic.On, v);
      }
    });
  // Return current state of the device pending completion of the blocking function
  return ((mode === 'brightness')
    ? this.accessory.context.device.data.brightness
    : (this.accessory.context.device.data.state === this.onState));
}

async function handleGetBlocking(this: YoLinkPlatformAccessory, mode = 'on'): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    if (await this.checkDeviceState(platform, device)) {
      this.logDeviceState(device, `Lightbulb: ${device.data.state}, Brightness: ${device.data.brightness}`);
      if (mode === 'brightness') {
        return (device.data.brightness);
      } else {
        return (device.data.state === this.onState);
      }
    } else {
      platform.log.error(`[${device.deviceMsgName}] Device offline or other error`);
      device.errorState = true;
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in LightbulbDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return (false);
}

/***********************************************************************
 * handleSet
 *
 * This is an example of JSON object returned.
 *
 * {
 *   "code":"000000",
 *   "time":1667522883879,
 *   "msgid":1667522883879,
 *   "method":"Dimmer.setState",
 *   "desc":"Success",
 *   "data":{
 *     "state":"closed",
 *     "brightness":0,
 *     "loraInfo":{
 *       "signal":-78,
 *       "gatewayId":"d88b4c1603008c02",
 *       "gateways":1
 *     }
 *   }
 * }
 */
async function handleSet(this: YoLinkPlatformAccessory, mode = 'on', value: CharacteristicValue): Promise<void> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  handleSetBlocking.bind(this, mode)(value);
}

async function handleSetBlocking(this: YoLinkPlatformAccessory, mode = 'on', value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    let newState = this.setOn;
    let newBrightness = 100;
    /* eslint-disable no-constant-binary-expression */
    if (mode === 'brightness') {
      newBrightness = Number(value) ?? newBrightness;
      newState = (newBrightness === 0) ? this.setOff : this.setOn;
    } else {
      newState = (value === true) ? this.setOn : this.setOff;
      newBrightness = Number(device.data.brightness) ?? newBrightness;
    }
    /* eslint-enable no-constant-binary-expression */
    const data = (await platform.yolinkAPI.setDeviceState(platform,
      device,
      { 'state': newState, 'brightness': newBrightness },
      this.setMethod))?.data;
    if (data) {
      device.data.state = data.state;
      device.data.brightness = data.brightness;
    }
    // Calling updateCharacteristic within set handler seems to fail, new value is not accepted.  Workaround is
    // to request the update after short delay (say 50ms) to allow homebridge/homekit to complete the set handler.
    setTimeout(() => {
      this.lightbulbService
        .updateCharacteristic(platform.Characteristic.On, device.data.state === this.onState)
        .updateCharacteristic(platform.Characteristic.Brightness, device.data.brightness);
    }, 50);
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in LightbulbDevice handleSet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}

/***********************************************************************
 * mqttLightbulb
 *
 * Example of message received,
 * {
 *   "method": "getState",
 *   "time": 1667519965104,
 *   "msgid": "1667519965103",
 *   "data": {
 *     "state": "closed",
 *     "brightness": 100,
 *     "deviceAttributes": {
 *       "gradient": {
 *         "on": 2,
 *         "off": 2
 *       },
 *       "led": {
 *         "status": "on",
 *         "level": "on"
 *       },
 *       "calibration": 0
 *     },
 *     "delay": {
 *       "on": 0,
 *        "off": 0,
 *        "brightness": 0
 *     },
 *     "version": "0701",
 *     "moduleVersion": "2",
 *     "time": "2022-11-03T15:59:24.000Z",
 *     "tz": 0,
 *     "loraInfo": {
 *       "signal": -77,
 *       "gatewayId": "abcdef1234567890",
 *       "gateways": 1
 *     }
 *   },
 *   "deviceId": "abcdef1234567890"
 * }
 *
 * And also...
 * {
 *   "method": "setState",
 *   "time": 1667520684479,
 *   "msgid": "1667520684478",
 *   "data": {
 *     "state": "open",
 *     "brightness": 100,
 *     "loraInfo": {
 *       "signal": -79,
 *       "gatewayId": "abcdef1234567890",
 *       "gateways": 1
 *     }
 *   },
 *   "deviceId": "abcdef1234567890"
 * }
 */
export async function mqttLightbulb(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.method} for device ${device.deviceMsgName}`;
    const batteryMsg = (device.hasBattery) ? `, Battery: ${message.data.battery}` : '';

    switch (message.method) {
      case 'Report':
      // falls through
      case 'getState':
      // falls through
      case 'setState':
      // falls through
      case 'StatusChange':
        if (!device.data) {
          // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          break;
        }
        // Merge received data into existing data object
        Object.assign(device.data, message.data);
        this.logDeviceState(device, `Lightbulb: ${device.data.state}, ` +
          `Brightness: ${device.data.brightness}${batteryMsg} (MQTT: ${message.method})`);
        this.lightbulbService
          .updateCharacteristic(platform.Characteristic.On,
            (message.data.state === this.onState) ? true : false);
        this.lightbulbService
          .updateCharacteristic(platform.Characteristic.Brightness, message.data.brightness);
        break;
      case 'setDelay':
      // falls through
      case 'getSchedules':
      // falls through
      case 'setSchedules':
      // falls through
      case 'setInitState':
      // falls through
      case 'setTimeZone':
      // falls through
      case 'setDeviceAttributes':
        // nothing to update in HomeKit
        this.logDeviceState(device, `Unsupported message (MQTT: ${message.method})`);
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttLightbulbDevice' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}