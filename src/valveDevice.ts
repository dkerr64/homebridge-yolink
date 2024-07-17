/***********************************************************************
 * YoLink manipulator (e.g. water valve) device support
 *
 * Copyright (c) 2022-2024 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initValveDevice
 *
 */
export async function initValveDevice(this: YoLinkPlatformAccessory, type = 'Manipulator'): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  this.valveService = accessory.getService(platform.Service.Valve)
    || accessory.addService(platform.Service.Valve);
  this.valveService.setCharacteristic(platform.Characteristic.Name, device.name);

  if (type === 'WaterMeterController') {
    // These devices have temperature sensors, add service...
    this.thermoService = accessory.getService(platform.Service.TemperatureSensor)
      || accessory.addService(platform.Service.TemperatureSensor);
    this.thermoService.setCharacteristic(platform.Characteristic.Name, device.name + ' Temperature');

    // And they can also detect leaks, always add this...
    this.leakService = accessory.getService(platform.Service.LeakSensor)
      || accessory.addService(platform.Service.LeakSensor);
    this.leakService.setCharacteristic(platform.Characteristic.Name, device.name + ' Leak');
  }

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGetBlocking.bind(this, type, 'both'));

  // Once we have initial data, setup all the Homebridge handlers
  this.valveService.getCharacteristic(platform.Characteristic.Active)
    .onGet(handleGet.bind(this, type))
    .onSet(handleSet.bind(this, type));
  this.valveService.getCharacteristic(platform.Characteristic.InUse)
    .onGet(handleInUse.bind(this, type));
  this.valveService.getCharacteristic(platform.Characteristic.ValveType)
    .onGet(handleType.bind(this));

  this.thermoService?.getCharacteristic(platform.Characteristic.CurrentTemperature)
    .onGet(handleGet.bind(this, type, 'thermo'));
  this.leakService?.getCharacteristic(platform.Characteristic.LeakDetected)
    .onGet(handleGet.bind(this, type, 'leak'));
}

/***********************************************************************
 * handleGet
 *
 * This is an example of JSON object returned.
 *  {
 *    "state": "open",
 *    "battery": 3,
 *    "delay": {
 *      "ch": 1,
 *      "off": 0
 *    },
 *    "openRemind": 0,
 *    "version": "0906",
 *    "time": "2022-06-22T03:54:01.000Z",
 *    "tz": -4,
 *    "loraInfo": {
 *      "signal": -71,
 *      "gatewayId": "abcdef1234567890",
 *      "gateways": 1
 *    }
 *  }
 *
 * Newer WaterMeterController returns this...
 * {
 *   "state": {
 *     "valve": "open",
 *     "meter": 0,
 *     "waterFlowing": false
 *   },
 *   "alarm": {
 *     "openReminder": false,
 *     "leak": false,
 *     "amountOverrun": false,
 *     "durationOverrun": false,
 *     "valveError": false,
 *     "reminder": false,
 *     "freezeError": false
 *   },
 *   "battery": 4,
 *   "powerSupply": "battery",
 *   "valveDelay": {
 *     "ch": 1,
 *     "off": 0
 *   },
 *   "attributes": {
 *     "openReminder": 0,
 *     "screenMeterUnit": 0,
 *     "meterUnit": 3,
 *     "alertInterval": 0,
 *     "meterStepFactor": 1,
 *     "leakLimit": 4,
 *     "autoCloseValve": false,
 *     "overrunAmountACV": false,
 *     "overrunDurationACV": false,
 *     "leakPlan": "schedule",
 *     "overrunAmount": 0,
 *     "overrunDuration": 0,
 *     "freezeTemp": -873.9
 *   },
 *   "version": "0808",
 *   "tz": 0,
 *   "recentUsage": {
 *     "amount": 0,
 *     "duration": 0
 *   },
 *   "temperature": 27.5,
 *   "dailyUsage": 0,
 *   "loraInfo": {
 *     "netId": "010201",
 *     "signal": -40,
 *     "gatewayId": "abcdef1234567890",
 *     "gateways": 1
 *   }
 *  }
 */
