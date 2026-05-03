/***********************************************************************
 * YoLink Sprinkler device support
 *
 * YoLink YS4102-UC Smart Sprinkler Controller (6-8 zones, 24VAC)
 *
 * NOTE: This handler is implemented from the YoLink API documentation
 * only; it has not been verified against live YS4102 hardware.  Fields
 * and behavior may diverge from what is documented.
 *
 * Copyright (c) 2022-2024 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initSprinklerDevice
 *
 * Creates one IrrigationSystem service and N child Valve services, one
 * per zone.  Zone count comes from data.zoneSize, defaulting to 8 (the
 * largest YS4102 SKU) if not yet known.
 */
export async function initSprinklerDevice(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  // Prime device data so we know zoneSize before we create child services.
  await handleGetBlocking.bind(this)();
  this.nZones = Math.max(1, Number(device.data?.zoneSize ?? device.config.nZones ?? 8));
  platform.verboseLog(`Device ${device.deviceMsgName} has ${this.nZones} zones`);

  this.irrigationService = accessory.getService(platform.Service.IrrigationSystem)
    || accessory.addService(platform.Service.IrrigationSystem);
  this.irrigationService.setCharacteristic(platform.Characteristic.Name, device.name);

  this.zone = [];
  for (let i = 0; i < this.nZones; i++) {
    this.zone.push({});
    this.zone[i].service = accessory.getService(`Zone ${i + 1}`)
      || accessory.addService(platform.Service.Valve, `Zone ${i + 1}`, `zone${i + 1}`);
    try {
      this.zone[i].service.addCharacteristic(platform.Characteristic.ServiceLabelIndex);
    } catch (e) {
      // Ignore - characteristic already present (e.g. restored from cache).
    }
    try {
      this.zone[i].service.addCharacteristic(platform.Characteristic.ConfiguredName);
    } catch (e) {
      // Ignore
    }
    this.zone[i].service
      .setCharacteristic(platform.Characteristic.Name, `${device.name} Zone ${i + 1}`)
      .setCharacteristic(platform.Characteristic.ConfiguredName, `Zone ${i + 1}`)
      .setCharacteristic(platform.Characteristic.ServiceLabelIndex, i + 1);
    this.irrigationService.addLinkedService(this.zone[i].service);
  }

  await this.refreshDataTimer(handleGetBlocking.bind(this));

  this.irrigationService.getCharacteristic(platform.Characteristic.Active)
    .onGet(handleGet.bind(this, 'systemActive'));
  this.irrigationService.getCharacteristic(platform.Characteristic.InUse)
    .onGet(handleGet.bind(this, 'systemInUse'));
  this.irrigationService.getCharacteristic(platform.Characteristic.ProgramMode)
    .onGet(handleGet.bind(this, 'programMode'));

  for (let i = 0; i < this.nZones; i++) {
    this.zone[i].service.getCharacteristic(platform.Characteristic.Active)
      .onGet(handleGet.bind(this, 'zoneActive', i))
      .onSet(handleSetZoneActive.bind(this, i));
    this.zone[i].service.getCharacteristic(platform.Characteristic.InUse)
      .onGet(handleGet.bind(this, 'zoneInUse', i));
    this.zone[i].service.getCharacteristic(platform.Characteristic.ValveType)
      .onGet(() => platform.Characteristic.ValveType.IRRIGATION);
    this.zone[i].service.getCharacteristic(platform.Characteristic.RemainingDuration)
      .setProps({ maxValue: 86400 })
      .onGet(handleGet.bind(this, 'remaining', i));
    this.zone[i].service.getCharacteristic(platform.Characteristic.SetDuration)
      .setProps({ maxValue: 86400, minStep: 60 })
      .onGet(handleGet.bind(this, 'setDuration', i))
      .onSet(handleSetDuration.bind(this, i));
  }
}

/***********************************************************************
 * computeCachedValue
 *
 * Per YoLink Sprinkler docs, getState returns:
 *   mode: "auto" | "manual" | "off"
 *   zoneSize: number
 *   delay: number (minutes)
 *   watering (optional, only while running): { zone, total, left }
 *   setting: { maxWaterTime, manualWater: number[] }   (per-zone minutes)
 *   version, tz, ...
 *
 * Zone numbering in the watering object is 1-indexed; internal arrays are
 * 0-indexed.  left, total and per-zone manualWater[] are all minutes;
 * HomeKit characteristics are seconds.
 *
 * UNVERIFIED - no live hardware available for YS4102.
 */
