/***********************************************************************
 * YoLink manipulator (e.g. water valve) device support
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initValveDevice
 *
 */
export async function initValveDevice(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device = accessory.context.device;

  this.valveService = accessory.getService(platform.Service.Valve) || accessory.addService(platform.Service.Valve);
  this.valveService.setCharacteristic(platform.Characteristic.Name, device.name);
  this.valveService.getCharacteristic(platform.Characteristic.Active)
    .onGet(handleGet.bind(this))
    .onSet(handleSet.bind(this));
  this.valveService.getCharacteristic(platform.Characteristic.InUse)
    .onGet(handleInUse.bind(this));
  this.valveService.getCharacteristic(platform.Characteristic.ValveType)
    .onGet(handleType.bind(this));
  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  this.refreshDataTimer(handleGet.bind(this));
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
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  const device = this.accessory.context.device;
  let rc = platform.api.hap.Characteristic.Active.INACTIVE;

  if( await this.checkDeviceState(platform, device)) {
    this.valveService
      .updateCharacteristic(platform.Characteristic.StatusLowBattery, (device.data.battery <= 1)
        ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
      // YoLink manipulator data does not return a 'online' value.  We will assume that if
      // we got this far then it is working normally...
      .updateCharacteristic(platform.Characteristic.StatusActive, true)
      .updateCharacteristic(platform.Characteristic.StatusFault, false);
    platform.liteLog(`Device state for ${this.deviceMsgName} is: ${device.data.state}`);
    if (device.data.battery <= 1) {
      platform.log.warn(`Device ${this.deviceMsgName} reports battery < 25%`);
    }
    if (device.data.state === 'open') {
      rc = platform.api.hap.Characteristic.Active.ACTIVE;
    }
  } else {
    platform.log.error(`Device offline or other error for ${this.deviceMsgName}`);
    this.valveService
      .updateCharacteristic(platform.Characteristic.StatusActive, false)
      .updateCharacteristic(platform.Characteristic.StatusFault, true);
  }

  await releaseSemaphore();
  return (rc);
}

/***********************************************************************
 * handleInUse
 *
 */
async function handleInUse(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  this.platform.liteLog(`Valve in use state for ${this.deviceMsgName}, calling isActive`);
  // Apple HomeKit documentation defines In Use as fluid is flowing through valve.
  // We will assume that if the valve is open, then fluid is flowing...
  return(await handleGet.bind(this)());
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
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  const device = this.accessory.context.device;
  platform.log.info(`setDeviceState for ${this.deviceMsgName}`);
  const newState = (value === platform.api.hap.Characteristic.Active.ACTIVE) ? 'open' : 'close';

  const data = await platform.yolinkAPI.setDeviceState(platform, device, {'state':newState});
  device.data.state = (data) ? data.state : '';

  await releaseSemaphore();
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
 * Example of message received, first one is regular repoorting, 2nd one
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

  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  const device = this.accessory.context.device;
  device.updateTime = Math.floor(new Date().getTime() / 1000) + this.config.refreshAfter;
  const event = message.event.split('.');

  switch (event[1]) {
    case 'Report':
    // falls through
    case 'getState':
      // falls through
    case 'setState':
      if (!device.data) {
        // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
        platform.log.warn(`Device ${this.deviceMsgName} has no data field, is device offline?`);
        break;
      }
      // if we received a message then device must be online
      device.data.online = true;
      // Merge received data into existing data object
      Object.assign(device.data, message.data);
      if (message.data.battery) {
        this.valveService
          .updateCharacteristic(platform.Characteristic.StatusLowBattery,
            (message.data.battery <= 1)
              ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
              : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
      }
      this.valveService
        .updateCharacteristic(platform.Characteristic.Active,
          (message.data.state === 'open')
            ? platform.api.hap.Characteristic.Active.ACTIVE
            : platform.api.hap.Characteristic.Active.INACTIVE)
        .updateCharacteristic(platform.Characteristic.StatusActive, true)
        .updateCharacteristic(platform.Characteristic.StatusFault, false);
      if (message.data.battery <= 1) {
        platform.log.warn(`Device ${this.deviceMsgName} reports battery < 25%`);
      }
      break;
    default:
      platform.log.warn('Unsupported mqtt event: \'' + message.event + '\'\n'
        + 'Please report at https://github.com/dkerr64/homebridge-yolink/issues\n'
        + JSON.stringify(message));
  }

  await releaseSemaphore();
}