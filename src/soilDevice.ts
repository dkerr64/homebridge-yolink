/***********************************************************************
 * YoLink soil temperature / humidity / conductivity sensor device support
 * Supports device type: SoilThcSensor (e.g. YS8009-UC Solar Soil Detector)
 *
 * Copyright (c) 2022-2026 David Kerr
 * Soil sensor support contributed 2026 by Robert Coletti https://github.com/dkerr64/homebridge-yolink/pull/140
 *
 * Data shape from MQTT / API:
 * {
 *   "alarm": {
 *     "lowTemp": false,
 *     "highTemp": true,
 *     "lowHumidity": true,
 *     "highHumidity": false,
 *     "lowConductivity": true,
 *     "highConductivity": false,
 *     "period": false
 *   },
 *   "battery": 2,
 *   "state": {
 *     "temperature": 40.9,
 *     "humidity": 13,
 *     "conductivity": 0
 *   },
 *   "attributes": {
 *     "alertInterval": 0,
 *     "reportInterval": 5,
 *     "tempLimit":         { "max": 40,   "min": 10  },
 *     "humidityLimit":     { "max": 70,   "min": 20  },
 *     "conductivityLimit": { "max": 4000, "min": 500 }
 *   },
 *   "version": "0924",
 *   "loraInfo": { ... }
 * }
 *
 * HomeKit service mapping:
 *   temperature   -> TemperatureSensor (CurrentTemperature, °C)
 *   humidity      -> HumiditySensor    (CurrentRelativeHumidity, %)
 *   conductivity  -> LightSensor       (CurrentAmbientLightLevel, lux repurposed as µS/cm)
 *                    Note: HomeKit has no native soil conductivity service; LightSensor
 *                    is the conventional homebridge workaround for a unitless numeric
 *                    reading that supports automations.  The minimum accepted lux value
 *                    in HomeKit is 0.0001, so we clamp conductivity to that floor.
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initSoilDevice
 * Initialize temperature, humidity, and conductivity services.
 */
export async function initSoilDevice(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  const hideConfig = String(device.config.hide ?? '').toLowerCase();

  // ── Temperature ──────────────────────────────────────────────────────────────
  if (hideConfig === 'thermo') {
    platform.log.info(`[${device.deviceMsgName}] Hide Thermometer service because config.[${device.deviceId}].hide is set to "thermo"`);
    accessory.removeService(accessory.getService(platform.Service.TemperatureSensor)!);
  } else {
    this.thermoService = accessory.getService(platform.Service.TemperatureSensor)
      || accessory.addService(platform.Service.TemperatureSensor);
    this.thermoService.setCharacteristic(platform.Characteristic.Name, device.name);
  }

  // ── Humidity ─────────────────────────────────────────────────────────────────
  if (hideConfig === 'hydro') {
    platform.log.info(`[${device.deviceMsgName}] Hide Hydrometer service because config.[${device.deviceId}].hide is set to "hydro"`);
    accessory.removeService(accessory.getService(platform.Service.HumiditySensor)!);
  } else {
    this.hydroService = accessory.getService(platform.Service.HumiditySensor)
      || accessory.addService(platform.Service.HumiditySensor);
    this.hydroService.setCharacteristic(platform.Characteristic.Name, device.name);
  }

  // ── Conductivity (exposed as LightSensor) ────────────────────────────────────
  if (hideConfig === 'conductivity') {
    platform.log.info(`[${device.deviceMsgName}] Hide Conductivity service because config.[${device.deviceId}].hide is set to "conductivity"`);
    accessory.removeService(accessory.getService(platform.Service.LightSensor)!);
  } else {
    this.conductivityService = accessory.getService(platform.Service.LightSensor)
      || accessory.addService(platform.Service.LightSensor, `${device.name} Conductivity`, 'conductivity');
    this.conductivityService.setCharacteristic(platform.Characteristic.Name, `${device.name} Conductivity`);
  }

  // Fetch initial state, then wire up Homebridge get-handlers.
  await this.refreshDataTimer(handleGetBlocking.bind(this, 'thermo'));

  this.thermoService?.getCharacteristic(platform.Characteristic.CurrentTemperature)
    .onGet(handleGet.bind(this, 'thermo'));
  this.hydroService?.getCharacteristic(platform.Characteristic.CurrentRelativeHumidity)
    .onGet(handleGet.bind(this, 'hydro'));
  this.conductivityService?.getCharacteristic(platform.Characteristic.CurrentAmbientLightLevel)
    .onGet(handleGet.bind(this, 'conductivity'));
}

