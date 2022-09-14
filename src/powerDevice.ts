/***********************************************************************
 * YoLink Power Failure Alarm sensor device support.
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initPowerSensor
 *
 */
export async function initPowerSensor(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device = accessory.context.device;

  this.outletService = accessory.getService(platform.Service.Outlet)
                    || accessory.addService(platform.Service.Outlet);
  this.outletService
    .setCharacteristic(platform.Characteristic.Name, device.name);
  this.outletService
    .getCharacteristic(platform.Characteristic.On)
    .onGet(handleGet.bind(this))
    .onSet(handleSet.bind(this));

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  this.refreshDataTimer(handleGet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * This is an example of JSON object returned.
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  let rc = false;
  try {
    if( await this.checkDeviceState(platform, device) ) {
      this.logDeviceState(device, `Power Failure: ${device.data.state}`);
      rc = device.data.state === 'normal';
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in Power Failure Alarm handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
  return (rc);
}

/***********************************************************************
 * handleSet
 *
 * We ignore requests to change state, will update state to equal current state.
 */
async function handleSet(this: YoLinkPlatformAccessory, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    this.log.info(`Power Failure Alarm handleSet (${value})`);
    this.outletService
      .updateCharacteristic(platform.Characteristic.On, (device.data.state === 'normal') ? true : false);
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in OutletDevice handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}

/***********************************************************************
 * mqttPowerSensor
 *
 * Example of message received.
 *
 */
export async function mqttPowerSensor(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const event = message.event.split('.');
    const batteryMsg = (device.hasBattery && message.data.battery) ? `, Battery: ${message.data.battery}`: '';
    const alertMsg = (message.data.alertType) ? `, Alert: ${message.data.alertType}` : '';

    switch (event[1]) {
      case 'Alert':
        // falls through
      case 'Report':
        // falls through
      case 'StatusChange':
        if (!device.data) {
          // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          this.powerService.updateCharacteristic(platform.Characteristic.StatusFault, true);
          break;
        }
        // Merge received data into existing data object
        Object.assign(device.data, message.data);
        if (!message.data.reportAt) {
          // mqtt data does not include a report time, so merging the objects leaves current
          // unchanged, update the time string.
          device.data.reportAt = device.reportAtTime.toISOString();
        }
        this.logDeviceState(device, `Power Failure: ${message.data.state}${alertMsg}${batteryMsg} (MQTT: ${message.event})`);
        this.outletService
          .updateCharacteristic(platform.Characteristic.On, (message.data.state === 'normal') ? true : false);
        break;
      case 'setOption':
        // Ignore this as there is no status reported.
        platform.verboseLog(mqttMessage + ' ' + JSON.stringify(message));
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttPowerSensor' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}