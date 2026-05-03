/***********************************************************************
 * YoLink SprinklerV2 device support
 *
 * YoLink YS4103-UC Smart Sprinkler Timer (single-zone, battery, flow meter)
 *
 * Copyright (c) 2022-2024 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initSprinklerV2Device
 *
 */
export async function initSprinklerV2Device(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  this.valveService = accessory.getService(platform.Service.Valve)
    || accessory.addService(platform.Service.Valve);
  this.valveService.setCharacteristic(platform.Characteristic.Name, device.name);

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGetBlocking.bind(this, 'valve'));

  // Once we have initial data, setup all the Homebridge handlers
  this.valveService.getCharacteristic(platform.Characteristic.Active)
    .onGet(handleGet.bind(this, 'valve'))
    .onSet(handleSet.bind(this));
  this.valveService.getCharacteristic(platform.Characteristic.InUse)
    .onGet(handleGet.bind(this, 'flowing'));
  this.valveService.getCharacteristic(platform.Characteristic.ValveType)
    .onGet(handleType.bind(this));
  this.valveService.getCharacteristic(platform.Characteristic.RemainingDuration)
    .setProps({ maxValue: 86400 })
    .onGet(handleGet.bind(this, 'remaining'));
  this.valveService.getCharacteristic(platform.Characteristic.SetDuration)
    .setProps({ maxValue: 86400, minStep: 60 })
    .onGet(handleGet.bind(this, 'setDuration'))
    .onSet(handleSetDuration.bind(this));
}

/***********************************************************************
 * computeCachedValue
 *
 * Compute characteristic value from whatever is currently cached on
 * device.data without making an API call.
 *
 * Verified YS4103-UC SprinklerV2.getState response...
 * {
 *   "code": "000000",
 *   "time": 1776989413349,
 *   "msgid": 1776989413349,
 *   "method": "SprinklerV2.getState",
 *   "desc": "Success",
 *   "data": {
 *     "state": {
 *       "running": false,
 *       "noWaterWhenRunning": false
 *     },
 *     "battery": 4,
 *     "version": "0303",
 *     "tz": -5,
 *     "waterMode": "schedule",
 *     "attributes": {
 *       "meterUnit": 0,
 *       "meterStepFactor": 10,
 *       "manualWater": { "type": "duration", "value": 240 },
 *       "waterDelay": { "type": "manual", "duration": 0 }
 *     },
 *     "running": {
 *       "mode": "manual",
 *       "total": { "type": "duration", "value": 240 },
 *       "progress": 0
 *     },
 *     "waterFlowing": 0,
 *     "loraP2PHash": 0,
 *     "loraInfo": { ... }
 *   }
 * }
 *
 * manualWater.value and running.total.value are in minutes; HomeKit
 * SetDuration / RemainingDuration are in seconds.
 */
function computeCachedValue(this: YoLinkPlatformAccessory, devSensor: string): CharacteristicValue {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  const running = device.data?.state?.running === true;
  const waterFlowing = (typeof device.data?.waterFlowing === 'number')
    ? device.data.waterFlowing > 0
    : running;
  switch (devSensor) {
    case 'valve':
      return ((running)
        ? platform.api.hap.Characteristic.Active.ACTIVE
        : platform.api.hap.Characteristic.Active.INACTIVE);
    case 'flowing':
      return ((waterFlowing)
        ? platform.api.hap.Characteristic.InUse.IN_USE
        : platform.api.hap.Characteristic.InUse.NOT_IN_USE);
    case 'remaining':
      if (running && device.data?.running?.total?.type === 'duration') {
        const remain = (device.data.running.total.value ?? 0) - (device.data.running.progress ?? 0);
        return Math.max(0, remain * 60);
      }
      return 0;
    case 'setDuration':
      if (device.data?.attributes?.manualWater?.type === 'duration') {
        return Math.max(0, (device.data.attributes.manualWater.value ?? 0) * 60);
      }
      return 0;
    default:
      platform.log.error(`Unexpected device sensor type '${devSensor}' for ${device.deviceMsgName}`);
      return 0;
  }
}

/***********************************************************************
 * handleGet
 *
 */
async function handleGet(this: YoLinkPlatformAccessory, devSensor = 'valve'): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  handleGetBlocking.bind(this, devSensor)()
    .then((v) => {
      switch (devSensor) {
        case 'valve':
          this.valveService.updateCharacteristic(platform.Characteristic.Active, v);
          break;
        case 'flowing':
          this.valveService.updateCharacteristic(platform.Characteristic.InUse, v);
          break;
        case 'remaining':
          this.valveService.updateCharacteristic(platform.Characteristic.RemainingDuration, v);
          break;
        case 'setDuration':
          this.valveService.updateCharacteristic(platform.Characteristic.SetDuration, v);
          break;
        default:
          platform.log.error(`Unexpected device sensor type '${devSensor}' for ${device.deviceMsgName}`);
          break;
      }
    });
  return computeCachedValue.bind(this)(devSensor);
}

