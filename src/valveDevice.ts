/***********************************************************************
 * YoLink manipulator (e.g. water valve) device support
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initValveDevice
 *
 */
export async function initValveDevice(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  this.valveService = accessory.getService(platform.Service.Valve)
    || accessory.addService(platform.Service.Valve);
  this.valveService.setCharacteristic(platform.Characteristic.Name, device.name);

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGetBlocking.bind(this, 'both'));

  // Once we have initial data, setup all the Homebridge handlers
  this.valveService.getCharacteristic(platform.Characteristic.Active)
    .onGet(handleGet.bind(this))
    .onSet(handleSet.bind(this));
  this.valveService.getCharacteristic(platform.Characteristic.InUse)
    .onGet(handleInUse.bind(this));
  this.valveService.getCharacteristic(platform.Characteristic.ValveType)
    .onGet(handleType.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * This is an example of JSON object returned.
 *  {
 *    "state": "open",
 *    "battery": 3,
 *    "delay": {
 *      "ch": 1,
 *      "off": 0
 *    },
 *    "openRemind": 0,
 *    "version": "0906",
 *    "time": "2022-06-22T03:54:01.000Z",
 *    "tz": -4,
 *    "loraInfo": {
 *      "signal": -71,
 *      "gatewayId": "abcdef1234567890",
 *      "gateways": 1
 *    }
 *  }
 */
async function handleGet(this: YoLinkPlatformAccessory, request = 'Active'): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  handleGetBlocking.bind(this, request)()
    .then((v) => {
      if (request === 'Active') {
        this.valveService.updateCharacteristic(platform.Characteristic.Active, v);
      } else {
        this.valveService.updateCharacteristic(platform.Characteristic.InUse, v);
      }
    });
  // Return current state of the device pending completion of the blocking function
  return ((device.data.state === 'open')
    ? platform.api.hap.Characteristic.Active.ACTIVE
    : platform.api.hap.Characteristic.Active.INACTIVE);
}

async function handleGetBlocking(this: YoLinkPlatformAccessory, request = 'Active'): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  let rc = platform.api.hap.Characteristic.Active.INACTIVE;
  try {
    if (await this.checkDeviceState(platform, device)) {
      this.valveService
        // YoLink manipulator data does not return a 'online' value.  We will assume that if
        // we got this far then it is working normally...
        .updateCharacteristic(platform.Characteristic.StatusFault, false);
      if (device.data.state === 'open') {
        rc = platform.api.hap.Characteristic.Active.ACTIVE;
      }
      this.logDeviceState(device, `Valve (${request}): ${device.data.state}, Battery: ${device.data.battery}`);
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
      this.valveService
        .updateCharacteristic(platform.Characteristic.StatusFault, true);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in ValveDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return rc;
}

/***********************************************************************
 * handleInUse
 *
 */
async function handleInUse(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  // Apple HomeKit documentation defines In Use as fluid is flowing through valve.
  // We will assume that if the valve is open, then fluid is flowing...
  return await handleGet.bind(this)('InUse');
}

/***********************************************************************
 * handleSet
 *
 * This is an example of JSON object returned.
 *  {
 *    "state": "closed",
 *    "loraInfo": {
 *      "signal": -72,
 *      "gatewayId": "d88b4c1603008c02",
 *      "gateways": 1
 *    }
 *  }
 */
async function handleSet(this: YoLinkPlatformAccessory, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const newState = (value === platform.api.hap.Characteristic.Active.ACTIVE) ? 'open' : 'close';
    const data = (await platform.yolinkAPI.setDeviceState(platform, device, { 'state': newState }))?.data;
    if (data) {
      device.data.state = data.state;
    }
    // Calling updateCharacteristic within set handler seems to fail, new value is not accepted.  Workaround is
    // to request the update after short delay (say 50ms) to allow homebridge/homekit to complete the set handler.
    setTimeout(() => {
      this.valveService
        .updateCharacteristic(platform.Characteristic.Active, (device.data.state === 'open')
          ? platform.api.hap.Characteristic.Active.ACTIVE : platform.api.hap.Characteristic.Active.INACTIVE)
        .updateCharacteristic(platform.Characteristic.InUse, (device.data.state === 'open')
          ? platform.api.hap.Characteristic.InUse.IN_USE : platform.api.hap.Characteristic.InUse.NOT_IN_USE);
    }, 50);
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in ValveDevice handleSet' + platform.reportError + msg);
  } finally {
    // Avoid flooding YoLink device with rapid succession of requests.
    const sleep = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
    await sleep(250);
    releaseSemaphore();
  }
}

/***********************************************************************
 * handleType
 *
 */
async function handleType(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  return this.platform.Characteristic.ValveType.GENERIC_VALVE;
}


/***********************************************************************
 * mqttValveDevice
 *
 * Example of message received, first one is regular reporting, 2nd one
 * is on another device (the YoLink app) opening a valve.  Note that some
 * fields are not provided in 2nd version (e.g. Battery level).
 *  {
 *    "event": "Manipulator.Report",
 *    "time": 1658504122331,
 *    "msgid": "1658504122330",
 *    "data": {
 *      "state": "open",
 *      "battery": 3,
 *      "delay": {
 *        "ch": 1,
 *        "off": 0
 *      },
 *      "openRemind": 0,
 *      "version": "0906",
 *      "time": "2022-06-22T03:35:21.000Z",
 *      "tz": -4,
 *      "loraInfo": {
 *        "signal": -70,
 *        "gatewayId": "abcdef1234567890",
 *        "gateways": 1
 *      }
 *    },
 *    "deviceId": "abcdef1234567890"
 *  }
 * =============
 * {
 *   "event": "Manipulator.setState",
 *   "time": 1658520338496,
 *   "msgid": "1658520338495",
 *   "data": {
 *     "state": "open",
 *     "loraInfo": {
 *       "signal": -71,
 *       "gatewayId": "abcdef1234567890",
 *       "gateways": 1
 *     }
 *   },
 *   "deviceId": "abcdef1234567890"
 * }
 */
export async function mqttValveDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
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
        // falls through
        if (!device.data) {
          // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          this.valveService.updateCharacteristic(platform.Characteristic.StatusFault, true);
          break;
        }
        // Merge received data into existing data object
        Object.assign(device.data, message.data);
        this.logDeviceState(device, `Valve: ${device.data.state}, Battery: ${device.data.battery} (MQTT: ${message.event})`);
        this.valveService
          .updateCharacteristic(platform.Characteristic.Active, (message.data.state === 'open')
            ? platform.api.hap.Characteristic.Active.ACTIVE
            : platform.api.hap.Characteristic.Active.INACTIVE)
          .updateCharacteristic(platform.Characteristic.InUse, (message.data.state === 'open')
            ? platform.api.hap.Characteristic.InUse.IN_USE
            : platform.api.hap.Characteristic.InUse.NOT_IN_USE)
          .updateCharacteristic(platform.Characteristic.StatusFault, false);
        break;
      case 'setTimeZone':
        // nothing to update in HomeKit
        this.logDeviceState(device, `Unsupported message (MQTT: ${message.event})`);
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message, null, 2));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttValveDevice' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}