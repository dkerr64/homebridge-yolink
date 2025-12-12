/***********************************************************************
 * YoLink leak sensor device support
 *
 * Copyright (c) 2022-2024 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initLeakSensor
 * Initialize the leak sensor device services
 */
export async function initLeakSensor(this: YoLinkPlatformAccessory): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device: YoLinkDevice = accessory.context.device;

  if (device.config.leakAsContact) {
    // User requests that we report to HomeKit as a contact sensor
    // Remove the leak sensor accessory if we previously used that
    accessory.removeService(accessory.getService(platform.Service.LeakSensor)!);
    // And now add it as a contact sensor.
    this.leakService = accessory.getService(platform.Service.ContactSensor)
      || accessory.addService(platform.Service.ContactSensor);
    this.leakService.setCharacteristic(platform.Characteristic.Name, device.name);
  } else {
    // Remove the contact sensor accessory if we previously used that
    accessory.removeService(accessory.getService(platform.Service.ContactSensor)!);
    // And now add it as a leak sensor.
    this.leakService = accessory.getService(platform.Service.LeakSensor)
      || accessory.addService(platform.Service.LeakSensor);
    this.leakService.setCharacteristic(platform.Characteristic.Name, device.name);
  }
  if (device.config.temperature) {
    // If requested add a service for the internal device temperature.
    this.thermoService = accessory.getService(platform.Service.TemperatureSensor)
      || accessory.addService(platform.Service.TemperatureSensor);
    this.thermoService.setCharacteristic(platform.Characteristic.Name, device.name + ' Temperature');
  } else {
    // If not requested then remove it if it already exists.
    accessory.removeService(accessory.getService(platform.Service.TemperatureSensor)!);
  }

  // Call get handler to initialize data fields to current state and set
  // timer to regularly update the data.
  await this.refreshDataTimer(handleGetBlocking.bind(this));

  // Once we have initial data, setup all the Homebridge handlers
  if (device.config.leakAsContact) {
    this.leakService.getCharacteristic(platform.Characteristic.ContactSensorState)
      .onGet(handleGet.bind(this, 'contact'));
  } else {
    this.leakService.getCharacteristic(platform.Characteristic.LeakDetected)
      .onGet(handleGet.bind(this));
  }
  this.thermoService?.getCharacteristic(platform.Characteristic.CurrentTemperature)
    .onGet(handleGet.bind(this, 'thermo'));
}

/***********************************************************************
 * handleGet
 *
 * This is an example of JSON object returned.
 *  {
 *    "online": true,
 *    "state": {
 *      "battery": 4,
 *      "devTemperature": 25,
 *      "interval": 20,
 *      "state": "normal",
 *      "version": "030d",
 *      "sensorMode": "WaterLeak",
 *      "supportChangeMode": false,
 *      "stateChangedAt": 1656502562174
 *    },
 *    "deviceId": "abcdef1234567890",
 *    "reportAt": "2022-07-22T15:37:08.126Z"
 *  }
 */
