/***********************************************************************
 * YoLink InfraredRemoter support
 *
 * Support for the YoLink Infrared Remoter device
 *
 * Copyright (c) 2023 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initInfraredRemoter
 *
 */
export async function initInfraredRemoter(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = this.accessory.context.device;

  this.setMethod = 'send';
  this.irKey = [];

  await handleGet.bind(this)();
  const nLearned = device.data.keys.reduce((n: number, x: boolean) => (x === true) ? n + 1 : n, 0);
  platform.verboseLog(`Initialize infrared remoter with ${nLearned} button${(nLearned > 1) ? 's' : ''}`);

  // serviceLabel required when multiple services of same type on one accessory
  this.serviceLabel = accessory.getService(platform.Service.ServiceLabel) || accessory.addService(platform.Service.ServiceLabel);
  this.serviceLabel.setCharacteristic(platform.Characteristic.Name, device.name);
  this.serviceLabel.getCharacteristic(platform.Characteristic.ServiceLabelNamespace).onGet(() => {
    return (this.platform.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS);
  });

  let slIndex = 1;
  device.data.keys.forEach((b: boolean, i: number) => {
    if (b) {
      platform.verboseLog(`Add switch for learned button index: ${i}`);
      this.irKey[i] = {};
      if (!(this.irKey[i].switchService = accessory.getService(`IR Key ${i}`))) {
        this.irKey[i].switchService = accessory.addService(platform.Service.Switch, `IR Key ${i}`, `irkey${i}`);
        this.irKey[i].switchService.addCharacteristic(platform.Characteristic.ConfiguredName);
      }
      this.irKey[i].switchService
        .setCharacteristic(platform.Characteristic.Name, `${device.name} IR Key ${i}`)
        .setCharacteristic(platform.Characteristic.ConfiguredName, `IR Key ${i}`)
        .setCharacteristic(platform.Characteristic.ServiceLabelIndex, slIndex++);
      this.irKey[i].switchService.getCharacteristic(platform.Characteristic.On)
        .onGet(handleGet.bind(this, i))
        .onSet(handleSet.bind(this, i));
    }
  });

  // timer to regularly update the data... really only to monitor battery level.
  this.refreshDataTimer(handleGet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * Example of message received:
 * Note that array of keys is length 64
 * {
 *   "battery": 4,
 *   "keys": [
 *     true,
 *     false,
 *     .
 *     .
 *     .
 *     false,
 *     false
 *   ],
 *   "version": "030a",
 *   "time": "2023-10-18T16:20:54.000Z",
 *   "tz": 0,
 *   "loraInfo": {
 *     "netId": "010203",
 *     "signal": -23,
 *     "gatewayId": "abcdef1234567890",
 *     "gateways": 1
 *   }
 * }
 */
async function handleGet(this: YoLinkPlatformAccessory, keyNumber = -1): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;

  // No need to check the device for status, the "switch" is always off.
  // Only check device if called without specific key number (to get initial settings);
  if (keyNumber < 0) {
    // serialize access to device data.
    const releaseSemaphore = await device.semaphore.acquire();
    try {
      if (await this.checkDeviceState(platform, device)) {
        const batteryMsg = (device.hasBattery) ? `, Battery: ${device.data.battery}` : '';
        this.logDeviceState(device, `Key Number: ${keyNumber}${batteryMsg}`);
      } else {
        platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
      }
    } catch (e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in infrared remoter handleGet' + platform.reportError + msg);
    } finally {
      releaseSemaphore();
    }
  }
  // IR Remoter buttons are always "off" as they are stateless
  return (false);
}

/***********************************************************************
 * handleSet
 *
 * This is an example of JSON object returned.
 *
 * {
 *   "key": 0,
 *   "success": true
 * }
 *
 */
async function handleSet(this: YoLinkPlatformAccessory, keyNumber = -1, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    if (keyNumber >= 0 && value === true) {
      const data = (await platform.yolinkAPI.setDeviceState(platform, device, { 'key': keyNumber }, this.setMethod))?.data;
      // error will have been thrown in yolinkAPI if data not valid
      if (!data.success) {
        platform.log.warn(`Sending IR code for key number ${keyNumber} failed with error: ${data.errorCode}`);
      }
      // Sending IR signal is stateless, make sure that the switch is turned off after slight delay
      setTimeout(() => {
        this.irKey[keyNumber].switchService.updateCharacteristic(platform.Characteristic.On, false);
      }, 50);
    } else {
      platform.log.warn(`Cannot turn off infrared Key number ${keyNumber}, switch is stateless and always off`);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SwitchDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
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
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const event = message.event.split('.');
    // const batteryMsg = (device.hasBattery) ? `, Battery: ${message.data.battery}`: '';

    switch (event[1]) {
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message, null, 2));
    }

  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttInfraredRemoter' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}