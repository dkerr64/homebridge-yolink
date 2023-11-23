/***********************************************************************
 * YoLink outlet and multi-outlet device support
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initOutletDevice
 *
 */
export async function initOutletDevice(this: YoLinkPlatformAccessory, onState: string, setOn: string, setOff: string): Promise<void> {

  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  this.nOutlets = 1;
  this.onState = onState;
  this.setOn = setOn;
  this.setOff = setOff;
  this.outlet = [];

  if (device.type === 'MultiOutlet') {
    // if number of outlets set in config file then use that
    this.nOutlets = device.config.nOutlets ?? (await handleGetBlocking.bind(this)(-1));
    platform.log.info(`Device ${device.deviceMsgName} has ${this.nOutlets} outlets`);
  }

  if (this.nOutlets === 1) {
    this.outlet.push({});
    this.outlet[0].service = accessory.getService(platform.Service.Outlet)
      || accessory.addService(platform.Service.Outlet);
    this.outlet[0].service
      .setCharacteristic(platform.Characteristic.Name, device.name);
    this.outlet[0].service
      .getCharacteristic(platform.Characteristic.On)
      .onGet(handleGet.bind(this, 0))
      .onSet(handleSet.bind(this, 0));
  } else {
    // As we are adding multiple services of the same type, we need
    // a ServiceLabel service.
    this.serviceLabel = accessory.getService(platform.Service.ServiceLabel)
      || accessory.addService(platform.Service.ServiceLabel);
    this.serviceLabel
      .setCharacteristic(platform.Characteristic.Name, device.name);
    this.serviceLabel
      .getCharacteristic(platform.Characteristic.ServiceLabelNamespace).onGet(() => {
        return (this.platform.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS);
      });
    // Add each of the outlets (the first "outlet" may be USB ports)
    for (let i = 0; i < this.nOutlets; i++) {
      this.outlet.push({});
      this.outlet[i].service = accessory.getService(`Outlet ${i}`)
        || accessory.addService(platform.Service.Outlet, `Outlet ${i}`, `outlet${i}`);
      // Add ServiceLabelIndex and ConfiguredName.  Need try/catch to suppress error if
      // characteristic is already added (which will be the case if restored from cache)
      try {
        this.outlet[i].service.addCharacteristic(platform.Characteristic.ServiceLabelIndex);
      } catch (e) {
        // Ignore
      }
      try {
        this.outlet[i].service.addCharacteristic(platform.Characteristic.ConfiguredName);
      } catch (e) {
        // Ignore
      }
      this.outlet[i].service
        .setCharacteristic(platform.Characteristic.Name, device.name + ` Outlet ${i}`)
        .setCharacteristic(platform.Characteristic.ConfiguredName, `Outlet ${i}`)
        .setCharacteristic(platform.Characteristic.ServiceLabelIndex, i + 1);
      this.outlet[i].service
        .getCharacteristic(platform.Characteristic.On)
        .onGet(handleGet.bind(this, i))
        .onSet(handleSet.bind(this, i));
    }
  }
  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGetBlocking.bind(this, 0));
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
 * For MultiOutlet device...
 * {
 *   "state":["open","open","open","open","open","closed","closed","closed"],
 *   "delays":[{
 *     "ch":1,"on":0,"off":0
 *   },{
 *     "ch":2,"on":0,"off":0
 *   },{
 *     "ch":3,"on":0,"off":0
 *   },{
 *     "ch":4,"on":0,"off":0
 *   }],
 *   "version":"0108",
 *   "tz":-4,
 *   "loraInfo":{
 *     "signal":-9,
 *     "gatewayId":"abcdef1234567890",
 *     "gateways":1
 *   }
 * }

 */
async function handleGet(this: YoLinkPlatformAccessory, outlet = -1): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  handleGetBlocking.bind(this, outlet)()
    .then((v) => {
      this.outlet[outlet].service.updateCharacteristic(platform.Characteristic.On, v);
    });
  // Return current state of the device pending completion of the blocking function
  return ((this.nOutlets === 1)
    ? this.accessory.context.device.data.state === this.onState
    : this.accessory.context.device.data.state[outlet] === this.onState);
}

