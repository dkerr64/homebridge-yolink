/***********************************************************************
 * YoLink lock device support
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initLockDevice
 *
 */
export async function initLockDevice(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device = accessory.context.device;

  this.lockService = accessory.getService(platform.Service.LockMechanism)
                  || accessory.addService(platform.Service.LockMechanism);
  this.lockService.setCharacteristic(platform.Characteristic.Name, device.name);
  this.lockService.getCharacteristic(platform.Characteristic.LockCurrentState)
    .onGet(handleGet.bind(this, 'current'));
  this.lockService.getCharacteristic(platform.Characteristic.LockTargetState)
    .onGet(handleGet.bind(this, 'target'))
    .onSet(handleSet.bind(this));

  // Lock Management is a no-op for us, but according to Apple documentation
  // implementation of it is mandatory. So we will implement as no-op!
  this.lockMgmtServer = accessory.getService(platform.Service.LockManagement)
                     || accessory.addService(platform.Service.LockManagement);
  this.lockMgmtServer.getCharacteristic(platform.Characteristic.Version)
    .onGet( () => {
      platform.verboseLog('Lock Management Version characteristic onGet called');
      return('1.0');
    });
  this.lockMgmtServer.getCharacteristic(platform.Characteristic.LockControlPoint)
    .onSet( (value: CharacteristicValue) => {
      platform.verboseLog(`Lock Management LockControlPoint onSet called with '${value}'`);
      return;
    });

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  this.refreshDataTimer(handleGet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * Example of message received
 *
 */
async function handleGet(this: YoLinkPlatformAccessory, requested = 'current'): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  let rc = (requested === 'current') ? 3 : 0;
  // rc 0 = unsecured, 1 = secured, (and for current state only... 2 = jammed, 3 = unknown)
  try {
    if( await this.checkDeviceState(platform, device) ) {
      const batteryMsg = (device.hasBattery) ? `, Battery: ${device.data.state.battery}`: '';
      this.logDeviceState(device, `Lock: ${device.data.state.state}${batteryMsg}`);
      rc = (device.data.state.state === 'locked') ? 1 : 0;
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
    }

  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in LockDevice handleGet' + platform.reportError + msg);
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
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    platform.log.warn(`Unsupported request to lock or unlock ${device.deviceMsgName} to '${value}'`);
    // If it is supported set the current state to the new state, for now just set to requested.
    this.lockService
      .updateCharacteristic(platform.Characteristic.LockCurrentState, value);
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in LockDevice handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}

/***********************************************************************
 * mqttLockDevice
 *
 * Example of message received,
 *
 */
export async function mqttLockDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const event = message.event.split('.');
    const batteryMsg = (device.hasBattery) ? `, Battery: ${message.data.battery}`: '';

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
        Object.assign(device.data.state, message.data);
        if (!message.data.reportAt) {
          // mqtt data does not include a report time, so merging the objects leaves current
          // unchanged, update the time string.
          device.data.reportAt = device.reportAtTime.toISOString();
        }
        this.logDeviceState(device, `Lock: ${message.data.state}${batteryMsg} (MQTT: ${message.event})`);
        this.lockService
          .updateCharacteristic(platform.Characteristic.LockCurrentState,
            (message.data.state === 'locked') ? 1 : 0);
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttLockDevice' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}