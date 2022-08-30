/***********************************************************************
 * YoLink outlet and multi-outlet device support
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

  this.nOutlets = 1;
  this.onState = onState;
  this.setOn = setOn;
  this.setOff = setOff;
  this.outlet = [];

  if (device.type === 'MultiOutlet') {
    // Default to 5 outlets (YoLink power strip has USB + 4 outlets)
    this.nOutlets = device.config.nOutlets ?? 5;
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
      .getCharacteristic(platform.Characteristic.ServiceLabelNamespace).onGet( () => {
        return(this.platform.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS);
      });
    // Add each of the outlets (the first "outlet" may be USB ports)
    for (let i = 0; i < this.nOutlets; i++) {
      this.outlet.push({});
      this.outlet[i].service = accessory.getService(`Outlet ${i}`)
                            || accessory.addService(platform.Service.Outlet, `Outlet ${i}`, `outlet${i}`);
      this.outlet[i].service
        .setCharacteristic(platform.Characteristic.Name, device.name + ` Outlet ${i}`)
        .setCharacteristic(platform.Characteristic.ServiceLabelIndex, i+1);
      this.outlet[i].service
        .getCharacteristic(platform.Characteristic.On)
        .onGet(handleGet.bind(this, i))
        .onSet(handleSet.bind(this, i));
    }
  }
  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  this.refreshDataTimer(handleGet.bind(this, 0));
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
async function handleGet(this: YoLinkPlatformAccessory, outlet: number): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  let rc = false;
  try {
    if( await this.checkDeviceState(platform, device) ) {
      this.logDeviceState(device, `Outlet ${outlet}: ${device.data.state}`);
      if (this.nOutlets === 1) {
        if (device.data.state === this.onState) {
          rc = true;
        }
      } else {
        // MultiOutlet device returns state as an array
        if (device.data.state[outlet] === this.onState) {
          rc = true;
        }
      }
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
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
 * And for a MultOutlet device...
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
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const newState = (value === true) ? this.setOn : this.setOff;
    if (this.nOutlets === 1) {
      // Single outlet device
      const data = (await platform.yolinkAPI.setDeviceState(platform, device, {'state':newState}))?.data;
      // error will have been thrown in yolinkAPI if data not valid
      device.data.state = data.state;
      this.outlet[0].service
        .updateCharacteristic(platform.Characteristic.On, (data.state === this.onState) ? true : false);
    } else {
      // MultiOutlet device
      const data = (await platform.yolinkAPI.setDeviceState(platform, device, {'chs':(1<<outlet), 'state':newState}))?.data;
      // error will have been thrown in yolinkAPI if data not valid
      device.data.state[outlet] = data.state[outlet];
      this.outlet[outlet].service
        .updateCharacteristic(platform.Characteristic.On, (data.state[outlet] === this.onState) ? true : false);
    }
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
  const device = this.accessory.context.device;
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
        // if we received a message then device must be online
        device.data.online = true;
        // Merge received data into existing data object
        Object.assign(device.data, message.data);
        this.logDeviceState(device, `Outlet: ${device.data.state} (MQTT: ${message.event})`);
        if (this.nOutlets === 1) {
          this.outlet[0].service
            .updateCharacteristic(platform.Characteristic.On, (message.data.state === this.onState) ? true : false);
        } else {
          for (let i = 0; i <= this.nOutlets; i++) {
            this.outlet[i].service
              .updateCharacteristic(platform.Characteristic.On, (message.data.state[i] === this.onState) ? true : false);
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
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttOutletDevice' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}