/***********************************************************************
 * conductivityToLux
 * HomeKit LightSensor requires a value >= 0.0001.  Conductivity of 0
 * is a valid soil reading (very dry / air), so we clamp to the minimum.
 */
function conductivityToLux(conductivity: number): number {
  return Math.max(0.0001, conductivity);
}

/***********************************************************************
 * handleGet  (non-blocking wrapper)
 */
async function handleGet(
  this: YoLinkPlatformAccessory,
  sensor: 'thermo' | 'hydro' | 'conductivity',
): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;

  handleGetBlocking.bind(this, sensor)().then((v) => {
    switch (sensor) {
      case 'hydro':
        this.hydroService?.updateCharacteristic(platform.Characteristic.CurrentRelativeHumidity, v);
        break;
      case 'conductivity':
        this.conductivityService?.updateCharacteristic(platform.Characteristic.CurrentAmbientLightLevel, v);
        break;
      default:
        this.thermoService?.updateCharacteristic(platform.Characteristic.CurrentTemperature, v);
    }
  });

  // Return current cached value while the blocking call completes.
  switch (sensor) {
    case 'hydro':
      return (device.data?.state?.humidity ?? 0);
    case 'conductivity':
      return conductivityToLux(device.data?.state?.conductivity ?? 0);
    default:
      return (device.data?.state?.temperature ?? -270);
  }
}

/***********************************************************************
 * handleGetBlocking  (serialized via semaphore)
 */