async function handleGetBlocking(this: YoLinkPlatformAccessory, devSensor = 'valve'): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  let rc: CharacteristicValue = platform.api.hap.Characteristic.Active.INACTIVE;
  try {
    if (await this.checkDeviceState(platform, device)) {
      this.valveService
        .updateCharacteristic(platform.Characteristic.StatusFault, false);
      rc = computeCachedValue.bind(this)(devSensor);
      this.logDeviceState(device, `Running: ${device.data?.state?.running}, waterFlowing: ${device.data?.waterFlowing},` +
        ` Battery: ${device.data?.battery}`);
    } else {
      platform.log.error(`[${device.deviceMsgName}] Device offline or other error`);
      device.errorState = true;
      this.valveService
        .updateCharacteristic(platform.Characteristic.StatusFault, true);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SprinklerV2Device handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return rc;
}

/***********************************************************************
 * handleSet
 *
 * Turn valve on/off.  Sends SprinklerV2.setState { running: true|false }.
 */
async function handleSet(this: YoLinkPlatformAccessory, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const running = (value === platform.api.hap.Characteristic.Active.ACTIVE);
    const data = (await platform.yolinkAPI.setDeviceState(platform, device, { running }))?.data;
    if (data) {
      if (typeof device.data.state === 'object') {
        Object.assign(device.data.state, data.state);
      } else {
        device.data.state = data.state;
      }
      if (data.running) {
        device.data.running = data.running;
      }
    }
    // Calling updateCharacteristic within set handler seems to fail, new value is not accepted.  Workaround is
    // to request the update after short delay (say 50ms) to allow homebridge/homekit to complete the set handler.
    setTimeout(() => {
      this.valveService
        .updateCharacteristic(platform.Characteristic.Active, computeCachedValue.bind(this)('valve'))
        .updateCharacteristic(platform.Characteristic.InUse, computeCachedValue.bind(this)('flowing'))
        .updateCharacteristic(platform.Characteristic.RemainingDuration, computeCachedValue.bind(this)('remaining'));
    }, 50);
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SprinklerV2Device handleSet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}

/***********************************************************************
 * handleSetDuration
 *
 * HomeKit SetDuration is in seconds; YoLink expects minutes.  Sends
 * SprinklerV2.setAttributes { manualWater: { type: "duration", value: <mins> } }.
 */
async function handleSetDuration(this: YoLinkPlatformAccessory, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const minutes = Math.max(0, Math.round(Number(value) / 60));
    const params = { manualWater: { type: 'duration', value: minutes } };
    const data = (await platform.yolinkAPI.setDeviceState(platform, device, params, 'setAttributes'))?.data;
    if (data?.attributes) {
      device.data.attributes = Object.assign(device.data.attributes ?? {}, data.attributes);
    } else {
      // API accepted the write but did not echo back attributes; update cache from what we sent.
      device.data.attributes = Object.assign(device.data.attributes ?? {}, params);
    }
    setTimeout(() => {
      this.valveService
        .updateCharacteristic(platform.Characteristic.SetDuration, computeCachedValue.bind(this)('setDuration'));
    }, 50);
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SprinklerV2Device handleSetDuration' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}

/***********************************************************************
 * handleType
 *
 */
async function handleType(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  return this.platform.Characteristic.ValveType.IRRIGATION;
}

/***********************************************************************
 * mqttSprinklerV2Device
 *
 * Per YoLink docs, callback payload for Report / setState / setAttributes /
 * StatusChange mirrors the SprinklerV2.getState response body.
 */
export async function mqttSprinklerV2Device(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const event = message.event.split('.');

    switch (event[1]) {
      case 'Alert':
      // falls through
      case 'Report':
      // falls through
      case 'getState':
      // falls through
      case 'setState':
      // falls through
      case 'setAttributes':
      // falls through
      case 'StatusChange':
        if (!device.data) {
          // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          this.valveService.updateCharacteristic(platform.Characteristic.StatusFault, true);
          break;
        }
        // Merge received data into existing data object
        Object.assign(device.data, message.data);
        this.logDeviceState(device, `Running: ${device.data?.state?.running}, waterFlowing: ${device.data?.waterFlowing},` +
          ` Battery: ${device.data?.battery} (MQTT: ${message.event})`);
        this.valveService
          .updateCharacteristic(platform.Characteristic.Active, computeCachedValue.bind(this)('valve'))
          .updateCharacteristic(platform.Characteristic.InUse, computeCachedValue.bind(this)('flowing'))
          .updateCharacteristic(platform.Characteristic.RemainingDuration, computeCachedValue.bind(this)('remaining'))
          .updateCharacteristic(platform.Characteristic.SetDuration, computeCachedValue.bind(this)('setDuration'))
          .updateCharacteristic(platform.Characteristic.StatusFault, platform.api.hap.Characteristic.StatusFault.NO_FAULT);
        break;
      case 'getSchedules':
      // falls through
      case 'setSchedules':
      // falls through
      case 'setTimeZone':
        // nothing to update in HomeKit
        this.logDeviceState(device, `Unsupported message (MQTT: ${message.event})`);
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message, null, 2));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttSprinklerV2Device' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}