function computeCachedValue(this: YoLinkPlatformAccessory, devSensor: string, zone = 0): CharacteristicValue {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  const data = device.data ?? {};
  const watering = data.watering;
  const zoneRunning = (watering && Number(watering.zone) === zone + 1 && Number(watering.left) > 0);
  const systemActive = !!(watering && Number(watering.left) > 0);
  switch (devSensor) {
    case 'systemActive':
      return ((systemActive)
        ? platform.api.hap.Characteristic.Active.ACTIVE
        : platform.api.hap.Characteristic.Active.INACTIVE);
    case 'systemInUse':
      return ((systemActive)
        ? platform.api.hap.Characteristic.InUse.IN_USE
        : platform.api.hap.Characteristic.InUse.NOT_IN_USE);
    case 'programMode':
      return ((data.mode === 'auto')
        ? platform.api.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED
        : platform.api.hap.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
    case 'zoneActive':
      return ((zoneRunning)
        ? platform.api.hap.Characteristic.Active.ACTIVE
        : platform.api.hap.Characteristic.Active.INACTIVE);
    case 'zoneInUse':
      return ((zoneRunning)
        ? platform.api.hap.Characteristic.InUse.IN_USE
        : platform.api.hap.Characteristic.InUse.NOT_IN_USE);
    case 'remaining':
      return (zoneRunning) ? Math.max(0, Number(watering.left) * 60) : 0;
    case 'setDuration': {
      const manualWater = data.setting?.manualWater;
      const mins = Array.isArray(manualWater) ? Number(manualWater[zone] ?? 0) : 0;
      return Math.max(0, mins * 60);
    }
    default:
      platform.log.error(`Unexpected device sensor type '${devSensor}' for ${device.deviceMsgName}`);
      return 0;
  }
}

/***********************************************************************
 * handleGet
 *
 */
async function handleGet(this: YoLinkPlatformAccessory, devSensor: string, zone = 0): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  handleGetBlocking.bind(this)()
    .then(() => {
      switch (devSensor) {
        case 'systemActive':
          this.irrigationService.updateCharacteristic(platform.Characteristic.Active,
            computeCachedValue.bind(this)(devSensor, zone));
          break;
        case 'systemInUse':
          this.irrigationService.updateCharacteristic(platform.Characteristic.InUse,
            computeCachedValue.bind(this)(devSensor, zone));
          break;
        case 'programMode':
          this.irrigationService.updateCharacteristic(platform.Characteristic.ProgramMode,
            computeCachedValue.bind(this)(devSensor, zone));
          break;
        case 'zoneActive':
          this.zone[zone].service.updateCharacteristic(platform.Characteristic.Active,
            computeCachedValue.bind(this)(devSensor, zone));
          break;
        case 'zoneInUse':
          this.zone[zone].service.updateCharacteristic(platform.Characteristic.InUse,
            computeCachedValue.bind(this)(devSensor, zone));
          break;
        case 'remaining':
          this.zone[zone].service.updateCharacteristic(platform.Characteristic.RemainingDuration,
            computeCachedValue.bind(this)(devSensor, zone));
          break;
        case 'setDuration':
          this.zone[zone].service.updateCharacteristic(platform.Characteristic.SetDuration,
            computeCachedValue.bind(this)(devSensor, zone));
          break;
        default:
          platform.log.error(`Unexpected device sensor type '${devSensor}' for ${device.deviceMsgName}`);
          break;
      }
    });
  return computeCachedValue.bind(this)(devSensor, zone);
}

