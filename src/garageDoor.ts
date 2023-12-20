/***********************************************************************
 * YoLink Garage Door device support
 *
 * Copyright (c) 2022-2023 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initGarageDoor
 *
 */
export async function initGarageDoor(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const doorController: YoLinkDevice = accessory.context.device;
  const doorSensor: YoLinkDevice = accessory.context.device2;

  // Need to do some initialization of the second device attached to the
  // accessory.  The first device is handled in the main platformAccessory class.
  this.deviceId2 = doorSensor.deviceId;
  this.currentState = undefined;
  this.initializeDeviceVars(platform, doorSensor);

  if (doorSensor.hasBattery) {
    doorSensor.batteryService = accessory.getService('Battery 2')
      || accessory.addService(platform.Service.Battery, 'Battery 2', 'battery2');
    doorSensor.batteryService
      .setCharacteristic(platform.Characteristic.Name, doorSensor.name)
      .setCharacteristic(platform.Characteristic.ChargingState, platform.api.hap.Characteristic.ChargingState.NOT_CHARGEABLE)
      .setCharacteristic(platform.Characteristic.BatteryLevel, 100);
  }

  this.garageService = accessory.getService(platform.Service.GarageDoorOpener)
    || accessory.addService(platform.Service.GarageDoorOpener);
  this.garageService.setCharacteristic(platform.Characteristic.Name, doorController.name);
  this.garageService.getCharacteristic(platform.Characteristic.ObstructionDetected)
    .onGet(() => {
      return (false);
    });

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGetBlocking.bind(this, doorSensor), 'sensor');
  // above must await because we use doorSensor in handleGet for doorController
  await this.refreshDataTimer(handleGetBlocking.bind(this, doorController));

  // Once we have initial data, setup all the Homebridge handlers
  doorSensor.batteryService?.getCharacteristic(platform.Characteristic.BatteryLevel)
    .onGet(this.handleBatteryGet.bind(this, doorSensor));
  this.garageService.getCharacteristic(platform.Characteristic.CurrentDoorState)
    .onGet(handleGet.bind(this, doorSensor));
  this.garageService.getCharacteristic(platform.Characteristic.TargetDoorState)
    .onGet(handleGet.bind(this, doorController))
    .onSet(handleSet.bind(this, doorController));
}

/***********************************************************************
 * handleGet
 *
 * Example for Garage Door Sensor
 * {
 *   "online":true,
 *   "state":{
 *     "alertInterval":30,
 *     "battery":4,
 *     "delay":10,
 *     "openRemindDelay":600,
 *     "state":"closed",
 *     "version":"060d",
 *     "stateChangedAt":1661375346592
 *   },
 *   "deviceId":"d88b4c0200067636",
 *   "reportAt":"2022-08-25T01:08:19.288Z"
 * }
 *
 */
async function handleGet(this: YoLinkPlatformAccessory, device: YoLinkDevice): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  handleGetBlocking.bind(this, device, true)()
    .then((v) => {
      this.garageService.updateCharacteristic(platform.Characteristic.CurrentDoorState, v);
    });
  // Return current state of the device pending completion of the blocking function
  return (this.currentState);
}

