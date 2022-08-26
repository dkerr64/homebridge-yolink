/***********************************************************************
 * YoLink Garage Door device support
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initGarageDoor
 *
 */
export async function initGarageDoor(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const doorController = this.accessory.context.device;
  const doorSensor = this.accessory.context.device2;

  // Need to do some initialization of the second device attached to the
  // accessory.  The first device is handled in the main platformAccessory class.
  this.deviceId2 = doorSensor.deviceId;

  this.initializeDeviceVars(platform, doorSensor);

  if (doorSensor.hasBattery) {
    doorSensor.batteryService = accessory.getService('Battery 2')
                             || accessory.addService(platform.Service.Battery, 'Battery 2', 'battery2');
    doorSensor.batteryService
      .setCharacteristic(platform.Characteristic.Name, doorSensor.name)
      .setCharacteristic(platform.Characteristic.ChargingState, platform.api.hap.Characteristic.ChargingState.NOT_CHARGEABLE)
      .setCharacteristic(platform.Characteristic.BatteryLevel, 100);
    doorSensor.batteryService
      .getCharacteristic(platform.Characteristic.BatteryLevel).onGet(this.handleBatteryGet.bind(this, doorSensor));
  }

  this.garageService = accessory.getService(platform.Service.GarageDoorOpener)
                    || accessory.addService(platform.Service.GarageDoorOpener);
  this.garageService.setCharacteristic(platform.Characteristic.Name, doorController.name);
  this.garageService
    .getCharacteristic(platform.Characteristic.CurrentDoorState)
    .onGet(handleGet.bind(this, doorSensor));
  this.garageService
    .getCharacteristic(platform.Characteristic.TargetDoorState)
    .onGet(handleGet.bind(this, doorController))
    .onSet(handleSet.bind(this, doorController));
  this.garageService
    .getCharacteristic(platform.Characteristic.ObstructionDetected)
    .onGet( () => {
      return(false);
    });

  this.refreshDataTimer(handleGet.bind(this, doorController));
  this.refreshDataTimer(handleGet.bind(this, doorSensor));
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
async function handleGet(this: YoLinkPlatformAccessory, device, needSemaphore = true): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data. This function can be called with parameter that
  // indicates whether semaphore is needed... this allows for nesting with another
  // function that already holds the semaphore.
  // eslint-disable-next-line brace-style
  const releaseSemaphore = (needSemaphore) ? await device.semaphore.acquire() : async function() { return; };
  let rc = platform.api.hap.Characteristic.CurrentDoorState.CLOSED;
  try {
    if (await this.checkDeviceState(platform, device)) {
      if (device.type === 'GarageDoor' || device.type === 'Finger') {
        this.logDeviceState(device, `Garage Door or Finger: ${(device.data.battery)?'Battery: '+device.data.battery:'No data'}`);
        rc = 1;
      } else if (device.data.online && (device.data.state.state !== 'error')) {
        // device.type must be DoorSensor
        if (device.targetState) {
          // if targetState has value then it means that we have requested the door
          // to open or close but it has not reported back that it has completed yet.
          switch (device.targetState) {
            case 'open':
              rc = platform.api.hap.Characteristic.CurrentDoorState.OPENING;
              break;
            default:
              rc = platform.api.hap.Characteristic.CurrentDoorState.CLOSING;
          }
        } else {
          // if targetState has no value then door is at steady state
          // either open or closed.
          switch (device.data.state.state) {
            case 'open':
              rc = platform.api.hap.Characteristic.CurrentDoorState.OPEN;
              break;
            default:
              rc = platform.api.hap.Characteristic.CurrentDoorState.CLOSED;
          }
        }
        this.logDeviceState(device, `Sensor: ${device.data.state.state}, Battery: ${device.data.state.battery}, rc: ${rc}`);
      }
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in GarageDoor handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
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

async function handleSet(this: YoLinkPlatformAccessory, device, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const doorSensor = this.accessory.context.device2;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const doorState = await handleGet.bind(this)(doorSensor);
    // 0=open, 1=closed, 2=opening, 3=closing, 4=stopped(not used)
    if (value === 0 && (doorState === 0 || doorState === 2)) {
      platform.log.warn(`Request to open garage door (${device.deviceMsgName}) ignored, door already open or opening`);
    } else if (value === 1 && (doorState === 1 || doorState === 3)) {
      platform.log.warn(`Request to close garage door (${device.deviceMsgName}) ignored, door already closed or closing`);
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
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in GarageDoor handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}

/***********************************************************************
 * resetDoorState
 *
 */
async function resetDoorState(this: YoLinkPlatformAccessory, doorSensor, targetState): Promise<void> {
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
      .updateCharacteristic(platform.Characteristic.CurrentDoorState, await handleGet.bind(this, doorSensor, false)());
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in GarageDoor resetDoorState' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
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
 */
export async function mqttGarageDoor(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const event = message.event.split('.');
  // This accessory can have DoorSensor, Finger and GarageDoor(controller) devices attached
  // but only the DoorSensor should be sending us MQTT messages.
  if (event[0] !== 'DoorSensor') {
    platform.log.warn(`MQTT: ${message.event} for garage door not supported. ${platform.reportError}${JSON.stringify(message)}`);
    return;
  }
  // 'device2' is the sensor device...
  const doorSensor = this.accessory.context.device2;
  // serialize access to device data.
  const releaseSemaphore = await doorSensor.semaphore.acquire();
  try {
    clearTimeout(doorSensor.resetTimer);
    // no longer opening or closing...
    doorSensor.targetState = '';
    doorSensor.updateTime = Math.floor(new Date().getTime() / 1000) + doorSensor.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${doorSensor.deviceMsgName}`;
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
        // if we received a message then device must be online
        doorSensor.data.online = true;
        // Merge received data into existing data object
        if (doorSensor.data.state) {
          Object.assign(doorSensor.data.state, message.data);
          if (!message.data.reportAt) {
          // mqtt data does not include a report time, so merging the objects leaves current
          // unchanged, update the time string.
            doorSensor.data.reportAt = doorSensor.reportAtTime.toISOString();
          }
        }
        this.logDeviceState(doorSensor, `Contact: ${doorSensor.data.state.state}, ` +
                                        `Battery: ${doorSensor.data.state.battery} (MQTT: ${message.event})`);
        this.garageService
          .updateCharacteristic(platform.Characteristic.CurrentDoorState,
            (message.data.state === 'open')
              ? platform.api.hap.Characteristic.CurrentDoorState.OPEN
              : platform.api.hap.Characteristic.CurrentDoorState.CLOSED);
        break;
      case 'setOpenRemind':
        // Homebridge has no equivalent and message does not carry either contact state or battery
        // state fields, so there is nothing we can update.
        platform.verboseLog(mqttMessage + ' ' + JSON.stringify(message));
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttGarageDoor' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}