async function handleGet(this: YoLinkPlatformAccessory, type: string, devSensor = 'valve'): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  handleGetBlocking.bind(this, type, devSensor)()
    .then((v) => {
      switch (devSensor) {
        case 'valve':
          this.valveService.updateCharacteristic(platform.Characteristic.Active, v);
          break;
        case 'thermo':
          this.thermoService.updateCharacteristic(platform.Characteristic.CurrentTemperature, v);
          break;
        case 'leak':
          this.leakService.updateCharacteristic(platform.Characteristic.LeakDetected, v);
          break;
        case 'flowing':
          this.valveService.updateCharacteristic(platform.Characteristic.InUse, v);
          break;
        default:
          platform.log.error(`Unexpected device sensor type '${devSensor}' for ${device.deviceMsgName}`);
          break;
      }
    });

  // Return current state of the device pending completion of the blocking function
  if (type === 'WaterMeterController') {
    // WaterMeterController...
    switch (devSensor) {
      case 'valve':
        return ((device.data.state.valve === 'open')
          ? platform.api.hap.Characteristic.Active.ACTIVE
          : platform.api.hap.Characteristic.Active.INACTIVE);
      case 'thermo':
        return (device.data.temperature);
      case 'leak':
        return ((device.data.alarm?.leak)
          ? platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED
          : platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
      case 'flowing':
        if (Object.prototype.hasOwnProperty.call(device.data.state, 'waterFlowing')) {
          return ((device.data.state.waterFlowing)
            ? platform.api.hap.Characteristic.InUse.IN_USE
            : platform.api.hap.Characteristic.InUse.NOT_IN_USE);
        } else {
          return ((device.data.state.valve === 'open')
            ? platform.api.hap.Characteristic.Active.ACTIVE
            : platform.api.hap.Characteristic.Active.INACTIVE);
        }
      default:
        platform.log.error(`Unexpected device sensor type '${devSensor}' for ${device.deviceMsgName}`);
        return ((device.data.state.valve === 'open')
          ? platform.api.hap.Characteristic.Active.ACTIVE
          : platform.api.hap.Characteristic.Active.INACTIVE);
    }
  } else {
    // Manipulator...
    return ((device.data.state === 'open')
      ? platform.api.hap.Characteristic.Active.ACTIVE
      : platform.api.hap.Characteristic.Active.INACTIVE);
  }
}

