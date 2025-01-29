/***********************************************************************
 * YoLink lock device support
 *
 * Copyright (c) 2022-2024 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initLockDevice
 *
 */
export async function initLockDevice(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  this.setMethod = 'setState';
  this.lockedState = 'locked';
  if (this.deviceType === 'LockV2') {
    this.setLock = { 'lock': 'locked' };
    this.setUnlock = { 'lock': 'unlocked' };
  } else {
    this.setLock = 'lock';
    this.setUnlock = 'unlock';
  }

  this.lockService = accessory.getService(platform.Service.LockMechanism)
    || accessory.addService(platform.Service.LockMechanism);
  this.lockService.setCharacteristic(platform.Characteristic.Name, device.name);

  // Lock Management is a no-op for us, but according to Apple documentation
  // implementation of it is mandatory. So we will implement as no-op!
  this.lockMgmtServer = accessory.getService(platform.Service.LockManagement)
    || accessory.addService(platform.Service.LockManagement);
  this.lockMgmtServer.getCharacteristic(platform.Characteristic.Version)
    .onGet(() => {
      platform.verboseLog('Lock Management Version characteristic onGet called');
      // return '1.0' as required by Apple specification docs.
      return ('1.0');
    });
  this.lockMgmtServer.getCharacteristic(platform.Characteristic.LockControlPoint)
    .onSet((value: CharacteristicValue) => {
      platform.verboseLog(`Lock Management LockControlPoint onSet called with '${value}'`);
      return;
    });

  // Door Bell service...
  this.doorBellService = accessory.getService(platform.Service.Doorbell)
    || accessory.addService(platform.Service.Doorbell);
  this.doorBellService.setCharacteristic(platform.Characteristic.Name, device.name);
  this.doorBellService.getCharacteristic(platform.Characteristic.ProgrammableSwitchEvent)
    .onGet(() => {
      platform.verboseLog('Lock door bell onGet called');
      return (platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    });

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGetBlocking.bind(this));

  // Once we have initial data, setup all the Homebridge handlers
  this.lockService.getCharacteristic(platform.Characteristic.LockCurrentState)
    .onGet(handleGet.bind(this, 'current'));
  this.lockService.getCharacteristic(platform.Characteristic.LockTargetState)
    .onGet(handleGet.bind(this, 'target'))
    .onSet(handleSet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * Example of message received
 *
 * {
 *   "code": "000000",
 *   "time": 1661884194053,
 *   "msgid": 1661884194053,
 *   "method": "Lock.getState",
 *   "desc": "Success",
 *   "data": {
 *     "state": "locked",
 *     "battery": 4,
 *     "rlSet": "left",
 *     "loraInfo": {
 *       "signal": -26,
 *       "gatewayId": "abcdef1234567890",
 *       "gateways": 1
 *     }
 *   }
 * }
 *
 * Newer "LockV2" devices report..
 * {
 *  "code": "000000",
 *  "time": 1731886360708,
 *  "msgid": 1731886360708,
 *  "method": "LockV2.getState",
 *  "desc": "Success",
 *  "data": {
 *    "state": {
 *      "lock": "unlocked",
 *      "door": "open"
 *    },
 *    "battery": 3,
 *    "alert": {
 *      "type": "UnLockFailed",
 *      "source": "Fingerprint"
 *    },
 *    "attributes": {
 *      "openRemind": 0,
 *      "rlSet": "left",
 *      "soundLevel": 3,
 *      "autoLock": 10,
 *      "enableSetButton": true
 *    },
 *    "version": "1607",
 *    "tz": 0,
 *    "loraP2PHash": 166,
 *    "loraInfo": {
 *      "netId": "010201",
 *      "devNetType": "A",
 *      "signal": -21,
 *      "gatewayId": "<sanitized>",
 *      "gateways": 1
 *    }
 *  }
 * }
 */
async function handleGet(this: YoLinkPlatformAccessory, requested = 'current'): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  handleGetBlocking.bind(this, requested)()
    .then((v) => {
      if (requested === 'current') {
        this.lockService.updateCharacteristic(platform.Characteristic.LockCurrentState, v);
      } else {
        this.lockService.updateCharacteristic(platform.Characteristic.LockTargetState, v);
      }
    });
  // Return current state of the device pending completion of the blocking function
  return (((this.accessory.context.device.data?.state?.lock ?? this.accessory.context.device.data.state) === this.lockedState) ? 1 : 0);
}

async function handleGetBlocking(this: YoLinkPlatformAccessory, requested = 'current'): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  let rc = (requested === 'current') ? 3 : 0;
  // rc 0 = unsecured, 1 = secured, (and for current state only... 2 = jammed, 3 = unknown)
  try {
    if (await this.checkDeviceState(platform, device)) {
      const batteryMsg = (device.hasBattery) ? `, Battery: ${device.data.battery}` : '';
      this.logDeviceState(device, `Lock: ${device.data.state}${batteryMsg}`);
      // Newer V2 devices wrap lock state within object
      rc = ((device.data.state?.lock ?? device.data.state) === this.lockedState) ? 1 : 0;
    } else {
      platform.log.error(`[${device.deviceMsgName}] Device offline or other error`);
      device.errorState = true;
    }

  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in LockDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return (rc);
}

/***********************************************************************
 * handleSet
 *
 * This is an example of JSON object returned.
 *
 * {
 *   "code":"000000",
 *   "time":1662008265011,
 *   "msgid":1662008265011,
 *   "method":"Lock.setState",
 *   "desc":"Success",
 *   "data":{
 *     "state":"locked",
 *     "loraInfo":{
 *       "signal":-45,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     },
 *     "source":"app"
 *   }
 * }
 *
 */
async function handleSet(this: YoLinkPlatformAccessory, value: CharacteristicValue): Promise<void> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  handleSetBlocking.bind(this)(value);
}

