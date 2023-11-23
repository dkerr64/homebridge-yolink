/***********************************************************************
 * YoLink Power Failure Alarm sensor device support.
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initPowerSensor
 *
 */
export async function initPowerSensor(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;
  const serviceType = String(device.config.powerFailureSensorAs).toLowerCase();

  this.currentState = undefined;

  if (serviceType === 'contact') {
    // In case it was previously set as outlet, remove it...
    accessory.removeService(accessory.getService(platform.Service.Outlet)!);
    this.outletService = undefined;
    this.contactService = accessory.getService(platform.Service.ContactSensor)
      || accessory.addService(platform.Service.ContactSensor);
    this.contactService.setCharacteristic(platform.Characteristic.Name, device.name);
    this.contactService.getCharacteristic(platform.Characteristic.ContactSensorState)
      .onGet(handleGet.bind(this));
  } else {
    // In case it was previously set as contact, remove it...
    accessory.removeService(accessory.getService(platform.Service.ContactSensor)!);
    this.contactService = undefined;
    this.outletService = accessory.getService(platform.Service.Outlet)
      || accessory.addService(platform.Service.Outlet);
    this.outletService.setCharacteristic(platform.Characteristic.Name, device.name);
    this.outletService.getCharacteristic(platform.Characteristic.On)
      .onGet(handleGet.bind(this))
      .onSet(handleSet.bind(this));
  }

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGetBlocking.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * This is an example of JSON object returned...
 * {
 *   "code": "000000",
 *   "time": 1663120072812,
 *   "msgid": 1663120072812,
 *   "method": "PowerFailureAlarm.getState",
 *   "desc": "Success",
 *   "data": {
 *     "online": true,
 *     "state": {
 *       "alertDuration": 30,
 *       "alertInterval": 60,
 *       "alertType": null,
 *       "battery": 4,
 *       "powerSupply": true,
 *       "sound": 1,
 *       "state": "normal",
 *       "version": "0608"
 *     },
 *     "deviceId": "xxx",
 *     "reportAt": "2022-09-14T01:35:14.157Z"
 *   }
 * }
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  handleGetBlocking.bind(this)()
    .then((v) => {
      if (this.contactService) {
        this.contactService.updateCharacteristic(platform.Characteristic.ContactSensorState, v);
      } else {
        this.outletService.updateCharacteristic(platform.Characteristic.On, v);
      }
    });
  // Return current state of the device pending completion of the blocking function
  return (this.currentState);
}

async function handleGetBlocking(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  // default rc assumes that all is okay (power is up)
  let rc = (this.contactService) ? platform.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED : true;
  try {
    if (await this.checkDeviceState(platform, device) && device.data.online) {
      if (this.contactService) {
        this.contactService
          .updateCharacteristic(platform.Characteristic.StatusActive, true)
          .updateCharacteristic(platform.Characteristic.StatusFault, false);
        if (!device.data.state.powerSupply) {
          rc = platform.api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
        }
      } else {
        rc = device.data.state.powerSupply;
      }
      this.logDeviceState(device, `Power OK: ${device.data.state.powerSupply}, ` +
        `State: ${device.data.state.state}, Battery: ${device.data.state.battery}`);
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
      if (this.contactService) {
        this.contactService
          .updateCharacteristic(platform.Characteristic.StatusActive, false)
          .updateCharacteristic(platform.Characteristic.StatusFault, true);
      }
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in Power Failure Alarm handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  this.currentState = rc;
  return (rc);
}

/***********************************************************************
 * handleSet
 *
 * We ignore requests to change state, will update state to equal current state.
 */
async function handleSet(this: YoLinkPlatformAccessory, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    this.log.info(`Power Failure Alarm handleSet (${value})`);
    this.outletService
      .updateCharacteristic(platform.Characteristic.On, device.data.state.powerSupply);
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in OutletDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}

/***********************************************************************
 * mqttPowerSensor
 *
 * Example of message received...
 * {
 *   "event": "PowerFailureAlarm.Alert",
 *   "time": 1663029430659,
 *   "msgid": "1663029430658",
 *   "data": {
 *     "state": "alert",
 *     "sound": 1,
 *     "battery": 4,
 *     "powerSupply": false,
 *     "alertDuration": 30,
 *     "alertInterval": 5,
 *     "version": "0608",
 *     "loraInfo": {
 *       "signal": -47,
 *       "gatewayId": "xxx",
 *       "gateways": 4
 *     }
 *   },
 *   "deviceId": "xxx"
 * }
 *
 * {
 *   "event": "PowerFailureAlarm.StatusChange",
 *   "time": 1663029928110,
 *   "msgid": "1663029928109",
 *   "data": {
 *     "state": "normal",
 *     "sound": 1,
 *     "battery": 4,
 *     "powerSupply": true,
 *     "alertDuration": 30,
 *     "alertInterval": 5,
 *     "version": "0608",
 *     "loraInfo": {
 *       "signal": -31,
 *       "gatewayId": "xxx",
 *       "gateways": 4
 *     }
 *   },
 *   "deviceId": "xxx"
 * }
 *
 * {
 *   "event": "PowerFailureAlarm.Report",
 *   "time": 1663030738694,
 *   "msgid": "1663030738694",
 *   "data": {
 *     "state": "normal",
 *     "sound": 1,
 *     "battery": 4,
 *     "powerSupply": true,
 *     "alertDuration": 30,
 *     "alertInterval": 5,
 *     "version": "0608",
 *     "loraInfo": {
 *       "signal": -30,
 *       "gatewayId": "xxx",
 *       "gateways": 4
 *     }
 *   },
 *   "deviceId": "xxx"
 * }
 *
 * {
 *   "event": "PowerFailureAlarm.setOption",
 *   "time": 1663030338998,
 *   "msgid": "1663030338998",
 *   "data": {
 *     "alertDuration": 30,
 *     "alertInterval": 5,
 *     "loraInfo": {
 *       "signal": -34,
 *       "gatewayId": "xxx",
 *       "gateways": 4
 *     }
 *   },
 *   "deviceId": "xxx"
 * }
 */
export async function mqttPowerSensor(this: YoLinkPlatformAccessory, message): Promise<void> {
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
      case 'StatusChange':
      // falls through
      case 'Report':
        if (!device.data) {
          // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          if (this.contactService) {
            this.contactService.updateCharacteristic(platform.Characteristic.StatusFault, true);
          }
          break;
        }
        // if we received a message then device must be online
        device.data.online = true;
        // Merge received data into existing data object
        Object.assign(device.data.state, message.data);
        if (!message.data.reportAt) {
          // mqtt data does not include a report time, so merging the objects leaves current
          // unchanged. As we use this to control when to log new data, update the time string.
          device.data.reportAt = device.reportAtTime.toISOString();
        }
        this.logDeviceState(device, `Power OK: ${message.data.powerSupply}, ` +
          `State: ${message.data.state}${alertMsg}${batteryMsg} (MQTT: ${message.event})`);
        if (this.contactService) {
          this.contactService
            .updateCharacteristic(platform.Characteristic.ContactSensorState,
              (message.data.powerSupply)
                ? platform.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
                : platform.api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
            .updateCharacteristic(platform.Characteristic.StatusActive, true)
            .updateCharacteristic(platform.Characteristic.StatusFault, false);
        } else {
          this.outletService
            .updateCharacteristic(platform.Characteristic.On, device.data.state.powerSupply);
        }
        break;
      case 'setOption':
        // Ignore this as there is no status reported.
        platform.liteLog(mqttMessage + ' ' + JSON.stringify(message));
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttPowerSensor' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}