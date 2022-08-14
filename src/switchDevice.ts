/***********************************************************************
 * YoLink siren/switch device support (as a HomeKit switch)
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

Error.stackTraceLimit = 100;

/***********************************************************************
 * initSwitchDevice
 *
 */
export async function initSwitchDevice(this: YoLinkPlatformAccessory, onState, setOn, setOff): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device = accessory.context.device;

  this.onState = onState;
  this.setOn = setOn;
  this.setOff = setOff;

  this.switchService = accessory.getService(platform.Service.Switch) || accessory.addService(platform.Service.Switch);
  this.switchService.setCharacteristic(platform.Characteristic.Name, device.name);
  this.switchService.getCharacteristic(platform.Characteristic.On)
    .onGet(handleGet.bind(this))
    .onSet(handleSet.bind(this));
  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  this.refreshDataTimer(handleGet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * Example of message received,
 * {
 *   "event":"Siren.getState",
 *   "time":1660266651077,
 *   "msgid":"1660266651074",
 *   "data": {
 *     "state":"normal",
 *     "soundLevel":3,
 *     "battery":4,
 *     "powerSupply":"usb",
 *     "alarmDuation":30,
 *     "version":"030a",
 *     "mute":true,
 *     "loraInfo":
 *     {
 *       "signal":-58,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  let rc = false;
  try {
    const device = this.accessory.context.device;
    if( await this.checkDeviceState(platform, device) ) {
      platform.liteLog(`Device state for ${this.deviceMsgName} is: ${device.data.state}`);
      if (device.data.state === this.onState) {
        rc = true;
      }
    } else {
      platform.log.error(`Device offline or other error for ${this.deviceMsgName}`);
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SwitchDevice handleGet' + platform.reportError + msg);
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
 *   "state":"normal",
 *   "loraInfo":
 *   {
 *     "signal":-59,
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
    platform.log.info(`setDeviceState for ${this.deviceMsgName}`);
    const newState = (value === true) ? this.setOn : this.setOff;
    const data = await platform.yolinkAPI.setDeviceState(platform, device, {'state':newState});
    device.data.state = (data) ? data.state : false;
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SwitchDevice handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}

/***********************************************************************
 * mqttSwitchDevice
 *
 * Example of message received,
 * {
 *   "event":"Siren.getState",
 *   "time":1660266651077,
 *   "msgid":"1660266651074",
 *   "data": {
 *     "state":"normal",
 *     "soundLevel":3,
 *     "battery":4,
 *     "powerSupply":"usb",
 *     "alarmDuation":30,
 *     "version":"030a",
 *     "mute":true,
 *     "loraInfo":
 *     {
 *       "signal":-58,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * Alternate example
 * {
 *   "event":"Siren.setState",
 *   "time":1660266653096,
 *   "msgid":"1660266653095",
 *   "data":{
 *     "state":"alert",
 *     "loraInfo":{
 *       "signal":-59,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 */
export async function mqttSwitchDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;

  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  try {
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
        Object.assign(device.data.state, message.data);
        this.switchService
          .updateCharacteristic(platform.Characteristic.On,
            (message.data.state === this.onState) ? true : false);
        break;
      default:
        platform.log.warn('Unsupported mqtt event: \'' + message.event + '\'' + platform.reportError + JSON.stringify(message));
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in YoLink plugin' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}