async function handleGetBlocking(this: YoLinkPlatformAccessory, type: string, devSensor = 'valve'): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  // 'thermo' use -270 as the minimum accepted value for default
  let rc = (devSensor === 'thermo') ? -270 : platform.api.hap.Characteristic.Active.INACTIVE; // also == NOT_IN_USE
  try {
    if (await this.checkDeviceState(platform, device)) {
      // YoLink manipulator data does not return a 'online' value.  We will assume that if
      // we got this far then it is working normally...
      this.valveService
        .updateCharacteristic(platform.Characteristic.StatusFault, false);

      if (type === 'WaterMeterController') {
        // WaterMeterController...
        switch (devSensor) {
          case 'valve':
            rc = (device.data.state.valve === 'open')
              ? platform.api.hap.Characteristic.Active.ACTIVE
              : platform.api.hap.Characteristic.Active.INACTIVE;
            this.logDeviceState(device, `Valve (${devSensor}): ${device.data.state.valve}, Battery: ${device.data.battery}`);
            break;
          case 'thermo':
            rc = device.data.temperature;
            this.logDeviceState(device, `Valve (${devSensor}): ${device.data.temperature}, Battery: ${device.data.battery}`);
            break;
          case 'leak':
            rc = (device.data.alarm?.leak)
              ? platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED
              : platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
            this.logDeviceState(device, `Valve (${devSensor}): ${device.data.alarm?.leak}, Battery: ${device.data.battery}`);
            break;
          case 'flowing':
            if (Object.prototype.hasOwnProperty.call(device.data.state, 'waterFlowing')) {
              rc = (device.data.state.waterFlowing)
                ? platform.api.hap.Characteristic.InUse.IN_USE
                : platform.api.hap.Characteristic.InUse.NOT_IN_USE;
              this.logDeviceState(device, `Valve (${devSensor}): ${device.data.state.waterFlowing}, Battery: ${device.data.battery}`);
            } else {
              rc = (device.data.state.valve === 'open')
                ? platform.api.hap.Characteristic.Active.ACTIVE
                : platform.api.hap.Characteristic.Active.INACTIVE;
              this.logDeviceState(device, `Valve (${devSensor}): ${device.data.state.valve}, Battery: ${device.data.battery}`);
            }
            break;
          default:
            platform.log.error(`Unexpected device sensor type '${devSensor}' for ${device.deviceMsgName}`);
            break;
        }
      } else {
        // Manipulator...
        if (device.data.state === 'open') {
          rc = platform.api.hap.Characteristic.Active.ACTIVE; // also == IN_USE
        }
        this.logDeviceState(device, `Valve (${devSensor}): ${device.data.state}, Battery: ${device.data.battery}`);
      }
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
      this.valveService
        .updateCharacteristic(platform.Characteristic.StatusFault, true);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in ValveDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return rc;
}

/***********************************************************************
 * handleInUse
 *
 */
async function handleInUse(this: YoLinkPlatformAccessory, type: string): Promise<CharacteristicValue> {
  // Apple HomeKit documentation defines In Use as fluid is flowing through valve.
  // We will assume that if the valve is open, then fluid is flowing...
  return await handleGet.bind(this, type)('flowing');
}

/***********************************************************************
 * handleSet
 *
 * This is an example of JSON object returned.
 *  {
 *    "state": "closed",
 *    "loraInfo": {
 *      "signal": -72,
 *      "gatewayId": "abcdef1234567890",
 *      "gateways": 1
 *    }
 *  }
 *
 * For WaterMeterController...
 * {
 *   "code": "000000",
 *   "time": 1721339544550,
 *   "msgid": 1721339544550,
 *   "method": "WaterMeterController.setState",
 *   "desc": "Success",
 *   "data": {
 *     "state": {
 *       "valve": "open"
 *     },
 *     "loraInfo": {
 *       "netId": "010201",
 *       "signal": -44,
 *       "gatewayId": "abcdef1234567890",
 *       "gateways": 1
 *    }
 *   }
 *  }
 */
async function handleSet(this: YoLinkPlatformAccessory, type: string, value: CharacteristicValue): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    const newState = (value === platform.api.hap.Characteristic.Active.ACTIVE) ? 'open' : 'close';
    // type can be 'Manipulator' or 'WaterMeterController' and each have different key values to use...
    const key = (type === 'Manipulator') ? 'state' : 'valve';
    const data = (await platform.yolinkAPI.setDeviceState(platform, device, { [key]: newState }))?.data;
    if (data) {
      if (typeof device.data.state === 'object') {
        Object.assign(device.data.state, data.state);
      } else {
        device.data.state = data.state;
      }
    }
    // Calling updateCharacteristic within set handler seems to fail, new value is not accepted.  Workaround is
    // to request the update after short delay (say 50ms) to allow homebridge/homekit to complete the set handler.
    setTimeout(() => {
      if (type === 'WaterMeterController') {
        // WaterMeterController...
        this.valveService
          .updateCharacteristic(platform.Characteristic.Active, (device.data.state.valve === 'open')
            ? platform.api.hap.Characteristic.Active.ACTIVE
            : platform.api.hap.Characteristic.Active.INACTIVE);
        if (Object.prototype.hasOwnProperty.call(device.data.state, 'waterFlowing')) {
          this.valveService
            .updateCharacteristic(platform.Characteristic.InUse, (device.data.state.waterFlowing)
              ? platform.api.hap.Characteristic.InUse.IN_USE
              : platform.api.hap.Characteristic.InUse.NOT_IN_USE);
        } else {
          this.valveService
            .updateCharacteristic(platform.Characteristic.InUse, (device.data.state.valve === 'open')
              ? platform.api.hap.Characteristic.InUse.IN_USE
              : platform.api.hap.Characteristic.InUse.NOT_IN_USE);
        }
      } else {
        // Manipulator...
        this.valveService
          .updateCharacteristic(platform.Characteristic.Active, (device.data.state === 'open')
            ? platform.api.hap.Characteristic.Active.ACTIVE
            : platform.api.hap.Characteristic.Active.INACTIVE)
          .updateCharacteristic(platform.Characteristic.InUse, (device.data.state === 'open')
            ? platform.api.hap.Characteristic.InUse.IN_USE
            : platform.api.hap.Characteristic.InUse.NOT_IN_USE);
      }
    }, 50);
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in ValveDevice handleSet' + platform.reportError + msg);
  } finally {
    // Avoid flooding YoLink device with rapid succession of requests.
    const sleep = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
    await sleep(250);
    releaseSemaphore();
  }
}