async function handleGetBlocking(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    if (await this.checkDeviceState(platform, device)) {
      this.irrigationService?.updateCharacteristic(platform.Characteristic.StatusFault, false);
      this.logDeviceState(device, `Mode: ${device.data?.mode}, watering: ${JSON.stringify(device.data?.watering ?? null)},` +
        ` zoneSize: ${device.data?.zoneSize}`);
    } else {
      platform.log.error(`[${device.deviceMsgName}] Device offline or other error`);
      device.errorState = true;
      this.irrigationService?.updateCharacteristic(platform.Characteristic.StatusFault, true);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SprinklerDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return 0;
}

/***********************************************************************
 * handleSetZoneActive
 *
 * ON:  set mode=manual, write this zone's duration into setting.manualWater[],
 *      then Sprinkler.setManualWater { state: "start" }.
 * OFF: Sprinkler.setManualWater { state: "stop" }.
 *
 * UNVERIFIED - no live hardware available for YS4102.
 */
async function handleSetZoneActive(this: YoLinkPlatformAccessory, zone: number, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    if (value === platform.api.hap.Characteristic.Active.ACTIVE) {
      // Build manualWater[] from current cache, overwriting this zone with its SetDuration.
      const current: number[] = Array.isArray(device.data?.setting?.manualWater)
        ? [...device.data.setting.manualWater]
        : new Array(this.nZones).fill(0);
      while (current.length < this.nZones) {
        current.push(0);
      }
      const setDurationSeconds = Number(this.zone[zone].service
        .getCharacteristic(platform.Characteristic.SetDuration).value ?? 0);
      current[zone] = Math.max(1, Math.round(setDurationSeconds / 60));
      const stateParams = { mode: 'manual', setting: { manualWater: current } };
      const stateResp = (await platform.yolinkAPI.setDeviceState(platform, device, stateParams))?.data;
      if (stateResp) {
        Object.assign(device.data, stateResp);
      } else {
        device.data.mode = 'manual';
        device.data.setting = Object.assign(device.data.setting ?? {}, { manualWater: current });
      }
      const startResp = (await platform.yolinkAPI.setDeviceState(platform, device,
        { state: 'start' }, 'setManualWater'))?.data;
      if (startResp) {
        Object.assign(device.data, startResp);
      }
    } else {
      const stopResp = (await platform.yolinkAPI.setDeviceState(platform, device,
        { state: 'stop' }, 'setManualWater'))?.data;
      if (stopResp) {
        Object.assign(device.data, stopResp);
      } else {
        device.data.watering = undefined;
      }
    }
    setTimeout(() => {
      this.irrigationService
        .updateCharacteristic(platform.Characteristic.Active, computeCachedValue.bind(this)('systemActive'))
        .updateCharacteristic(platform.Characteristic.InUse, computeCachedValue.bind(this)('systemInUse'));
      for (let i = 0; i < this.nZones; i++) {
        this.zone[i].service
          .updateCharacteristic(platform.Characteristic.Active, computeCachedValue.bind(this)('zoneActive', i))
          .updateCharacteristic(platform.Characteristic.InUse, computeCachedValue.bind(this)('zoneInUse', i))
          .updateCharacteristic(platform.Characteristic.RemainingDuration, computeCachedValue.bind(this)('remaining', i));
      }
    }, 50);
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SprinklerDevice handleSetZoneActive' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}

/***********************************************************************
 * handleSetDuration
 *
 * Persist the SetDuration for a zone into setting.manualWater[] so that
 * the next "start" uses the new value.  HomeKit is seconds; YoLink
 * expects minutes.
 *
 * UNVERIFIED - no live hardware available for YS4102.
 */
async function handleSetDuration(this: YoLinkPlatformAccessory, zone: number, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const current: number[] = Array.isArray(device.data?.setting?.manualWater)
      ? [...device.data.setting.manualWater]
      : new Array(this.nZones).fill(0);
    while (current.length < this.nZones) {
      current.push(0);
    }
    current[zone] = Math.max(0, Math.round(Number(value) / 60));
    const params = { setting: { manualWater: current } };
    const data = (await platform.yolinkAPI.setDeviceState(platform, device, params))?.data;
    if (data) {
      Object.assign(device.data, data);
    } else {
      device.data.setting = Object.assign(device.data.setting ?? {}, { manualWater: current });
    }
    setTimeout(() => {
      this.zone[zone].service
        .updateCharacteristic(platform.Characteristic.SetDuration, computeCachedValue.bind(this)('setDuration', zone));
    }, 50);
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SprinklerDevice handleSetDuration' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}

/***********************************************************************
 * mqttSprinklerDevice
 *
 * Per YoLink docs, callback payload for Report / setState / setManualWater /
 * StatusChange mirrors the Sprinkler.getState response body.
 *
 * UNVERIFIED - no live hardware available for YS4102.
 */
export async function mqttSprinklerDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
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
      case 'setManualWater':
      // falls through
      case 'StatusChange':
        if (!device.data) {
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          this.irrigationService?.updateCharacteristic(platform.Characteristic.StatusFault, true);
          break;
        }
        Object.assign(device.data, message.data);
        this.logDeviceState(device, `Mode: ${device.data?.mode}, watering: ${JSON.stringify(device.data?.watering ?? null)} ` +
          `(MQTT: ${message.event})`);
        this.irrigationService
          .updateCharacteristic(platform.Characteristic.Active, computeCachedValue.bind(this)('systemActive'))
          .updateCharacteristic(platform.Characteristic.InUse, computeCachedValue.bind(this)('systemInUse'))
          .updateCharacteristic(platform.Characteristic.ProgramMode, computeCachedValue.bind(this)('programMode'))
          .updateCharacteristic(platform.Characteristic.StatusFault, platform.api.hap.Characteristic.StatusFault.NO_FAULT);
        for (let i = 0; i < this.nZones; i++) {
          this.zone[i].service
            .updateCharacteristic(platform.Characteristic.Active, computeCachedValue.bind(this)('zoneActive', i))
            .updateCharacteristic(platform.Characteristic.InUse, computeCachedValue.bind(this)('zoneInUse', i))
            .updateCharacteristic(platform.Characteristic.RemainingDuration, computeCachedValue.bind(this)('remaining', i))
            .updateCharacteristic(platform.Characteristic.SetDuration, computeCachedValue.bind(this)('setDuration', i));
        }
        break;
      case 'getSchedules':
      // falls through
      case 'setSchedules':
      // falls through
      case 'setTimeZone':
        this.logDeviceState(device, `Unsupported message (MQTT: ${message.event})`);
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message, null, 2));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttSprinklerDevice' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}
