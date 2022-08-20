/***********************************************************************
 * YoLink unknown device support
 *
 * This will issue warning messages to the HomeBridge log that can then
 * be provided to author to assist in adding device support.
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initUnknownDevice
 *
 */
export async function initUnknownDevice(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;

  platform.log.warn(`YoLink device type: '${device.type}' is not supported (${this.deviceMsgName}) (initialize)`
    + platform.reportError + JSON.stringify(device));

  this.refreshDataTimer(handleGet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  try {
    const device = this.accessory.context.device;
    if( await this.checkDeviceState(platform, device) ) {

      platform.log.warn(`YoLink device type: '${device.type}' is not supported (${this.deviceMsgName}) (handleGet)`
        + platform.reportError + JSON.stringify(device.data));

    } else {
      platform.log.error(`Device offline or other error for ${this.deviceMsgName}`);
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in UnknownDevice handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
  return (false);
}

/***********************************************************************
 * mqttUnknownDevice
 *
 */
export async function mqttUnknownDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  try {
    const device = this.accessory.context.device;

    platform.log.warn(`YoLink device type: '${device.type}' is not supported (${this.deviceMsgName}) (MQTT)`
      + platform.reportError + JSON.stringify(message));

  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttUnknownDevice' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}