async function handleGetBlocking(this: YoLinkPlatformAccessory, device: YoLinkDevice, needSemaphore = true): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const doorSensor: YoLinkDevice = this.accessory.context.device2;
  // serialize access to device data. This function can be called with parameter that
  // indicates whether semaphore is needed... this allows for nesting with another
  // function that already holds the semaphore.
  // eslint-disable-next-line brace-style
  const releaseSemaphore = (needSemaphore) ? await device.semaphore.acquire() : function () { return; };
  let rc = platform.api.hap.Characteristic.CurrentDoorState.CLOSED;
  try {
    if (await this.checkDeviceState(platform, device)) {
      // 'device' may equal device2, in either case we want to test targetState for the doorSensor
      if (doorSensor.targetState) {
        // if targetState has value then it means that we have requested the door
        // to open or close but it has not reported back that it has completed yet.
        switch (doorSensor.targetState) {
          case 'open':
            rc = platform.api.hap.Characteristic.CurrentDoorState.OPENING;
            break;
          default:
            rc = platform.api.hap.Characteristic.CurrentDoorState.CLOSING;
        }
      } else {
        // if targetState has no value then door is at steady state
        // either open or closed.
        switch (doorSensor.data.state.state) {
          case 'open':
            rc = platform.api.hap.Characteristic.CurrentDoorState.OPEN;
            break;
          default:
            rc = platform.api.hap.Characteristic.CurrentDoorState.CLOSED;
        }
      }
      if (device.type === 'GarageDoor' || device.type === 'Finger') {
        // return value for target state must be open or closed, not opening or closing.
        // 0=open, 1=closed, 2=opening, 3=closing, 4=stopped(not used)
        rc = (rc > 1) ? rc - 2 : rc;
        this.logDeviceState(device, `Garage Door or Finger: ${(device.data.battery) ? 'Battery: ' + device.data.battery : ''}, rc: ${rc}`);
      } else {
        this.logDeviceState(device, `Sensor: ${device.data.state.state}, Battery: ${device.data.state.battery}, rc: ${rc}`);
      }
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in GarageDoor handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  this.currentState = rc;
  return (rc);
}

/***********************************************************************
 * handleSet
 *
 * Example JSON returned...
 *
 * {
 *   "code":"000000",
 *   "time":1661293272749,
 *   "msgid":1661293272749,
 *   "method":"GarageDoor.toggle",
 *   "desc":"Success",
 *   "data":{
 *     "stateChangedAt":1661293272748,
 *     "loraInfo":{
 *       "signal":-70,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   }
 * }
 *
 * {
 *   "code":"000000",
 *   "time":1661360828271,
 *   "msgid":1661360828271,
 *   "method":"Finger.toggle",
 *   "desc":"Success",
 *   "data":{
 *     "battery":4,
 *     "version":"0803",
 *     "time":"2022-07-24T09:06:15.000Z",
 *     "loraInfo":{
 *       "signal":-8,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   }
 * }
 */

async function handleSet(this: YoLinkPlatformAccessory, device: YoLinkDevice, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const doorSensor: YoLinkDevice = this.accessory.context.device2;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const doorState = await handleGetBlocking.bind(this)(doorSensor);
    // 0=open, 1=closed, 2=opening, 3=closing, 4=stopped(not used)
    if (value === 0 && (doorState === 0 || doorState === 2)) {
      platform.log.warn(`Request to open garage door (${device.deviceMsgName}) ignored, door already open or opening`);
      this.garageService
        .updateCharacteristic(platform.Characteristic.TargetDoorState, platform.api.hap.Characteristic.TargetDoorState.OPEN);
    } else if (value === 1 && (doorState === 1 || doorState === 3)) {
      platform.log.warn(`Request to close garage door (${device.deviceMsgName}) ignored, door already closed or closing`);
      this.garageService
        .updateCharacteristic(platform.Characteristic.TargetDoorState, platform.api.hap.Characteristic.TargetDoorState.CLOSED);
    } else {
      clearTimeout(doorSensor.resetTimer);
      if (value === 0) {
        this.garageService
          .updateCharacteristic(platform.Characteristic.CurrentDoorState, platform.api.hap.Characteristic.CurrentDoorState.OPENING);
      } else {
        this.garageService
          .updateCharacteristic(platform.Characteristic.CurrentDoorState, platform.api.hap.Characteristic.CurrentDoorState.CLOSING);
      }
      doorSensor.targetState = (value === 0) ? 'open' : 'closed';
      await platform.yolinkAPI.setDeviceState(platform, device, undefined, 'toggle');
      platform.verboseLog(`Set garage door timer for ${doorSensor.timeout} seconds with targetState '${doorSensor.targetState}'`);
      doorSensor.resetTimer = setTimeout(resetDoorState.bind(this, doorSensor, doorSensor.targetState), doorSensor.timeout * 1000);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in GarageDoor handleGet' + platform.reportError + msg);
  } finally {
    // Avoid flooding YoLink device with rapid succession of requests.
    const sleep = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
    await sleep(250);
    releaseSemaphore();
  }
}

/***********************************************************************
 * resetDoorState
 *
 */
async function resetDoorState(this: YoLinkPlatformAccessory, doorSensor: YoLinkDevice, targetState): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await doorSensor.semaphore.acquire();
  try {
    platform.verboseLog(`Garage Door Timer fired, targetState: ${targetState}, doorSensor targetState: ${doorSensor.targetState}`);
    if (targetState === 'open' && doorSensor.targetState === 'open') {
      platform.log.warn(`Garage door open (${doorSensor.deviceMsgName}) did not complete in time, ` +
        `reset state to ${doorSensor.data.state.state}`);
    } else if (targetState === 'closed' && doorSensor.targetState === 'closed') {
      platform.log.warn(`Garage door close (${doorSensor.deviceMsgName}) did not complete in time, ` +
        `reset state to ${doorSensor.data.state.state}`);
    }
    // no longer opening or closing...
    doorSensor.targetState = '';
    // reset updateTime to now to force get handler to query YoLink servers, just in case
    // things have got out-of-sync.
    doorSensor.updateTime = Math.floor(new Date().getTime() / 1000);
    this.garageService
      .updateCharacteristic(platform.Characteristic.CurrentDoorState, await handleGetBlocking.bind(this, doorSensor, false)());
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in GarageDoor resetDoorState' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}

/***********************************************************************
 * mqttGarageDoor
 *
 * {
 *   "event":"DoorSensor.Alert",
 *   "time":1661360844971,
 *   "msgid":"1661360844970",
 *   "data":{
 *     "state":"open",
 *     "alertType":"normal",
 *     "battery":4,
 *     "version":"060d",
 *     "loraInfo":{
 *       "signal":-24,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":2
 *     },
 *     "stateChangedAt":1661360844970
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * {
 *   "event":"DoorSensor.Report",
 *   "time":1670100848930,"msgid":"1670100848926",
 *   "data":{
 *     "state":"closed",
 *     "alertType":"normal",
 *     "battery":4,
 *     "delay":0,
 *     "version":"060d",
 *     "openRemindDelay":0,
 *     "alertInterval":0,
 *     "loraInfo":{
 *       "signal":-95,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * {
 *   "event":"GarageDoor.Report",
 *   "time":1673032650586,
 *   "msgid":"1673032650584",
 *   "data":{
 *     "version":"060a",
 *     "time":null,
 *     "loraInfo":{
 *       "signal":-70,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * {
 *   "event": "GarageDoor.setState",
 *   "time": 1702966991160,
 *   "msgid": "1702966991159",
 *   "data": {
 *     "state": "closed",
 *     "stateChangedAt": 1702966991159,
 *     "loraInfo": {
 *       "netId": "010202",
 *       "signal": -34,
 *       "gatewayId": "abcdef1234567890",
 *       "gateways": 1
 *     }
 *   },
 *   "deviceId": "abcdef1234567890"
 * }
 */
export async function mqttGarageDoor(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // 'device' is GarageDoor or Finger controller. 'device2' is the DoorSensor...
  const device: YoLinkDevice = this.accessory.context.device;
  const doorSensor: YoLinkDevice = this.accessory.context.device2;
  // serialize access to device data.
  const releaseSemaphore = await doorSensor.semaphore.acquire();
  try {
    let mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const batteryMsg = (doorSensor.hasBattery && message.data?.battery) ? `, Battery: ${message.data?.battery}` : '';
    const alertMsg = (message.data?.alertType) ? `, Alert: ${message.data?.alertType}` : '';
    const event = message.event.split('.');
    switch (event[0]) {
      case 'DoorSensor':
        clearTimeout(doorSensor.resetTimer);
        // no longer opening or closing...
        doorSensor.targetState = '';
        doorSensor.updateTime = Math.floor(new Date().getTime() / 1000) + doorSensor.config.refreshAfter;
        mqttMessage = `MQTT: ${message.event} for device ${doorSensor.deviceMsgName}`;
        // Battery is checked in main MQTT handler before coming here... but only for
        // one device attached to the accessory... it only does the "controller"
        this.updateBatteryInfo.bind(this, doorSensor)();
        switch (event[1]) {
          case 'Alert':
          // falls through
          case 'Report':
          // falls through
          case 'StatusChange':
            if (doorSensor.data === undefined) {
              // in rare conditions (error conditions returned from YoLink) data object will be undefined.
              platform.log.warn(`Device ${doorSensor.deviceMsgName} has no data field, is device offline?`);
              break;
            }
            // Merge received data into existing data object
            if (doorSensor.data.state) {
              Object.assign(doorSensor.data.state, message.data);
              if (!message.data.reportAt) {
                // mqtt data does not include a report time, so merging the objects leaves current
                // unchanged, update the time string.
                doorSensor.data.reportAt = doorSensor.reportAtTime.toISOString();
              }
            }
            this.logDeviceState(doorSensor, `DoorSensor: ${doorSensor.data.state.state}${alertMsg}${batteryMsg} (MQTT: ${message.event})`);
            this.garageService
              .updateCharacteristic(platform.Characteristic.CurrentDoorState,
                (message.data.state === 'open')
                  ? platform.api.hap.Characteristic.CurrentDoorState.OPEN
                  : platform.api.hap.Characteristic.CurrentDoorState.CLOSED);
            this.garageService
              .updateCharacteristic(platform.Characteristic.TargetDoorState,
                (message.data.state === 'open')
                  ? platform.api.hap.Characteristic.TargetDoorState.OPEN
                  : platform.api.hap.Characteristic.TargetDoorState.CLOSED);
            break;
          case 'setOpenRemind':
            // Homebridge has no equivalent and message does not carry either contact state or battery
            // state fields, so there is nothing we can update.
            platform.liteLog(mqttMessage + ' ' + JSON.stringify(message, null, 2));
            break;
          default:
            platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message, null, 2));
        }
        break;
      case 'GarageDoor':
        switch (event[1]) {
          case 'setState':
            if (!device.data) {
              // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
              platform.log.warn(`[${device.deviceMsgName}] Device has no data field, is device offline?`);
              break;
            }
            // Merge received data into existing data object
            if (device.data.state) {
              Object.assign(device.data.state, message.data);
              if (!message.data.reportAt) {
                // mqtt data does not include a report time, so merging the objects leaves current
                // unchanged, update the time string.
                device.data.reportAt = device.reportAtTime.toISOString();
              }
            }
            this.logDeviceState(device, `GarageDoor: ${message.data.state} (MQTT: ${message.event})`);
            this.garageService
              .updateCharacteristic(platform.Characteristic.TargetDoorState,
                (message.data.state === 'open')
                  ? platform.api.hap.Characteristic.TargetDoorState.OPEN
                  : platform.api.hap.Characteristic.TargetDoorState.CLOSED);
            break;
          case 'Report':
            // message does not carry any state state or battery fields, so there is nothing we can update.
            platform.liteLog(mqttMessage + ' ' + JSON.stringify(message, null, 2));
            break;
          default:
            platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message, null, 2));
            break;
        }
        break;
      case 'Finger':
        switch (event[1]) {
          case 'Report':
            // message does not carry any state state or battery fields, so there is nothing we can update.
            platform.liteLog(mqttMessage + ' ' + JSON.stringify(message, null, 2));
            break;
          default:
            platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message, null, 2));
            break;
        }
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message, null, 2));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttGarageDoor' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}