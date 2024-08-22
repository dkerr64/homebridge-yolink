/***********************************************************************
 * YoLink Platform Accessory class
 *
 * Copyright (c) 2022-2024 David Kerr
 *
 * Based on https://github.com/homebridge/homebridge-plugin-template
 *
 * An instance of this class is created for each accessory the platform registers.
 *
 */

import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { initDeviceService, mqttHandler, deviceFeatures } from './deviceHandlers';

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
      if ((!(deviceFeatures[this.deviceType].experimental || false) || device.config.enableExperimental)) {
        // Then set accessory information...
        this.infoService = this.accessory.getService(platform.Service.AccessoryInformation) as Service;
        this.infoService
          .setCharacteristic(platform.Characteristic.Manufacturer, 'YoLink')
          .setCharacteristic(platform.Characteristic.Name, device.name)
          .setCharacteristic(platform.Characteristic.FirmwareRevision, String(device.config?.version))
          .setCharacteristic(platform.Characteristic.Model, String(device.modelName ?? 'n/a'))
          .setCharacteristic(platform.Characteristic.ProductData, `deviceId: ${device.deviceId}`)
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
            .setCharacteristic(platform.Characteristic.BatteryLevel, 0);
          device.batteryService
            .getCharacteristic(platform.Characteristic.BatteryLevel)
            .onGet(this.handleBatteryGet.bind(this, device));
        }
        // And finally call the device specific initialization...
        initDeviceService[this.deviceType].bind(this)();
      } else {
        platform.log.warn(`[${device.deviceMsgName}] Experimental device skipped. Enable experimental devices in config. `
          + 'Initializing as Unknown device');
        initDeviceService['Unknown'].bind(this)();
      }
    } else {
      // We do not have support for this device yet.
      initDeviceService['Unknown'].bind(this)();
    }
    return (this);
  }

  /*********************************************************************
   * initializeDeviceVars
   *
   */
  initializeDeviceVars(platform: YoLinkHomebridgePlatform, device: YoLinkDevice) {
    device.data = {};
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
    // Using the platform semaphore rather than per-device to fix YoLink 000201 errors.
    device.semaphore = platform.yolinkRequestSemaphore;
    // GarageDoor specific...
    device.timeout ??= 45;
    // targetState used to track if garage door has been requested to open or close
    device.targetState = '';
    // Use waterFlowing status from waterMeterControllers?
    device.config.useWaterFlowing = platform.makeBoolean(device.config.useWaterFlowing, platform.config.useWaterFlowing);
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
      platform.verboseLog(`[${device.deviceMsgName}] checkDeviceState (refresh after ${device.config.refreshAfter} seconds)`);
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
          // only log (in lite mode), when we have an update.
          const msgTime = new Date(parseInt(device.budp.msgid));
          const repTime = new Date(device.data?.reportAt ?? '9999-12-31');
          device.reportAtTime = (msgTime < repTime) ? msgTime : repTime;
          this.updateBatteryInfo.bind(this, device)();
        } else {
          device.data = undefined;
          platform.log.error(`[${device.deviceMsgName}] checkDeviceState received no data`);
        }
      }
    } catch (e) {
      // Error condition could be a throw() by ourselves within yolinkAPI.ts
      const msg = ((e instanceof Error) ? e.stack : e) as string;
      const yolinkMsg = msg.substring(7, msg.indexOf(')') + 1);
      const errCode = msg.split('YoLink API error code: ').pop()?.substring(0, 6);
      if ((errCode === '000201') || (errCode === '010301') || (errCode === '000201')) {
        // "YoLink API error code are rather common, so don't declare a problem
        platform.liteLog(yolinkMsg + ' - retrying');
      } else {
        platform.log.warn('Error in checkDeviceState' + platform.reportError + msg);
      }
      // Set device errorState so that when we eventually recover, we will log state.
      device.errorState = true;
    }
    return (device.data);
  }

  /***********************************************************************
   * logDeviceState
   *
   */
  logDeviceState(this: YoLinkPlatformAccessory, device: YoLinkDevice, msg: string) {
    if (device.errorState) {
      // we had previously logged an error condition, if we are now logging
      // device state we must have recovered from the error. Log that we recovered.
      this.platform.log.info(`[${device.deviceMsgName}] At ${device.reportAtTime.toLocaleString()}: Error recovery: ${msg}`);
      device.errorState = false;
    } else if (device.lastReportAtTime < device.reportAtTime.getTime()) {
      // reportAtTime is the earlier of the time stamp on this message, or
      // or the time reported in the message from YoLink. We use this to
      // only log (in lite mode), when we have an update.
      device.lastReportAtTime = device.reportAtTime.getTime();
      this.platform.liteLog(`[${device.deviceMsgName}] At ${device.reportAtTime.toLocaleString()}: Device state updated: ${msg}`);
    } else {
      this.platform.liteLog(`[${device.deviceMsgName}] At ${device.reportAtTime.toLocaleString()}: Device state: ${msg}`);
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
  async refreshDataTimer(this: YoLinkPlatformAccessory, handleGet: () => Promise<CharacteristicValue>, dev = 'main') {
    const platform: YoLinkHomebridgePlatform = this.platform;
    const device: YoLinkDevice = (dev === 'main') ? this.accessory.context.device : this.accessory.context.device2;

    await handleGet();
    platform.log.info(`Device initialized: ${device.deviceMsgName}`);
    if (--platform.initializeCount === 0) {
      platform.log.info('All YoLink devices initialized');
    } else {
      platform.log.debug(`[${device.deviceMsgName}] Decrement initialize count: ${platform.initializeCount}`);
    }
    if (device.config.refreshAfter >= 60) {
      // We don't allow for updates any more frequently than once a minute.
      const nextUpdateIn = Math.max(60, (device.updateTime || 0) - Math.floor(new Date().getTime() / 1000));
      platform.verboseLog(`[${device.deviceMsgName}] Set data refresh timer to run every ${nextUpdateIn} seconds`);
      setInterval(async () => {
        await handleGet();
      }, nextUpdateIn * 1000);
    }
  }

  /***********************************************************************
   * updateBatteryInfo
   *
   */
  updateBatteryInfo(this: YoLinkPlatformAccessory, device: YoLinkDevice) {
    const platform: YoLinkHomebridgePlatform = this.platform;
    let batteryLevel = 0;

    try {
      if (device.hasBattery) {
        // Some devices wrap battery information under a 'state' object.
        // If nothing defined then assume 0%
        batteryLevel = (device.data?.battery ?? device.data?.state?.battery) * 25; // could be NaN but that is okay
        const msg = `[${device.deviceMsgName}] Battery level: ${batteryLevel}%`;
        if (batteryLevel <= 25) {
          device.batteryService?.updateCharacteristic(platform.Characteristic.StatusLowBattery,
            platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
          this.platform.log.warn(msg);
        } else {
          device.batteryService?.updateCharacteristic(platform.Characteristic.StatusLowBattery,
            platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
          this.platform.verboseLog(msg);
        }
      }
    } catch (e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in updateBatteryInfo' + platform.reportError + msg);
    }
    return (isNaN(batteryLevel) ? 0 : batteryLevel);
  }

  /*********************************************************************
   * handleBatteryGet
   *
   */
  async handleBatteryGet(this: YoLinkPlatformAccessory, device: YoLinkDevice): Promise<CharacteristicValue> {
    // wrapping the semaphone blocking function so that we return to Homebridge immediately
    // even if semaphore not available.
    const platform: YoLinkHomebridgePlatform = this.platform;
    this.handleBatteryGetBlocking.bind(this, device)()
      .then((v) => {
        device.batteryService.updateCharacteristic(platform.Characteristic.BatteryLevel, v);
      });
    // Return current state of the device pending completion of the blocking function
    return (this.updateBatteryInfo.bind(this, device)());
  }

  async handleBatteryGetBlocking(this: YoLinkPlatformAccessory, device: YoLinkDevice): Promise<CharacteristicValue> {
    const platform = this.platform;
    // serialize access to device data.
    const releaseSemaphore = await device.semaphore.acquire();
    let rc = 0;
    try {
      if (await this.checkDeviceState(platform, device)) {
        rc = this.updateBatteryInfo.bind(this, device)();
      }
    } catch (e) {
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
      platform.log.info(`[${device.deviceMsgName}] YoLink Device: '${value}' (unsupported)`);
    } catch (e) {
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
          + platform.reportError + JSON.stringify(message, null, 2));
      }
    } catch (e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in mqttMessage' + platform.reportError + msg);
    }
    return;
  }
}