/***********************************************************************
 * handleType
 *
 */
async function handleType(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  return this.platform.Characteristic.ValveType.GENERIC_VALVE;
}


/***********************************************************************
 * mqttValveDevice
 *
 * Example of message received, first one is regular reporting, 2nd one
 * is on another device (the YoLink app) opening a valve.  Note that some
 * fields are not provided in 2nd version (e.g. Battery level).
 *  {
 *    "event": "Manipulator.Report",
 *    "time": 1658504122331,
 *    "msgid": "1658504122330",
 *    "data": {
 *      "state": "open",
 *      "battery": 3,
 *      "delay": {
 *        "ch": 1,
 *        "off": 0
 *      },
 *      "openRemind": 0,
 *      "version": "0906",
 *      "time": "2022-06-22T03:35:21.000Z",
 *      "tz": -4,
 *      "loraInfo": {
 *        "signal": -70,
 *        "gatewayId": "abcdef1234567890",
 *        "gateways": 1
 *      }
 *    },
 *    "deviceId": "abcdef1234567890"
 *  }
 * =============
 * {
 *   "event": "Manipulator.setState",
 *   "time": 1658520338496,
 *   "msgid": "1658520338495",
 *   "data": {
 *     "state": "open",
 *     "loraInfo": {
 *       "signal": -71,
 *       "gatewayId": "abcdef1234567890",
 *       "gateways": 1
 *     }
 *   },
 *   "deviceId": "abcdef1234567890"
 * }
 * ============
 * {
 *   "event": "WaterMeterController.Report",
 *   "method": "Report",
 *   "time": 1721353942368,
 *   "msgid": "1721353942368",
 *   "data": {
 *     "state": {
 *       "valve": "open",
 *       "meter": 0,
 *       "waterFlowing": false
 *     },
 *     "alarm": {
 *       "openReminder": false,
 *       "leak": false,
 *       "amountOverrun": false,
 *       "durationOverrun": false,
 *       "valveError": false,
 *       "reminder": false,
 *       "freezeError": false
 *     },
 *     "battery": 4,
 *     "powerSupply": "battery",
 *     "valveDelay": {
 *       "ch": 1,
 *       "off": 0
 *     },
 *     "attributes": {
 *       "openReminder": 0,
 *       "screenMeterUnit": 0,
 *       "meterUnit": 3,
 *       "alertInterval": 0,
 *       "meterStepFactor": 1,
 *       "leakLimit": 4,
 *       "autoCloseValve": false,
 *       "overrunAmountACV": false,
 *       "overrunDurationACV": false,
 *       "leakPlan": "schedule",
 *       "overrunAmount": 0,
 *       "overrunDuration": 0,
 *       "freezeTemp": -873.9
 *     },
 *     "version": "0808",
 *     "tz": 0,
 *     "recentUsage": {
 *       "amount": 0,
 *       "duration": 0
 *     },
 *     "temperature": 25.2,
 *     "dailyUsage": 0,
 *     "loraInfo": {
 *       "netId": "010201",
 *       "signal": -40,
 *       "gatewayId": "abcdef1234567890",
 *       "gateways": 1
 *     }
 *   },
 *   "deviceId": "abcdef1234567890"
 * }
 */