async function handleGet(this: YoLinkPlatformAccessory, devSensor = 'main'): Promise<CharacteristicValue> {
  // wrapping the semaphone blocking function so that we return to Homebridge immediately
  // even if semaphore not available.
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  handleGetBlocking.bind(this, devSensor)()
    .then((v) => {
      switch (devSensor) {
        case 'thermo':
          this.thermoService.updateCharacteristic(platform.Characteristic.CurrentTemperature, v);
          break;
        case 'contact':
          this.leakService.updateCharacteristic(platform.Characteristic.ContactSensorState, v);
          break;
        default:
          this.leakService.updateCharacteristic(platform.Characteristic.LeakDetected, v);
          break;
      }
    });
  // Return current state of the device pending completion of the blocking function
  switch (devSensor) {
    case 'thermo':
      return (device.data?.state?.devTemperature ?? -270);
    case 'contact':
      return ((device.data?.state?.state === 'closed')
        ? platform.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
        : platform.api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    default:
      return (device.data?.state?.state === 'alert');
  }
}

async function handleGetBlocking(this: YoLinkPlatformAccessory, devSensor = 'main'): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device: YoLinkDevice = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  // 'main' or 'thermo' use -270 as the minimum accepted value for default
  let rc = (devSensor === 'main') ? platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED : -270;
  try {
    if (await this.checkDeviceState(platform, device) && device.data.online) {
      this.leakService
        .updateCharacteristic(platform.Characteristic.StatusActive, true)
        .updateCharacteristic(platform.Characteristic.StatusFault, false);
      switch (devSensor) {
        case 'thermo':
          rc = device.data.state.devTemperature;
          break;
        case 'contact':
          rc = (device.data.state.state === 'closed')
            ? platform.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
            : platform.api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
          break;
        default:
          if (device.data.state.state === 'alert') {
            rc = platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED;
          }
          break;
      }
      this.logDeviceState(device, `Leak: ${device.data.state.state}, Battery: ${device.data.state.battery}, ` +
        `DevTemp: ${device.data.state.devTemperature}\u00B0C ` +
        `(${(device.data.state.devTemperature * 9 / 5 + 32).toFixed(1)}\u00B0F)`);
    } else {
      platform.log.error(`[${device.deviceMsgName}] Device offline or other error`);
      device.errorState = true;
      this.leakService
        .updateCharacteristic(platform.Characteristic.StatusActive, false)
        .updateCharacteristic(platform.Characteristic.StatusFault, true);
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in LeakDevice handleGet' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
  return (rc);
}

/***********************************************************************
 * mqttLeakSensor
 *
 *  {
 *    "event": "LeakSensor.Report",
 *    "time": 1658507785659,
 *    "msgid": "1658507785658",
 *    "data": {
 *      "sensorMode": "WaterLeak",
 *      "supportChangeMode": false,
 *      "state": "normal",
 *      "battery": 3,
 *      "interval": 20,
 *      "version": "030d",
 *      "devTemperature": 27,
 *      "loraInfo": {
 *        "signal": -77,
 *        "gatewayId": "abcdef1234567890",
 *        "gateways": 1
 *      },
 *      "stateChangedAt": 1656491747469
 *    },
 *    "deviceId": "abcdef1234567890"
 *  }
 */
export async function mqttLeakSensor(this: YoLinkPlatformAccessory, message): Promise<void> {
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
    const devTempMsg = (message.data.devTemperature) ? `, DevTemp: ${message.data.devTemperature}\u00B0C ` +
      `(${(message.data.devTemperature * 9 / 5 + 32).toFixed(1)}\u00B0F)` : '';

    switch (event[1]) {
      case 'Alert':
      // falls through
      case 'StatusChange':
      // falls through
      case 'Report':
        if (!device.data) {
          // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`Device ${device.deviceMsgName} has no data field, is device offline?`);
          this.leakService
            .updateCharacteristic(platform.Characteristic.StatusFault, true);
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
        this.logDeviceState(device, `Leak: ${device.data.state.state}${alertMsg}${batteryMsg}${devTempMsg} (MQTT: ${message.event})`);
        if (device.config.leakAsContact) {
          this.leakService
            .updateCharacteristic(platform.Characteristic.ContactSensorState,
              (message.data.state === 'alert')
                ? platform.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
                : platform.api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
        } else {
          this.leakService
            .updateCharacteristic(platform.Characteristic.LeakDetected,
              (message.data.state === 'alert')
                ? platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED
                : platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
        }
        this.leakService
          .updateCharacteristic(platform.Characteristic.StatusActive, true)
          .updateCharacteristic(platform.Characteristic.StatusFault, false);
        this.thermoService?.updateCharacteristic(platform.Characteristic.CurrentTemperature, message.data.devTemperature);
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch (e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttLeakSensor' + platform.reportError + msg);
  } finally {
    releaseSemaphore();
  }
}