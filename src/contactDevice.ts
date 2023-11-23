/***********************************************************************
 * YoLink door sensor device support.
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initContactSensor
 *
 */
export async function initContactSensor(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  this.contactService = accessory.getService(platform.Service.ContactSensor) || accessory.addService(platform.Service.ContactSensor);
  this.contactService.setCharacteristic(platform.Characteristic.Name, device.name);
  this.contactService.getCharacteristic(platform.Characteristic.ContactSensorState)
    .onGet(handleGet.bind(this));

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGetBlocking.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * This is an example of JSON object returned.
 * {
 *   "online":true,
 *   "state":
 *   {
 *     "alertInterval":0,
 *     "battery":4,
 *     "delay":0,
 *     "openRemindDelay":20,
 *     "state":"closed",
 *     "version":"0703",
 *     "stateChangedAt":1657756249212
 *   },
 *   "deviceId":"abcdef1234567890",
 *   "reportAt":"2022-08-10T19:50:17.218Z"
 *   }
 * }
 *
 * state may be "open", "closed", or "error"
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  handleGetBlocking.bind(this)()
    .then((v) => {
      this.hydroService!.updateCharacteristic(platform.Characteristic.ContactSensorState, v);
    });
  // Return current state of the device pending completion of the blocking function
  return ((device.data?.state?.state === 'closed')
    ? platform.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
    : platform.api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
}

async function handleGetBlocking(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  let rc = platform.api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  try {
    if (await this.checkDeviceState(platform, device) && device.data.online && (device.data.state.state !== 'error')) {
      this.contactService
        .updateCharacteristic(platform.Characteristic.StatusActive, true)
        .updateCharacteristic(platform.Characteristic.StatusFault, false);
      if (device.data.state.state === 'closed') {
        rc = platform.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
      }
      this.logDeviceState(device, `Contact: ${device.data.state.state}, Battery: ${device.data.state.battery}`);
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
      this.contactService
        .updateCharacteristic(platform.Characteristic.StatusActive, false)
        .updateCharacteristic(platform.Characteristic.StatusFault, true);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in ContactDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return (rc);
}

/***********************************************************************
 * mqttContactSensor
 *
 * Example of message received.
 * {
 *   "event":"DoorSensor.Alert",
 *   "time":1660154987072,
 *   "msgid":"1660154987071",
 *   "data": {
 *     "state":"open",
 *     "alertType":"normal",
 *     "battery":4,
 *     "version":"0703",
 *     "loraInfo": {
 *       "signal":-77,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     },
 *     "stateChangedAt":1660154987070
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * state may be "open", "closed", or "error"
 * alertType may be "normal", or "openRemind"
 *
 * Alternate message when OpenRemind time is changed...
 * {
 *   "event":"DoorSensor.setOpenRemind",
 *   "time":1660174192117,
 *   "msgid":"1660174192116",
 *   "data": {
 *     "delay":0,
 *     "openRemindDelay":20,
 *     "alertInterval":0,
 *     "loraInfo": {
 *       "signal":-65,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 */
export async function mqttContactSensor(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const event = message.event.split('.');
    const batteryMsg = (device.hasBattery && message.data.battery) ? `, Battery: ${message.data.battery}` : '';
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
          this.contactService.updateCharacteristic(platform.Characteristic.StatusFault, true);
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
        this.logDeviceState(device, `Contact: ${device.data.state.state}${alertMsg}${batteryMsg} (MQTT: ${message.event})`);
        this.contactService
          .updateCharacteristic(platform.Characteristic.ContactSensorState,
            (message.data.state === 'closed')
              ? platform.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
              : platform.api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
          .updateCharacteristic(platform.Characteristic.StatusActive, true)
          .updateCharacteristic(platform.Characteristic.StatusFault, false);
        break;
      case 'setOpenRemind':
        // Homebridge has no equivalent and message does not carry either contact state or battery
        // state fields, so there is nothing we can update.
        platform.liteLog(mqttMessage + ' ' + JSON.stringify(message));
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttContactSensor' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}