async function handleSetBlocking(this: YoLinkPlatformAccessory, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const newState = (value === 1) ? this.setLock : this.setUnlock;
    const data = (await platform.yolinkAPI.setDeviceState(platform, device, { 'state': newState }, this.setMethod))?.data;
    if (data) {
      if (typeof device.data.state === 'object') {
        Object.assign(device.data.state, data.state);
      } else {
        device.data.state = data.state;
      }
    }
    // Set the current state to the new state as reported by response from YoLink
    // Calling updateCharacteristic within set handler seems to fail, new value is not accepted.  Workaround is
    // to request the update after short delay (say 50ms) to allow homebridge/homekit to complete the set handler.
    setTimeout(() => {
      this.lockService
        .updateCharacteristic(platform.Characteristic.LockCurrentState,
          ((device.data.state?.lock ?? device.data.state) === this.lockedState) ? 1 : 0);
    }, 50);
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in LockDevice handleGet' + platform.reportError + msg);
  } finally {
    // Avoid flooding YoLink device with rapid succession of requests.
    const sleep = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
    await sleep(250);
    releaseSemaphore();
  }
}

/***********************************************************************
 * mqttLockDevice
 *
 * Example of message received...
 * {
 *   "event":"Lock.Alert",
 *   "time":1663015501183,
 *   "msgid":"1663015501182",
 *   "data":{
 *     "state":"unlocked",
 *     "battery":4,
 *     "alertType":"unlock",
 *     "source":"manual",
 *     "loraInfo":{
 *       "signal":-62,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * And also...
 * {
 *   "event":"Lock.StatusChange",
 *   "time":1663015557598,
 *   "msgid":"1663015557597",
 *   "data":{
 *     "state":"locked",
 *     "battery":4,
 *     "rlSet":"left",
 *       "loraInfo":{
 *       "signal":-61,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * setState used when YoLink app changes the lock status...
 * {
 *   "event":"Lock.setState",
 *   "time":1663016513902,
 *   "msgid":"1663016513901",
 *   "data":{
 *     "state":"locked",
 *     "loraInfo":{
 *       "signal":-68,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     },
 *     "source":"app"
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * When a PIN unlocks...
 * {
 *   "event":"Lock.Alert",
 *   "time":1663016954717,
 *   "msgid":"1663016954715",
 *   "data":{
 *     "state":"unlocked",
 *     "battery":4,
 *     "alertType":"unlock",
 *     "source":"pwd",
 *     "user":"admin",
 *     "loraInfo":{
 *       "signal":-67,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * When door bell button pressed...
 * {
 *   "event":"Lock.Alert",
 *   "time":1663069662083,
 *   "msgid":"1663069662077",
 *   "data":{
 *     "state":"unlocked",
 *     "battery":4,
 *     "alertType":"bell",
 *     "loraInfo":{
 *       "signal":-65,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * Some MQTT messages cannot be supported by apple home, e.g. getUsers, setPassword, addTemporaryPWD.
 * We just ignore these.  Example message... (and yes, pwd is obscured in the actual msg)
 * {
 *   "event":"Lock.getUsers",
 *   "time":1663507654044,
 *   "msgid":"1663507654043",
 *   "data":{
 *     "offset":0,
 *     "limit":5,
 *     "total":3,
 *     "items":[
 *       {
 *         "index":0,
 *         "start":"2022-09-18T13:00:00.043Z",
 *         "end":"2248-10-09T06:00:00.043Z",
 *         "pwd":"1**4"
 *       },
 *       {
 *         "index":1,
 *         "start":"2022-09-18T13:00:00.043Z",
 *         "end":"2248-10-09T06:00:00.043Z",
 *         "pwd":"1**4"
 *       },
 *       {
 *         "index":2,
 *         "start":"2022-09-18T13:00:00.043Z",
 *         "end":"2248-10-09T06:00:00.043Z",
 *         "pwd":"1**4"
 *       }
 *     ]
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * Newer "LockV2" example...
 * {
 *  "event": "LockV2.setState",
 *  "time": 1731886690801,
 *  "msgid": "1731886690800",
 *  "data": {
 *    "state": {
 *      "lock": "unlocked"
 *    },
 *    "loraInfo": {
 *      "netId": "010201",
 *      "devNetType": "A",
 *      "signal": -25,
 *      "gatewayId": "abcdef1234567890",
 *      "gateways": 1
 *    },
 *    "source": "app"
 *  },
 *  "deviceId": "abcdef1234567890"
 * }
 */
