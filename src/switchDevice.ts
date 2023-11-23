/***********************************************************************
 * YoLink siren/switch/garage door/finger device support (as a HomeKit switch)
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initSwitchDevice
 *
 */
export async function initSwitchDevice(this: YoLinkPlatformAccessory, onState, setOn, setOff): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  this.setMethod = 'setState';
  this.onState = onState;
  this.setOn = setOn;
  this.setOff = setOff;

  if ((device.type === 'Finger') || (device.type === 'GarageDoor')) {
    this.setMethod = 'toggle';
  }
  this.switchService = accessory.getService(platform.Service.Switch) || accessory.addService(platform.Service.Switch);
  this.switchService.setCharacteristic(platform.Characteristic.Name, device.name);
  this.switchService.getCharacteristic(platform.Characteristic.On)
    .onGet(handleGet.bind(this))
    .onSet(handleSet.bind(this));
  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGet.bind(this));
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
 *
 * Example of Garage Door toggle...
 *
 * {
 *   "code":"000000",
 *   "time":1661296553000,
 *   "msgid":1661296553000,
 *   "method":"GarageDoor.getState",
 *   "desc":"Success",
 *   "data":{
 *     "version":"060a",
 *     "time":"2022-07-23T15:16:09.000Z",
 *     "loraInfo":{
 *       "signal":-67,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   }
 * }
 *
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  let rc = false;
  try {
    if (await this.checkDeviceState(platform, device)) {
      const batteryMsg = (device.hasBattery) ? `, Battery: ${device.data.battery}` : '';
      this.logDeviceState(device, `Switch: ${device.data.state}${batteryMsg}`);
      if (device.data.state === this.onState) {
        rc = true;
      }
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
    }

  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SwitchDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
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
 * Garage Door example...
 *
 * {
 *   "code":"000000",
 *   "time":1661293272749,
 *   "msgid":1661293272749,
 *   "method":"GarageDoor.toggle",
 *   "desc":"Success",
 *   "data":{
 *     "stateChangedAt":1661293272748,
 *     "loraInfo":{
 *       "signal":-70,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   }
 * }
 *
 */
async function handleSet(this: YoLinkPlatformAccessory, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const newState = (value === true) ? this.setOn : this.setOff;
    if (this.onState === 'toggle') {
      device.data.state = 'toggle';
      this.switchService.updateCharacteristic(platform.Characteristic.On, true);
    }
    const data = (await platform.yolinkAPI.setDeviceState(platform, device,
      (newState) ? { 'state': newState } : undefined, this.setMethod))?.data;
    if (data) {
      device.data.state = data.state;
    }
    if (this.onState === 'toggle') {
      // Set state to off after 1 second
      setTimeout(() => {
        device.data.state = undefined;
        this.switchService.updateCharacteristic(platform.Characteristic.On, false);
      }, 1000);
    } else {
      // Calling updateCharacteristic within set handler seems to fail, new value is not accepted.  Workaround is
      // to request the update after short delay (say 50ms) to allow homebridge/homekit to complete the set handler.
      setTimeout(() => {
        this.switchService.updateCharacteristic(platform.Characteristic.On, device.data.state === this.onState);
      }, 50);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SwitchDevice handleGet' + platform.reportError + msg);
  } finally {
    // Avoid flooding YoLink device with rapid succession of requests.
    const sleep = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
    await sleep(250);
    releaseSemaphore();
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
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const event = message.event.split('.');
    const batteryMsg = (device.hasBattery) ? `, Battery: ${message.data.battery}` : '';

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
        this.logDeviceState(device, `Switch: ${device.data.state}${batteryMsg} (MQTT: ${message.event})`);
        this.switchService
          .updateCharacteristic(platform.Characteristic.On,
            (message.data.state === this.onState) ? true : false);
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
        // nothing to update in HomeKit
        this.logDeviceState(device, `Unsupported message (MQTT: ${message.event})`);
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttSwitchDevice' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}