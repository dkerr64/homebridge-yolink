/***********************************************************************
 * YoLink smart remote device support (as a HomeKit stateless switch)
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

/***********************************************************************
 * initStatelessSwitch
 *
 */
export async function initStatelessSwitch(this: YoLinkPlatformAccessory, nButtons: number): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device = accessory.context.device;
  // Gap in milliseconds to consider whether double press or single press...
  // I never get a value less than 625ms so selecting 800 as reasonable default.
  device.config.doublePress ??= (platform.config.doublePress ??= 800);
  this.button = [];

  if (nButtons > 1) {
    // serviceLabel required when multiple services of same type on one accessory
    this.serviceLabel = accessory.getService(platform.Service.ServiceLabel)
                   || accessory.addService(platform.Service.ServiceLabel);
    this.serviceLabel
      .setCharacteristic(platform.Characteristic.Name, device.name);
    this.serviceLabel
      .getCharacteristic(platform.Characteristic.ServiceLabelNamespace).onGet( () => {
        return(this.platform.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS);
      });
  }
  platform.verboseLog(`Initialize stateless programmable switch with ${nButtons} button${(nButtons>1)?'s':''}`);
  for (let i = 0; i < nButtons; i++) {
    this.button.push({});
    this.button[i].timestamp = 0; // used to detect double press
    this.button[i].statelessService = accessory.getService(`Button ${i+1}`)
                                   || accessory.addService(platform.Service.StatelessProgrammableSwitch, `Button ${i+1}`, `button${i+1}`);
    this.button[i].statelessService
      .setCharacteristic(platform.Characteristic.Name, device.name + (nButtons>1)?` Button ${i+1}`:'');
    if (nButtons > 1) {
      this.button[i].statelessService
        .setCharacteristic(platform.Characteristic.ServiceLabelIndex, i+1);
    }
    this.button[i].statelessService
      .getCharacteristic(platform.Characteristic.ProgrammableSwitchEvent)
      .onGet(handleGet.bind(this));
  }

  if (device.config.temperature) {
    // If requested add a service for the internal device temperature.
    this.thermoService = accessory.getService(platform.Service.TemperatureSensor)
                      || accessory.addService(platform.Service.TemperatureSensor);
    this.thermoService.setCharacteristic(platform.Characteristic.Name, device.name + ' Temperature');
    this.thermoService.getCharacteristic(platform.Characteristic.CurrentTemperature)
      .onGet(handleGet.bind(this, 'thermo'));
  } else {
    // If not requested then remove it if it already exists.
    const service = accessory.getService(platform.Service.TemperatureSensor);
    if (service) {
      accessory.removeService(service);
    }
  }

  // timer to regularly update the data.
  this.refreshDataTimer(handleGet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * Example of message received,
 * {
 *   "online":true,
 *   "state":{
 *     "battery":4,
 *     "devTemperature":30,
 *     "event":{
 *       "keyMask":1,
 *       "type":"Press"
 *     },
 *     "version":"0406"
 *   },
 *   "deviceId":"abcdef1234567890",
 *   "reportAt":"2022-08-12T20:05:48.990Z"
 * }
 */
async function handleGet(this: YoLinkPlatformAccessory, devSensor = 'main'): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  // handleGet is only called during initialization. Data returned always represents the last
  // button action received by MQTT.
  let rc = 0;
  try {
    if( await this.checkDeviceState(platform, device) ) {
      switch(devSensor) {
        case 'thermo':
          rc = device.data.state.devTemperature;
          break;
        default:
          rc = 0;
      }
      this.logDeviceState(device, `${JSON.stringify(device.data.state.event)}, Battery: ${device.data.state.battery}, ` +
                          `DevTemp: ${device.data.state.devTemperature}\u00B0C ` +
                          `(${(device.data.state.devTemperature*9/5+32).toFixed(1)}\u00B0F)`);
    } else {
      platform.log.error(`Device offline or other error for ${device.deviceMsgName}`);
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in StatelessSwitch handleGet' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
  return (rc);
}

/***********************************************************************
 * mqttStatelessSwitch
 *
 * Example of message received,
 *
 * {
 *   "event":"SmartRemoter.Report",
 *   "time":1660337968343,
 *   "msgid":"1660337968342",
 *   "data":{
 *     "event":{
 *       "keyMask":0,
 *       "type":"LongPress"
 *     },
 *     "battery":4,
 *     "version":"0406",
 *     "devTemperature":30,
 *     "loraInfo":{
 *       "signal":-77,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * {
 *   "event":"SmartRemoter.StatusChange",
 *   "time":1660334748994,
 *   "msgid":"1660334748990",
 *   "data":{
 *     "event":{
 *       "keyMask":1,
 *       "type":"Press"
 *     },
 *     "battery":4,
 *     "version":"0406",
 *     "devTemperature":30,
 *     "loraInfo":{
 *       "signal":-85,
 *       "gatewayId":"abcdef1234567890",
 *       "gateways":1
 *     }
 *   },
 *   "deviceId":"abcdef1234567890"
 * }
 *
 * "keyMask" is a bit field. E.g. for a four button remote the bits set will be 1, 2, 4, 8.  If you press
 * two buttons simultaneously then you will get e.g. 9 for buttons one and four... as a "LongPress".
 *
 * "type" can be "Press" or "LongPress"
 */
export async function mqttStatelessSwitch(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const device = this.accessory.context.device;
  // serialize access to device data.
  const releaseSemaphore = await device.semaphore.acquire();
  try {
    device.updateTime = Math.floor(new Date().getTime() / 1000) + device.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${device.deviceMsgName}`;
    const event = message.event.split('.');

    switch (event[1]) {
      case 'Report':
        platform.log.info(`${mqttMessage}`);
        // Fall through
      case 'StatusChange':
        if (!device.data) {
        // in rare conditions (error conditions returned from YoLink) data object will be undefined or null.
          platform.log.warn(`${mqttMessage} has no data field, is device offline?`);
          break;
        }
        // if we received a message then device must be online
        device.data.online = true;
        // Merge received data into existing data object
        Object.assign(device.data.state, message.data);
        if (!message.data.reportAt) {
          // mqtt data does not include a report time, so merging the objects leaves current
          // unchanged, update the time string.
          device.data.reportAt = device.reportAtTime.toISOString();
        }
        this.logDeviceState(device, `${JSON.stringify(device.data.state.event)}, Battery: ${device.data.state.battery}, ` +
                            `DevTemp: ${device.data.state.devTemperature}\u00B0C ` +
                            `(${(device.data.state.devTemperature*9/5+32).toFixed(1)}\u00B0F) (MQTT: ${message.event})`);
        // loop through all possible buttons...
        for (let i=0, b=message.data.event.keyMask; b; i++, b=b>>>1) {
          // if keyMask is set for this button then process the message...
          if ((b & 1) && (this.button[i])) {
            const ms = message.time - this.button[i].timestamp;
            // print time since last press if less than 5 seconds (to help with double press time setup)
            const intervalMsg = (ms < 5000) ? ` (time since last press = ${ms}ms)` : '';
            this.button[i].timestamp = message.time;
            if (message.data.event.type === 'Press') {
              if (ms < device.config.doublePress) {
                clearTimeout(this.button[i].timeoutFn);
                this.button[i].statelessService.updateCharacteristic(platform.Characteristic.ProgrammableSwitchEvent,
                  platform.api.hap.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS);
                this.button[i].timeoutFn = 0;
                platform.log.info(`${mqttMessage} button ${i+1} double press event (time between presses = ${ms}ms,`
                                + ` threshold = ${device.config.doublePress}ms)`);
              } else {
                this.button[i].timeoutFn = setTimeout( () => {
                  this.button[i].statelessService.updateCharacteristic(platform.Characteristic.ProgrammableSwitchEvent,
                    platform.api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
                  platform.log.info(`${mqttMessage} button ${i+1} single press event${intervalMsg}`);
                }, device.config.doublePress);
              }
            } else {
              // Assume LongPress
              this.button[i].statelessService.updateCharacteristic(platform.Characteristic.ProgrammableSwitchEvent,
                platform.api.hap.Characteristic.ProgrammableSwitchEvent.LONG_PRESS);
              platform.log.info(`${mqttMessage} button ${i+1} long press event`);
            }
          }
        }
        break;
      default:
        platform.log.warn(mqttMessage + ' not supported.' + platform.reportError + JSON.stringify(message));
    }
  } catch(e) {
    const msg = (e instanceof Error) ? e.stack : e;
    platform.log.error('Error in mqttStatelessSwitch' + platform.reportError + msg);
  } finally {
    await releaseSemaphore();
  }
}