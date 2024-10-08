/***********************************************************************
 * YoLink unknown device support
 *
 * This will issue warning messages to the HomeBridge log that can then
 * be provided to author to assist in adding device support.
 *
 * Copyright (c) 2022-2024 David Kerr
 *
 */

import { CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initUnknownDevice
 *
 */
export async function initUnknownDevice(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;

  platform.log.warn(`YoLink device type: '${device.type}' is not supported (${device.deviceMsgName}) (initialize)`
    + platform.reportError + JSON.stringify(device, null, 2));

  this.refreshDataTimer(handleGet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    if (await this.checkDeviceState(platform, device)) {

      platform.log.warn(`YoLink device type: '${device.type}' is not supported (${device.deviceMsgName}) (handleGet)`
        + platform.reportError + JSON.stringify(device.data, null, 2));

    } else {
      platform.log.error(`[${device.deviceMsgName}] Device offline or other error`);
      device.errorState = true;
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in UnknownDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return (false);
}

/***********************************************************************
 * mqttUnknownDevice
 *
 */
export async function mqttUnknownDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {

    platform.log.warn(`YoLink device type: '${device.type}' is not supported (${device.deviceMsgName}) (MQTT)`
      + platform.reportError + JSON.stringify(message, null, 2));

  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttUnknownDevice' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}