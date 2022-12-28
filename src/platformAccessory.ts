/***********************************************************************
 * YoLink Platform Accessory class
 *
 * Copyright (c) 2022 David Kerr
 *
 * Based on https://github.com/homebridge/homebridge-plugin-template
 *
 * An instance of this class is created for each accessory the platform registers.
 *
 */

import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import Semaphore from 'semaphore-promise';
import { initDeviceService, mqttHandler, deviceFeatures} from './deviceHandlers';

export class YoLinkPlatformAccessory {
  // public deviceService!: Service;
  // public infoService!: Service;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  public config!: {
    [key: string]: any;
  };

  // Allow adding 'any' type of variable to this class
  [key: string]: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Some accessory types may have two YoLink devices
  public deviceId: string;
  public deviceId2: string;
  public deviceMsgName = '';

  constructor(
    readonly platform: YoLinkHomebridgePlatform,
    readonly accessory: PlatformAccessory,
  ) {
    Error.stackTraceLimit = 100;
    const device: YoLinkDevice = accessory.context.device;
    this.deviceId = device.deviceId;
    this.deviceId2 = '';
    // Special handling if we have two devices attached to the one accessory
    // only known case right now is for binding a garage door sensor with controller
    this.deviceType = (accessory.context.device2) ? 'GarageDoorCombo' : device.type;

    this.initializeDeviceVars(platform, device);

    // Now initialize device, creating the homebridge services as required.
    // If device type exists in our list of supported services...
    if (initDeviceService[this.deviceType]) {
      // And it is not experimental, or we are allowing experimental...
      if ((!(deviceFeatures[this.deviceType].experimental||false) || device.config.enableExperimental)) {
        // Then set accessory information...
        this.infoService = this.accessory.getService(platform.Service.AccessoryInformation) as Service;
        this.infoService
          .setCharacteristic(platform.Characteristic.Manufacturer, 'YoLink')
          .setCharacteristic(platform.Characteristic.Name, device.name)
          .setCharacteristic(platform.Characteristic.FirmwareRevision, String(device.config.version))
          .setCharacteristic(platform.Characteristic.Model, String(device.config.model ?? 'n/a'))
        // YoLink does not return device serial number in the API, use deviceId instead.
          .setCharacteristic(platform.Characteristic.SerialNumber, device.deviceId);
        this.infoService
          .getCharacteristic(platform.Characteristic.Identify).onSet(this.handleIdentifySet.bind(this, device));

        // Many YoLink devices are battery powered, so makes sense to include
        // battery level service.  YoLink reports 0..4, we will convert to 0,25,50,75,100 percent
        // deliberately using 'device.type' here.  If 'device2' has battery handle that in the
        // initDeviceService function.
        if (device.hasBattery) {
          // We use a name here because an accessory might have two batteries (e.g. GarageDoorCombo)
          device.batteryService = accessory.getService('Battery')
                               || accessory.addService(platform.Service.Battery, 'Battery', 'battery');
          device.batteryService
            .setCharacteristic(platform.Characteristic.Name, device.name)
            .setCharacteristic(platform.Characteristic.ChargingState, platform.api.hap.Characteristic.ChargingState.NOT_CHARGEABLE)
            .setCharacteristic(platform.Characteristic.BatteryLevel, 100);
          device.batteryService
            .getCharacteristic(platform.Characteristic.BatteryLevel).onGet(this.handleBatteryGet.bind(this, device));
        }
        // And finally call the device specific initialization...
        initDeviceService[this.deviceType].bind(this)();
      } else {
        platform.log.warn(`Experimental device ${device.deviceMsgName} skipped. Enable experimental devices in config. `
                        + 'Initializing as Unknown device');
        initDeviceService['Unknown'].bind(this)();
      }
    } else {
      // We do not have support for this device yet.
      initDeviceService['Unknown'].bind(this)();
    }
    return(this);
  }

  /*********************************************************************
   * checkDeviceState
   *
   */
  initializeDeviceVars(platform: YoLinkHomebridgePlatform, device: YoLinkDevice) {
    device.data = {};
    device.deviceMsgName = `${device.name} (${device.deviceId})`;
    device.lastReportAtTime = 0;
    device.config.refreshAfter ??= platform.config.refreshAfter;
    device.config.enableExperimental = platform.makeBoolean(device.config.enableExperimental, platform.config.enableExperimental);
    device.config.temperature = platform.makeBoolean(device.config.temperature, platform.config.deviceTemperatures);
    device.config.powerFailureSensorAs ??= platform.config.powerFailureSensorAs;
    device.hasBattery = deviceFeatures[device.type]?.hasBattery ?? false;
    // Set updateTime to now, which will ensure retrieving data from YoLink
    // on our first pass through.
    device.updateTime = Math.floor(new Date().getTime() / 1000);
    // set time of last log message to way back when...
    device.reportAtTime = new Date(0);
    // We need to serialize requests to YoLink API for each device.  Multiple threads
    // can request state updates for a device at the same time.  This would not be good,
    // so we need a semaphore to make sure we don't send a 2nd request to the same
    // device before prior one has completed.
    device.semaphore = new Semaphore();
    // GarageDoor specific...
    device.timeout ??= 45;
    // targetState used to track if garage door has been requested to open or close
    device.targetState = '';
  }

  /*********************************************************************
   * checkDeviceState
   * Updates device status object, sending a request to the YoLink API if we
   * have no data yet, or it has been a long time since the data was updated.
   *
   * Calls to this function should be serialized with deviceSemaphore to
   * prevent sending multiple requests for the same data to the server.
   */
  async checkDeviceState(platform: YoLinkHomebridgePlatform, device: YoLinkDevice) {
    try {
      platform.verboseLog(`checkDeviceState for ${device.deviceMsgName} (refresh after ${device.config.refreshAfter} seconds)`);
      const timestamp = Math.floor(new Date().getTime() / 1000);
      if ((device.config.refreshAfter === 0)
      || ((device.config.refreshAfter > 0) && (timestamp >= device.updateTime))) {
        // If we have never retrieved data from the device, or data is older
        // than period we want to allow, then retrieve new data from the device.
        // Else return with data unchanged.
        device.budp = await platform.yolinkAPI.getDeviceState(platform, device);
        if (device.budp) {
          device.data = device.budp.data;
          device.updateTime = timestamp + device.config.refreshAfter;
          // reportAtTime is the earlier of the time stamp on this message, or
          // or the time reported in the message from YoLink. We use this to
          // only log (in like mode), when we have an update.
          const msgTime = new Date(parseInt(device.budp.msgid));
          const repTime = new Date(device.data?.reportAt ?? '9999-12-31');
          device.reportAtTime = (msgTime < repTime) ? msgTime : repTime;
          this.updateBatteryInfo.bind(this, device)();
        } else {
          device.data = undefined;
          platform.log.error(`checkDeviceState received no data for ${device.deviceMsgName}`);
        }
      }
    } catch(e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.info('Error in checkDeviceState' + platform.reportError + msg);
    }
    return(device.data);
  }

  /***********************************************************************
   * logDeviceState
   *
   */
  logDeviceState(this: YoLinkPlatformAccessory, device: YoLinkDevice, msg: string) {
    // reportAtTime is the earlier of the time stamp on this message, or
    // or the time reported in the message from YoLink. We use this to
    // only log (in like mode), when we have an update.
    if (device.lastReportAtTime < device.reportAtTime.getTime()) {
      device.lastReportAtTime = device.reportAtTime.getTime();
      this.platform.log.info(`At ${device.reportAtTime.toLocaleString()}: Device state for ${device.deviceMsgName} is: ${msg}`);
    } else {
      this.platform.liteLog(`At ${device.reportAtTime.toLocaleString()}: Device state for ${device.deviceMsgName} is: ${msg}`);
    }
  }

  /*********************************************************************
   * refreshDataTimer
   * We run a timer for each device to update cached data from the YoLink servers.
   * Timer is set such that it will fire when the updateTime arrives and (via the
   * provided callback) will call above checkDeviceState function at just the
   * right time to force call to yolinkAPI.getDeviceState.  All this to optimize
   * performance of user experience.
   */
  async refreshDataTimer(this: YoLinkPlatformAccessory, handleGet: () => Promise<CharacteristicValue>) {
    const platform: YoLinkHomebridgePlatform = this.platform;
    const device: YoLinkDevice = this.accessory.context.device;

    platform.verboseLog(`Data refresh timer for ${device.deviceMsgName} fired`);

    await handleGet();
    if (device.config.refreshAfter >= 60) {
      // We don't allow for updates any more frequently than once a minute.
      const nextUpdateIn = Math.max(60, (device.updateTime||0) - Math.floor(new Date().getTime() / 1000));
      platform.verboseLog(`Set data refresh timer for ${device.deviceMsgName} to run in ${nextUpdateIn} seconds`);
      setTimeout( () => {
        this.refreshDataTimer(handleGet);
      }, nextUpdateIn * 1000);
    }
  }

  /***********************************************************************
   * updateBatteryInfo
   *
   */
  updateBatteryInfo(this: YoLinkPlatformAccessory, device: YoLinkDevice) {
    const platform: YoLinkHomebridgePlatform = this.platform;
    let batteryLevel = 100;

    try {
      if (device.hasBattery) {
        // Some devices wrap battery information under a 'state' object.
        // If nothing defined then assume 100%
        batteryLevel = ((device.data?.battery ?? device.data.state?.battery) ?? 4) * 25;
        const msg = `Battery level for ${device.deviceMsgName} is: ${batteryLevel}%`;
        if (batteryLevel <= 25) {
          device.batteryService.updateCharacteristic(platform.Characteristic.StatusLowBattery,
            platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
          this.platform.log.warn(msg);
        } else {
          device.batteryService.updateCharacteristic(platform.Characteristic.StatusLowBattery,
            platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
          this.platform.verboseLog(msg);
        }
      }
    } catch(e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in updateBatteryInfo' + platform.reportError + msg);
    }
    return(batteryLevel);
  }

  /*********************************************************************
   * handleBatteryGet
   *
   */
  async handleBatteryGet(this: YoLinkPlatformAccessory, device: YoLinkDevice): Promise<CharacteristicValue> {
    const platform = this.platform;
    // serialize access to device data.
    const releaseSemaphore = await device.semaphore.acquire();
    let rc = 100;
    try {
      if (await this.checkDeviceState(platform, device)) {
        rc = this.updateBatteryInfo.bind(this, device)();
      }
    } catch(e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in handleBatteryGet' + platform.reportError + msg);
    } finally {
      releaseSemaphore();
    }
    return (rc);
  }
  /*********************************************************************
   * handleIdentifySet
   *
   */

  async handleIdentifySet(this: YoLinkPlatformAccessory, device: YoLinkDevice, value): Promise<void> {
    const platform = this.platform;
    // serialize access to device data.
    const releaseSemaphore = await device.semaphore.acquire();
    try {
      platform.log.info(`YoLink Device: ${device.deviceMsgName} identify '${value}' (unsupported)`);
    } catch(e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in handleIdentitySet' + platform.reportError + msg);
    } finally {
      releaseSemaphore();
    }
  }

  /*********************************************************************
   * mqttMessage
   *
   */
  async mqttMessage(message): Promise<void> {
    const device: YoLinkDevice = this.accessory.context.device;
    const platform = this.platform;
    try {
      if (device.data) {
        // reportAtTime is the earlier of the time stamp on this message, or
        // or the time reported in the message from YoLink. We use this to
        // only log (in like mode), when we have an update.
        const msgTime = new Date(parseInt(message.msgid));
        const repTime = new Date(message.data?.reportAt ?? '9999-12-31');
        device.reportAtTime = (msgTime < repTime) ? msgTime : repTime;
        this.updateBatteryInfo.bind(this, device)();
        if (mqttHandler[this.deviceType]) {
          mqttHandler[this.deviceType].bind(this)(message);
        } else {
          mqttHandler['Unknown'].bind(this)(message);
        }
      } else {
        platform.log.warn(`MQTT: ${message.event} for uninitialized device ${device.deviceMsgName}`
                           + platform.reportError + JSON.stringify(message));
      }
    } catch(e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in mqttMessage' + platform.reportError + msg);
    }
    return;
  }
}