async function handleGetBlocking(this: YoLinkPlatformAccessory, outlet = -1): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    if (await this.checkDeviceState(platform, device)) {
      if (outlet < 0) {
        // if function was called with negative outlet number then we're being asked to try and
        // automatically detect the number of outlets on the device based on the returned data.
        // "ch" values start from 0 (a two outlet device is 0 and 1).
        return (Math.max(...device.data.delays?.map(o => o.ch) ?? [0]) + 1);
      }
      this.logDeviceState(device, `nOutlets: ${this.nOutlets}, Outlet (0..n-1) ${outlet}: ${device.data.state}`);
      if (this.nOutlets === 1) {
        return (device.data.state === this.onState);
      } else { // if (outlet >= 0) {
        // MultiOutlet device returns state as an array
        return (device.data.state[outlet] === this.onState);
      }
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in OutletDevice handleGet' + platform.reportError + msg);
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
 *   "state":"open",
 *   "loraInfo":{
 *     "signal":-65,
 *     "gatewayId":"abcdef1234567890",
 *     "gateways":1
 *   }
 * }
 *
 * And for a MultiOutlet device...
 * {
 *   "code":"000000",
 *   "time":1661131613258,
 *   "msgid":1661131613258,
 *   "method":"MultiOutlet.setState",
 *   "desc":"Success",
 *   "data":{
 *     "state":["open","open","open","closed","closed","closed","closed","closed"],
 *     "loraInfo":{
 *       "signal":-7,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   }
 * }
 *
 */
async function handleSet(this: YoLinkPlatformAccessory, outlet: number, value: CharacteristicValue): Promise<void> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  handleSetBlocking.bind(this, outlet)(value);
}

async function handleSetBlocking(this: YoLinkPlatformAccessory, outlet: number, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const newState = (value === true) ? this.setOn : this.setOff;
    if (this.nOutlets === 1) {
      // Single outlet device
      const data = (await platform.yolinkAPI.setDeviceState(platform, device, { 'state': newState }))?.data;
      if (data) {
        device.data.state = data.state;
      }
      // Calling updateCharacteristic within set handler seems to fail, new value is not accepted.  Workaround is
      // to request the update after short delay (say 50ms) to allow homebridge/homekit to complete the set handler.
      setTimeout(() => {
        this.outlet[0].service.updateCharacteristic(platform.Characteristic.On, device.data.state === this.onState);
      }, 50);
    } else {
      // MultiOutlet device
      const data = (await platform.yolinkAPI.setDeviceState(platform, device, { 'chs': (1 << outlet), 'state': newState }))?.data;
      if (data) {
        device.data.state[outlet] = data.state[outlet];
      }
      // Calling updateCharacteristic within set handler seems to fail, new value is not accepted.  Workaround is
      // to request the update after short delay (say 50ms) to allow homebridge/homekit to complete the set handler.
      setTimeout(() => {
        this.outlet[outlet].service.updateCharacteristic(platform.Characteristic.On, device.data.state[outlet] === this.onState);
      }, 50);
    }
  } catch (e) {
    const msg = ((e instanceof Error) ? e.stack : e) as string;
    platform.log.error('Error in OutletDevice handleSet' + platform.reportError + msg);
  } finally {
    // Avoid flooding YoLink device with rapid succession of requests.
    const sleep = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
    await sleep(250);
    releaseSemaphore();
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
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
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
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          break;
        }
        // Merge received data into existing data object
        Object.assign(device.data, message.data);
        this.logDeviceState(device, `Outlet: ${device.data.state} (MQTT: ${message.event})`);
        if (this.nOutlets === 1) {
          this.outlet[0].service
            .updateCharacteristic(platform.Characteristic.On, message.data.state === this.onState);
        } else {
          for (let i = 0; i < this.nOutlets; i++) {
            this.outlet[i].service
              .updateCharacteristic(platform.Characteristic.On, message.data.state[i] === this.onState);
          }
        }
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
        this.logDeviceState(device, `Unsupported message (MQTT: ${message.event})`);
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttOutletDevice' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}