/***********************************************************************
 * YoLink InfraredRemoter support
 *
 * Support for the YoLink Infrared Remoter device
 *
 * Copyright (c) 2023 David Kerr
 *
 */

import { CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initInfraredRemoter
 *
 */
export async function initInfraredRemoter(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;

  platform.log.warn(`YoLink device type: '${device.type}' is under development (${device.deviceMsgName}) (initialize)`
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

      platform.log.warn(`YoLink device type: '${device.type}' is under development (${device.deviceMsgName}) (handleGet)`
        + platform.reportError + JSON.stringify(device.data, null, 2));

    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in InfraredRemoter handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return (false);
}

/***********************************************************************
 * mqttInfraredRemoter
 *
 */
export async function mqttInfraredRemoter(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {

    platform.log.warn(`YoLink device type: '${device.type}' is under development (${device.deviceMsgName}) (MQTT)`
      + platform.reportError + JSON.stringify(message, null, 2));

  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttInfraredRemoter' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}