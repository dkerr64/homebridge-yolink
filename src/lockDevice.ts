/***********************************************************************
 * YoLink lock device support
 *
 * Copyright (c) 2022 David Kerr
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
  this.setLock = 'lock';
  this.setUnlock = 'unlock';

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
  this.refreshDataTimer(handleGet.bind(this));
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
 */
async function handleGet(this: YoLinkPlatformAccessory, requested = 'current'): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  handleGetBlocking.bind(this, requested)()
    .then((v) => {
      if (requested === 'current') {
        this.lockService.updateCharacteristic(this.platform.Characteristic.LockCurrentState, v);
      } else {
        this.lockService.updateCharacteristic(this.platform.Characteristic.LockTargetState, v);
      }
    })
    .catch(() => {
      this.platform.log.error(`Error in LockDevice handleGet [${requested}] ${this.platform.reportError}`);
    });
  // Return current state of the device pending completion of the blocking function
  if (requested === 'current') {
    return (3); // (3 = unknown)
  } else {
    return ((this.accessory.context.device.data.state === this.lockedState) ? 1 : 0);
  }
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
      rc = (device.data.state === this.lockedState) ? 1 : 0;
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
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
    // error will have been thrown in yolinkAPI if data not valid
    device.data.state = data.state;
    // Set the current state to the new state as reported by response from YoLink
    this.lockService
      .updateCharacteristic(platform.Characteristic.LockCurrentState, (data.state === this.lockedState) ? 1 : 0);
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in LockDevice handleGet' + platform.reportError + msg);
  } finally {
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
            (message.data.state === this.lockedState) ? 1 : 0);
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