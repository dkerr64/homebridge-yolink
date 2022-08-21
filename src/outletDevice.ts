/***********************************************************************
 * YoLink outlet device support
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initOutletDevice
 *
 */
export async function initOutletDevice(this: YoLinkPlatformAccessory, onState: string, setOn: string, setOff:string): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device = accessory.context.device;

  this.onState = onState;
  this.setOn = setOn;
  this.setOff = setOff;

  this.outletService = accessory.getService(platform.Service.Outlet) || accessory.addService(platform.Service.Outlet);
  this.outletService.setCharacteristic(platform.Characteristic.Name, device.name);
  this.outletService.getCharacteristic(platform.Characteristic.On)
    .onGet(handleGet.bind(this))
    .onSet(handleSet.bind(this));
  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  this.refreshDataTimer(handleGet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * Example of message received.
 *
 * {
 *   "state":"open",
 *   "delay":{
 *     "ch":1,
 *     "on":0,
 *     "off":0
 *   },
 *   "power":0,
 *   "watt":0,
 *   "version":"040c",
 *   "time":"2022-08-19T13:41:00.000Z",
 *   "tz":-4,
 *   "loraInfo":{
 *     "signal":-64,
 *     "gatewayId":"abcdef1234567890",
 *     "gateways":1
 *   }
 * }
 *
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  let rc = false;
  try {
    const device = this.accessory.context.device;
    if( await this.checkDeviceState(platform, device) ) {
      this.logDeviceState(`Outlet: ${device.data.state}`);
      if (device.data.state === this.onState) {
        rc = true;
      }
    } else {
      platform.log.error(`Device offline or other error for ${this.deviceMsgName}`);
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in OutletDevice handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
  return (rc);
}

/***********************************************************************
 * handleSet
 *
 * This is an example of JSON object returned.
 *
 * {
 *   "state":"open",
 *   "loraInfo":{
 *     "signal":-65,
 *     "gatewayId":"abcdef1234567890",
 *     "gateways":1
 *   }
 * }
 *
 */
async function handleSet(this: YoLinkPlatformAccessory, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  try {
    const device = this.accessory.context.device;
    const newState = (value === true) ? this.setOn : this.setOff;
    const data = (await platform.yolinkAPI.setDeviceState(platform, device, {'state':newState}))?.data;
    device.data.state = (data) ? data.state : false;
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in OutletDevice handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}

/***********************************************************************
 * mqttOutletDevice
 *
 * Examples of message received.
 *
 * {
 *   "event":"Outlet.Report",
 *   "time":1660957701877,
 *   "msgid":"1660957701876",
 *   "data":{
 *     "state":"closed",
 *     "delay":{
 *       "ch":1,
 *       "on":0,
 *       "off":0
 *     },
 *     "power":0,
 *     "watt":0,
 *     "version":"040c",
 *     "time":"2022-08-19T13:08:21.000Z",
 *     "tz":-4,
 *     "alertType":{
 *       "overload":false,
 *       "lowLoad":false,
 *       "remind":false
 *     },
 *     "loraInfo":{
 *       "signal":-52,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * ============================
 * {
 *   "event":"Outlet.StatusChange",
 *   "time":1660959181109,
 *   "msgid":"1660959181108",
 *   "data":{
 *     "state":"open",
 *     "alertType":{
 *       "overload":false,
 *       "lowLoad":false,
 *       "remind":false
 *     },
 *     "loraInfo":{
 *       "signal":-59,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * ============================
 * {
 *   "event":"Outlet.setSchedules",
 *   "time":1660958939611,
 *   "msgid":"1660958939611",
 *   "data":{
 *     "0":{
 *       "isValid":true,
 *       "week":127,
 *       "index":0,
 *       "on":"20:0",
 *       "off":"21:0"
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 */
export async function mqttOutletDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;

  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  try {
    const device = this.accessory.context.device;
    device.updateTime = Math.floor(new Date().getTime() / 1000) + this.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${this.deviceMsgName}`;
    const event = message.event.split('.');

    switch (event[1]) {
      case 'Report':
        // falls through
      case 'getState':
        // falls through
      case 'setState':
        // falls through
      case 'StatusChange':
        if (!device.data) {
        // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${this.deviceMsgName} has no data field, is device offline?`);
          break;
        }
        // if we received a message then device must be online
        device.data.online = true;
        // Merge received data into existing data object
        Object.assign(device.data, message.data);
        this.logDeviceState(`Outlet: ${device.data.state} (MQTT: ${message.event})`);
        this.outletService
          .updateCharacteristic(platform.Characteristic.On, (message.data.state === this.onState) ? true : false);
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
      case 'powerReport':
        // nothing to update in HomeKit
        this.logDeviceState(`Unsupported message (MQTT: ${message.event})`);
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttOutletDevice' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}