async function handleGetBlocking(
  this: YoLinkPlatformAccessory,
  sensor: 'thermo' | 'hydro' | 'conductivity',
): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  const releaseSemaphore = await device.semaphore.acquire();

  let rc: CharacteristicValue = (sensor === 'hydro') ? 0
    : (sensor === 'conductivity') ? 0.0001
      : -270;

  try {
    if (await this.checkDeviceState(platform, device) && (device.data.online !== false)) {
      const state = device.data.state;
      this.logDeviceState(device,
        `Temperature ${state.temperature}\u00B0C ` +
        `(${(state.temperature * 9 / 5 + 32).toFixed(1)}\u00B0F), ` +
        `Humidity ${state.humidity}%, ` +
        `Conductivity ${state.conductivity} \u00b5S/cm, ` +
        `Battery: ${device.data.battery} (Requested: ${sensor})`);

      this.thermoService?.updateCharacteristic(platform.Characteristic.StatusActive, true);
      this.thermoService?.updateCharacteristic(platform.Characteristic.StatusFault, false);
      this.hydroService?.updateCharacteristic(platform.Characteristic.StatusActive, true);
      this.hydroService?.updateCharacteristic(platform.Characteristic.StatusFault, false);
      this.conductivityService?.updateCharacteristic(platform.Characteristic.StatusActive, true);
      this.conductivityService?.updateCharacteristic(platform.Characteristic.StatusFault, false);

      switch (sensor) {
        case 'hydro':
          rc = state.humidity;
          break;
        case 'conductivity':
          rc = conductivityToLux(state.conductivity);
          break;
        default:
          rc = state.temperature;
      }
    } else {
      platform.log.error(`[${device.deviceMsgName}] Device offline or other error`);
      device.errorState = true;
      this.thermoService?.updateCharacteristic(platform.Characteristic.StatusActive, false);
      this.thermoService?.updateCharacteristic(platform.Characteristic.StatusFault, true);
      this.hydroService?.updateCharacteristic(platform.Characteristic.StatusActive, false);
      this.hydroService?.updateCharacteristic(platform.Characteristic.StatusFault, true);
      this.conductivityService?.updateCharacteristic(platform.Characteristic.StatusActive, false);
      this.conductivityService?.updateCharacteristic(platform.Characteristic.StatusFault, true);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in SoilDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return (rc);
}

/***********************************************************************
 * mqttSoilDevice
 * Handle MQTT messages from the SoilThcSensor.
 *
 * Observed message events:
 *   SoilThcSensor.Report  – periodic sensor report
 *   SoilThcSensor.Alert   – threshold alarm triggered
 *   SoilThcSensor.getState – response to a state-query request
 *
 * The soil sensor nests its readings under data.state (unlike some
 * other YoLink sensors that put them at the data root).
 */
export async function mqttSoilDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  const releaseSemaphore = await device.semaphore.acquire();

  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const event = message.event.split('.');
    const batteryMsg = (device.hasBattery && message.data?.battery !== undefined)
      ? `, Battery: ${message.data.battery}` : '';
    const alertMsg = message.data?.alertType ? `, Alert: ${message.data.alertType}` : '';

    switch (event[1]) {
      case 'getState':
        // getState wraps readings inside data.state — already the same shape we
        // expect, so we fall straight through to the Report handler.
        // falls through
      case 'Alert':
        // falls through
      case 'Report': {
        if (!device.data) {
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          break;
        }
        // If a message arrived, the device is online.
        device.data.online = true;

        // Merge top-level fields (alarm, battery, attributes, version, loraInfo)
        // and the nested state object separately so neither clobbers the other.
        const { state: incomingState, ...rest } = message.data;
        Object.assign(device.data, rest);
        if (incomingState) {
          device.data.state ??= {};
          Object.assign(device.data.state, incomingState);
        }
        if (!message.data.reportAt) {
          device.data.reportAt = device.reportAtTime.toISOString();
        }

        const state = device.data.state;
        this.logDeviceState(device,
          `Temperature ${state.temperature}\u00B0C ` +
          `(${(state.temperature * 9 / 5 + 32).toFixed(1)}\u00B0F), ` +
          `Humidity ${state.humidity}%, ` +
          `Conductivity ${state.conductivity} \u00b5S/cm` +
          `${alertMsg}${batteryMsg} (MQTT: ${message.event})`);

        this.thermoService?.updateCharacteristic(
          platform.Characteristic.CurrentTemperature, state.temperature);
        this.hydroService?.updateCharacteristic(
          platform.Characteristic.CurrentRelativeHumidity, state.humidity);
        this.conductivityService?.updateCharacteristic(
          platform.Characteristic.CurrentAmbientLightLevel, conductivityToLux(state.conductivity));

        // Log threshold alarms; HomeKit itself handles alert automations based on
        // the sensor values — there is no HomeKit "alarm" characteristic for these.
        const alarm = message.data.alarm ?? {};
        if (alarm.highTemp)          { platform.log.warn(`[${device.deviceMsgName}] High temperature alarm`); }
        if (alarm.lowTemp)           { platform.log.warn(`[${device.deviceMsgName}] Low temperature alarm`); }
        if (alarm.highHumidity)      { platform.log.warn(`[${device.deviceMsgName}] High humidity alarm`); }
        if (alarm.lowHumidity)       { platform.log.warn(`[${device.deviceMsgName}] Low humidity alarm`); }
        if (alarm.highConductivity)  { platform.log.warn(`[${device.deviceMsgName}] High conductivity alarm`); }
        if (alarm.lowConductivity)   { platform.log.warn(`[${device.deviceMsgName}] Low conductivity alarm`); }
        break;
      }
      case 'setAlarm':
        // Configuration change — no HomeKit equivalent.
        platform.liteLog(mqttMessage + ' ' + JSON.stringify(message, null, 2));
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message, null, 2));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttSoilDevice' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}
