/***********************************************************************
 * YoLink hub device support
 *
 * Homebridge does not have a hub-like device. But we register it and
 * log data about it.
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initHubDevice
 *
 */
export async function initHubDevice(this: YoLinkPlatformAccessory): Promise<void> {
  // Homebridge does not have equivalent to a Hub device, so we essentially
  // just dummy out the functions for logging purposes.
  this.refreshDataTimer(handleGet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    if( await this.checkDeviceState(platform, device) ) {
      this.logDeviceState(device, `WiFi: ${device.data.wifi.enable}, Ethernet: ${device.data.eth.enable}`);
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in HubDevice handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
  return (false);
}

/***********************************************************************
 * mqttHubDevice
 * According to YoLink documentation there is no callback for Hubs. But
 * setup a function for it just-in-case that is wrong.  Log data received.
 */
export async function mqttHubDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    // Merge received data into existing data object
    Object.assign(device.data, message.data);
    this.logDeviceState(device, `WiFi: ${device.data.wifi.enable}, Ethernet: ${device.data.eth.enable} (MQTT: ${message.event})`);
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttHubDevice' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}