export async function mqttLockDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
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
      case 'Report':
      // falls through
      case 'getState':
      // falls through
      case 'setState':
      // falls through
      case 'Alert':
      // falls through
      case 'StatusChange':
        if (!device.data) {
          // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          break;
        }
        // Merge received data into existing data object
        Object.assign(device.data, message.data);
        if (!message.data.reportAt) {
          // mqtt data does not include a report time, so merging the objects leaves current
          // unchanged, update the time string.
          device.data.reportAt = device.reportAtTime.toISOString();
        }
        this.logDeviceState(device, `Lock: ${message.data.state}${alertMsg}${batteryMsg} (MQTT: ${message.event})`);
        if (message.data.alertType === 'bell') {
          this.doorBellService
            .updateCharacteristic(platform.Characteristic.ProgrammableSwitchEvent,
              platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
        }
        this.lockService
          .updateCharacteristic(platform.Characteristic.LockCurrentState,
            ((device.data.state?.lock ?? device.data.state) === this.lockedState) ? 1 : 0);
        break;
      case 'getUsers':
      // falls through
      case 'addPassword':
      // falls through
      case 'delPassword':
      // falls through
      case 'updatePassword':
      // falls through
      case 'clearPassword':
      // falls through
      case 'addTemporaryPWD':
        // Homebridge has no equivalent and message does not carry either lock state or battery
        // state fields, so there is nothing we can update.
        platform.liteLog(mqttMessage + ' ' + JSON.stringify(message));
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttLockDevice' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}