export async function mqttValveDevice(this: YoLinkPlatformAccessory, message): Promise<void> {
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
      case 'StatusChange':
        if (!device.data) {
          // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          this.valveService.updateCharacteristic(platform.Characteristic.StatusFault, true);
          break;
        }
        // Merge received data into existing data object
        Object.assign(device.data, message.data);
        if (Object.prototype.hasOwnProperty.call(device.data.state, 'valve')) {
          // WaterMeterController...
          this.logDeviceState(device, `Valve: ${device.data.state.valve}, Water flowing: ${device.data.state.waterFlowing},` +
            ` Battery: ${device.data.battery} (MQTT: ${message.event})`);
          this.valveService
            .updateCharacteristic(platform.Characteristic.Active, (device.data.state.valve === 'open')
              ? platform.api.hap.Characteristic.Active.ACTIVE
              : platform.api.hap.Characteristic.Active.INACTIVE);
          if (Object.prototype.hasOwnProperty.call(device.data.state, 'waterFlowing')) {
            this.valveService
              .updateCharacteristic(platform.Characteristic.InUse, (device.data.state.waterFlowing)
                ? platform.api.hap.Characteristic.InUse.IN_USE
                : platform.api.hap.Characteristic.InUse.NOT_IN_USE);
          } else {
            this.valveService
              .updateCharacteristic(platform.Characteristic.InUse, (device.data.state.valve === 'open')
                ? platform.api.hap.Characteristic.InUse.IN_USE
                : platform.api.hap.Characteristic.InUse.NOT_IN_USE);
          }
          this.thermoService
            ?.updateCharacteristic(platform.Characteristic.CurrentTemperature, device.data.temperature);
          this.leakService
            ?.updateCharacteristic(platform.Characteristic.LeakDetected, (device.data.alarm?.leak)
              ? platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED
              : platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
          this.valveService
            .updateCharacteristic(platform.Characteristic.StatusFault, (device.data.alarm?.valveError)
              ? platform.api.hap.Characteristic.StatusFault.GENERAL_FAULT
              : platform.api.hap.Characteristic.StatusFault.NO_FAULT);
        } else {
          // Manipulator...
          this.logDeviceState(device, `Valve: ${device.data.state}, Battery: ${device.data.battery} (MQTT: ${message.event})`);
          this.valveService
            .updateCharacteristic(platform.Characteristic.Active, (device.data.state === 'open')
              ? platform.api.hap.Characteristic.Active.ACTIVE
              : platform.api.hap.Characteristic.Active.INACTIVE)
            .updateCharacteristic(platform.Characteristic.InUse, (device.data.state === 'open')
              ? platform.api.hap.Characteristic.InUse.IN_USE
              : platform.api.hap.Characteristic.InUse.NOT_IN_USE)
            .updateCharacteristic(platform.Characteristic.StatusFault,
              platform.api.hap.Characteristic.StatusFault.NO_FAULT);
        }
        break;
      case 'setTimeZone':
        // nothing to update in HomeKit
        this.logDeviceState(device, `Unsupported message (MQTT: ${message.event})`);
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message, null, 2));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttValveDevice' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}