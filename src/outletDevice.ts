/***********************************************************************
 * YoLink outlet device support
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

Error.stackTraceLimit = 100;

/***********************************************************************
 * initOutletDevice
 *
 */
export async function initOutletDevice(this: YoLinkPlatformAccessory, onState, setOn, setOff): Promise<void> {
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
      this.logDeviceState(new Date(device.data.reportAt),
        `Outlet: ${device.data.state}, Battery: ${device.data.battery}`);
      this.updateBatteryInfo.bind(this)();
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
    platform.log.error('Error in OutletDevice handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}

/***********************************************************************
 * mqttOutletDevice
 *
 * Example of message received.
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
        if (!device.data) {
        // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${this.deviceMsgName} has no data field, is device offline?`);
          break;
        }
        // if we received a message then device must be online
        device.data.online = true;
        // Merge received data into existing data object
        Object.assign(device.data.state, message.data);
        // mqtt data does not include a report time, so merging the objects leaves current
        // unchanged. As we use this to control when to log new data, update the time string.
        device.data.reportAt = new Date(parseInt(message.msgid)).toISOString();
        platform.log.info(`${mqttMessage} State: '${message.data.state}'`);
        this.updateBatteryInfo.bind(this)();
        this.outletService
          .updateCharacteristic(platform.Characteristic.On,
            (message.data.state === this.onState) ? true : false);
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