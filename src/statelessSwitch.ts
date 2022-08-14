/***********************************************************************
 * YoLink smart remote device support (as a HomeKit stateless switch)
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import { YoLinkPlatformAccessory } from './platformAccessory';

Error.stackTraceLimit = 100;

/***********************************************************************
 * initStatelessSwitch
 *
 */
export async function initStatelessSwitch(this: YoLinkPlatformAccessory, nButtons: number): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  const accessory: PlatformAccessory = this.accessory;
  const device = accessory.context.device;
  // Gap in milliseconds to consider whether double press or single press...
  // I never get a value less than 625ms so selecting 800 as resonable default.
  this.config.doublePress ??= (platform.config.doublePress ??= 800);
  this.button = [];

  this.serviceLabel = accessory.getService(platform.Service.ServiceLabel)
                   || accessory.addService(platform.Service.ServiceLabel);
  this.serviceLabel
    .setCharacteristic(platform.Characteristic.Name, device.name);
  this.serviceLabel
    .getCharacteristic(platform.Characteristic.ServiceLabelNamespace).onGet( () => {
      return(this.platform.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS);
    });
  platform.log.info(`Initialize stateless programmable switch with ${nButtons} button${(nButtons>1)?'s':''}`);
  for (let i = 0; i < nButtons; i++) {
    this.button.push({});
    this.button[i].timestamp = 0;
    this.button[i].statelessService = accessory.getService(`Button ${i+1}`)
                                   || accessory.addService(platform.Service.StatelessProgrammableSwitch, `Button ${i+1}`, `button${i+1}`);
    this.button[i].statelessService
      .setCharacteristic(platform.Characteristic.Name, device.name + ` Button ${i+1}`)
      .setCharacteristic(platform.Characteristic.ServiceLabelIndex, i+1);
    this.button[i].statelessService
      .getCharacteristic(platform.Characteristic.ProgrammableSwitchEvent)
      .onGet(handleGet.bind(this));
  }
  // timer to regularly update the data.
  this.refreshDataTimer(handleGet.bind(this));
}

/***********************************************************************
 * handleGet
 *
 * Example of message received,
 *
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
 *
 */
async function handleGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  // handleGet is only called during initalization. Data returned always represents the last
  // button action received by MQTT.
  const rc = platform.api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS;
  try {
    const device = this.accessory.context.device;
    if( await this.checkDeviceState(platform, device) ) {
      // const reportAtEpoch = new Date(device.data.reportAt).getTime();
      // platform.log.warn(`reportAtEpoch = ${reportAtEpoch}`);
      platform.liteLog(`Device state for ${this.deviceMsgName} is: ${JSON.stringify(device.data.state.event)}`);
      this.updateBatteryInfo.bind(this)();
    } else {
      platform.log.error(`Device offline or other error for ${this.deviceMsgName}`);
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
 * "keyMask" is a bitfield. E.g. for a four button remote the bits set will be 1, 2, 4, 8.  If you press
 * two buttons simultaneously then you will get e.g. 9 for buttons one and four... as a "LongPress".
 *
 * "type" can be "Press" or "LongPress"
 */
export async function mqttStatelessSwitch(this: YoLinkPlatformAccessory, message): Promise<void> {
  const platform: YoLinkHomebridgePlatform = this.platform;
  // serialize access to device data.
  const releaseSemaphore = await this.deviceSemaphore.acquire();
  try {
    const device = this.accessory.context.device;
    device.updateTime = Math.floor(new Date().getTime() / 1000) + this.config.refreshAfter;
    const mqttMessage = `MQTT: ${message.event} for device ${this.deviceMsgName}`;
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
        // loop through all possible buttons...
        for (let i=0, b=message.data.event.keyMask; b; i++, b=b>>>1) {
          // if keyMask is set for this button then process the message...
          if ((b & 1) && (this.button[i])) {
            const ms = message.time - this.button[i].timestamp;
            const intervalMsg = (this.button[i].timestamp > 0) ? ` (time since last press = ${ms}ms)` : '.';
            this.button[i].timestamp = message.time;
            if (message.data.event.type === 'Press') {
              if (ms < this.config.doublePress) {
                clearTimeout(this.button[i].timeoutFn);
                this.button[i].statelessService.updateCharacteristic(platform.Characteristic.ProgrammableSwitchEvent,
                  platform.api.hap.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS);
                this.button[i].timeoutFn = 0;
                platform.log.info(`${mqttMessage} button ${i+1} double press event (time between presses = ${ms}ms,`
                                + ` threshold = ${this.config.doublePress}ms)`);
              } else {
                this.button[i].timeoutFn = setTimeout( () => {
                  this.button[i].statelessService.updateCharacteristic(platform.Characteristic.ProgrammableSwitchEvent,
                    platform.api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
                  platform.log.info(`${mqttMessage} button ${i+1} single press event${intervalMsg}`);
                }, this.config.doublePress);
              }
            } else {
              // Assume LongPress
              this.button[i].statelessService.updateCharacteristic(platform.Characteristic.ProgrammableSwitchEvent,
                platform.api.hap.Characteristic.ProgrammableSwitchEvent.LONG_PRESS);
              platform.log.info(`${mqttMessage} button ${i+1} long press event`);
            }
          }
        }
        this.updateBatteryInfo.bind(this)();
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