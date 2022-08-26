/***********************************************************************
 * YoLink Garage Door device support
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import Semaphore from 'semaphore-promise';
import { YoLinkPlatformAccessory } from './platformAccessory';
import { deviceFeatures} from './deviceHandlers';

/***********************************************************************
 * initGarageDoor
 *
 */
export async function initGarageDoor(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const controller = this.accessory.context.device;
  const sensor = this.accessory.context.device2;

  // Need to do some initialization of the second device attached to the
  // accessory.  The first device is handled in the main platformAccessory class.
  this.deviceId2 = sensor.deviceId;
  sensor.deviceMsgName = `${sensor.name} (${sensor.deviceId})`;
  sensor.lastReportAtTime = 0;
  sensor.config = platform.config.devices[sensor.deviceId] ?? {};
  sensor.config.refreshAfter ??= (platform.config.refreshAfter ??= 3600);
  sensor.config.enableExperimental ??= (platform.config.enableExperimental ??= false);
  sensor.hasBattery = deviceFeatures[sensor.type].hasBattery;
  if (sensor.hasBattery) {
    sensor.batteryService = accessory.getService('Battery 2')
                         || accessory.addService(platform.Service.Battery, 'Battery 2', 'battery2');
    sensor.batteryService
      .setCharacteristic(platform.Characteristic.Name, sensor.name)
      .setCharacteristic(platform.Characteristic.ChargingState, platform.api.hap.Characteristic.ChargingState.NOT_CHARGEABLE)
      .setCharacteristic(platform.Characteristic.BatteryLevel, 100);
    sensor.batteryService
      .getCharacteristic(platform.Characteristic.BatteryLevel).onGet(this.handleBatteryGet.bind(this, sensor));
  }
  // We need to serialize requests to YoLink API for each device.  Multiple threads
  // can request state updates for a device at the same time.  This would not be good,
  // so we need a semaphore to make sure we don't send a 2nd request to the same
  // device before prior one has completed.
  sensor.semaphore = new Semaphore();

  this.garageService = accessory.getService(platform.Service.GarageDoorOpener)
                    || accessory.addService(platform.Service.GarageDoorOpener);
  this.garageService.setCharacteristic(platform.Characteristic.Name, controller.name);
  this.garageService
    .getCharacteristic(platform.Characteristic.CurrentDoorState)
    .onGet(handleGet.bind(this, sensor));
  this.garageService
    .getCharacteristic(platform.Characteristic.TargetDoorState)
    .onGet(handleGet.bind(this, controller))
    .onSet(handleSet.bind(this, controller));
  this.garageService
    .getCharacteristic(platform.Characteristic.ObstructionDetected)
    .onGet( () => {
      return(false);
    });

  this.refreshDataTimer(handleGet.bind(this, controller));
  this.refreshDataTimer(handleGet.bind(this, sensor));
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
async function handleGet(this: YoLinkPlatformAccessory, device): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  let rc = platform.api.hap.Characteristic.CurrentDoorState.CLOSED;
  try {
    if (await this.checkDeviceState(platform, device)) {
      if (device.type === 'GarageDoor' || device.type === 'Finger') {
        this.logDeviceState(device, `Garage Door or Finger: ${(device.data.battery)?'Battery: '+device.data.battery:'No data'}`);
        rc = (device.targetState === 'open') ? 0 : 1;
      } else if (device.data.online && (device.data.state.state !== 'error')) {
        // device.type must be DoorSensor
        rc = (device.data.state.state === 'opening') ? platform.api.hap.Characteristic.CurrentDoorState.OPENING :
          (device.data.state.state === 'open') ? platform.api.hap.Characteristic.CurrentDoorState.OPEN :
            (device.data.state.state === 'closing') ? platform.api.hap.Characteristic.CurrentDoorState.CLOSING :
              platform.api.hap.Characteristic.CurrentDoorState.CLOSED;
        this.logDeviceState(device, `Garage Door Sensor: ${device.data.state.state}, Battery: ${device.data.state.battery}`);
      } else {
        platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
      }
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
  const sensor = this.accessory.context.device2;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const doorState = await handleGet.bind(this)(sensor);
    // 0=open, 1=closed, 2=opening, 3=closing, 4=stopped(not used)
    if (value === 0 && (doorState === 0 || doorState === 2)) {
      platform.log.warn(`Request to open garage door (${device.deviceMsgName}) ignored, door already open or opening`);
    } else if (value === 1 && (doorState === 1 || doorState === 3)) {
      platform.log.warn(`Request to close garage door (${device.deviceMsgName}) ignored, door already closed or closing`);
    } else {
      if (value === 0) {
        sensor.data.state.state = 'opening';
        this.garageService
          .updateCharacteristic(platform.Characteristic.CurrentDoorState, platform.api.hap.Characteristic.CurrentDoorState.OPENING);
      } else {
        sensor.data.state.state = 'closing';
        this.garageService
          .updateCharacteristic(platform.Characteristic.CurrentDoorState, platform.api.hap.Characteristic.CurrentDoorState.CLOSING);
      }
      device.targetState = (value === 0) ? 'open' : 'closed';
      await platform.yolinkAPI.setDeviceState(platform, device, undefined, 'toggle');
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in GarageDoor handleGet' + platform.reportError + msg);
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
  const device = this.accessory.context.device2;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    // Battery is checked in main MQTT handler before coming here... but only for
    // one device attached to the accessory... it only does the "controller"
    this.updateBatteryInfo.bind(this, device)();
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
        if (device.data.state) {
          Object.assign(device.data.state, message.data);
          if (!message.data.reportAt) {
          // mqtt data does not include a report time, so merging the objects leaves current
          // unchanged, update the time string.
            device.data.reportAt = device.reportAtTime.toISOString();
          }
        }
        this.logDeviceState(device, `Contact: ${device.data.state.state}, Battery: ${device.data.state.battery} (MQTT: ${message.event})`);
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