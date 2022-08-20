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
import { YoLinkHomebridgePlatform } from './platform';
import Semaphore from 'semaphore-promise';
import { initDeviceService, mqttHandler, deviceFeatures} from './deviceHandlers';
import { initUnknownDevice, mqttUnknownDevice } from './unknownDevice';

export class YoLinkPlatformAccessory {
  public deviceService!: Service;
  public infoService!: Service;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  public config!: {
    [key: string]: any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  public deviceSemaphore;
  public deviceId;
  public deviceMsgName;

  constructor(
    readonly platform: YoLinkHomebridgePlatform,
    readonly accessory: PlatformAccessory,
  ) {
    Error.stackTraceLimit = 100;
    const device = accessory.context.device;
    this.deviceId = device.deviceId;
    this.deviceMsgName = `${device.name} (${device.deviceId})`;
    this.lastReportAtTime = 0;
    this.config = platform.config.devices[device.deviceId] ? platform.config.devices[device.deviceId] : {};
    this.config.refreshAfter ??= (platform.config.refreshAfter ??= 3600);
    this.config.enableExperimental ??= (platform.config.enableExperimental ??= false);
    this.hasBattery = false;

    // We need to serialize requests to YoLink API for each device.  Multiple threads
    // can request state updates for a device at the same time.  This would not be good,
    // so we need a semaphore to make sure we don't send a 2nd request to the same
    // device before prior one has completed.
    this.deviceSemaphore = new Semaphore();

    // Now initialize device, creating the homebridge services as required.
    // If device type exists in our list of supported services...
    if (initDeviceService[device.type]) {
      // And it is not experimental, or we are allowing experimental...
      if ((!deviceFeatures[device.type].experimental || this.config.enableExperimental)) {
        // Then set accessory information...
        this.infoService = this.accessory.getService(platform.Service.AccessoryInformation) as Service;
        this.infoService
          .setCharacteristic(platform.Characteristic.Manufacturer, 'YoLink')
          .setCharacteristic(platform.Characteristic.Name, device.name)
          .setCharacteristic(platform.Characteristic.FirmwareRevision, String(this.config.version))
          .setCharacteristic(platform.Characteristic.Model, String((this.config.model) ? this.config.model : 'n/a'))
        // YoLink does not return device serial number in the API, use deviceId instead.
          .setCharacteristic(platform.Characteristic.SerialNumber, device.deviceId);
        this.infoService
          .getCharacteristic(platform.Characteristic.Identify).onSet(this.handleIdentifySet.bind(this));

        // Many YoLink devices are battery powered, so makes sense to include
        // battery level service.  YoLink reports 0..4, we will convert to 0,25,50,75,100 percent
        this.hasBattery = deviceFeatures[device.type].hasBattery;
        if (this.hasBattery) {
          this.batteryService = accessory.getService(platform.Service.Battery)
                             || accessory.addService(platform.Service.Battery);
          this.batteryService
            .setCharacteristic(platform.Characteristic.Name, device.name)
            .setCharacteristic(platform.Characteristic.ChargingState, platform.api.hap.Characteristic.ChargingState.NOT_CHARGEABLE)
            .setCharacteristic(platform.Characteristic.BatteryLevel, 100);
          this.batteryService
            .getCharacteristic(platform.Characteristic.BatteryLevel).onGet(this.handleBatteryGet.bind(this));
        }
        // And finally call the device specific initialization...
        initDeviceService[device.type].bind(this)();
      } else {
        platform.log.warn(`Experimental device ${this.deviceMsgName} skipped. Enable experimental devices in config.`);
      }
    } else {
      // We do not have support for this device yet.
      initUnknownDevice.bind(this)();
    }
    return(this);
  }

  /*********************************************************************
   * checkDeviceState
   * Updates device status object, sending a request to the YoLink API if we
   * have no data yet, or it has been a long time since the data was updated.
   *
   * Calls to this function should be serialized with deviceSemaphore to
   * prevent sending multiple requests for the same data to the server.
   */
  async checkDeviceState(platform, device) {
    try {
      platform.verboseLog(`checkDeviceState for ${this.deviceMsgName} (refresh after ${this.config.refreshAfter} seconds)`);
      const timestamp = Math.floor(new Date().getTime() / 1000);
      if (!device.data
        || (this.config.refreshAfter === 0)
        || ((this.config.refreshAfter > 0) && (timestamp >= device.updateTime))) {
        // If we have never retrieved data from the device, or data is older
        // than period we want to allow, then retireve new data from the device.
        // Else return with data unchanged.
        device.budp = await platform.yolinkAPI.getDeviceState(platform, device);
        if (device.budp) {
          device.data = device.budp.data;
          device.updateTime = timestamp + this.config.refreshAfter;
          // reportAtTime is the earlier of the time stamp on this message, or
          // or the time reported in the message from YoLink. We use this to
          // only log (in like mode), when we have an update.
          const msgTime = new Date(parseInt(device.budp.msgid));
          const repTime = new Date(device.data?.reportAt ?? '9999-12-31');
          this.reportAtTime = (msgTime < repTime) ? msgTime : repTime;
          this.updateBatteryInfo.bind(this)();
        } else {
          device.data = undefined;
          platform.log.error(`checkDeviceState received no data for ${this.deviceMsgName}`);
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
  logDeviceState(this: YoLinkPlatformAccessory, msg: string) {
    // reportAtTime is the earlier of the time stamp on this message, or
    // or the time reported in the message from YoLink. We use this to
    // only log (in like mode), when we have an update.
    if (this.lastReportAtTime < this.reportAtTime.getTime()) {
      this.lastReportAtTime = this.reportAtTime.getTime();
      this.platform.log.info(`At ${this.reportAtTime.toLocaleString()}: Device state for ${this.deviceMsgName} is: ${msg}`);
    } else {
      this.platform.liteLog(`At ${this.reportAtTime.toLocaleString()}: Device state for ${this.deviceMsgName} is: ${msg}`);
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
  async refreshDataTimer(handleGet) {
    const platform: YoLinkHomebridgePlatform = this.platform;
    const device = this.accessory.context.device;

    platform.verboseLog(`Data refresh timer for ${this.deviceMsgName} fired`);

    await handleGet.bind(this)();

    if (this.config.refreshAfter >= 60) {
      // We don't allow for regular updates any more frequently than once a minute. And the
      // timer will wait for at least one second before firing again to avoid runaway loops.
      const nextUpdateIn = (device.updateTime) ? Math.max(1, device.updateTime - Math.floor(new Date().getTime() / 1000)) : 60;
      // If there was no device.updateTime then error occurred, so default to 60 seconds.
      platform.verboseLog(`Set data refresh timer for ${this.deviceMsgName} to run in ${nextUpdateIn} seconds`);
      setTimeout( () => {
        this.refreshDataTimer(handleGet);
      }, nextUpdateIn * 1000);
    }
  }

  /***********************************************************************
   * updateBatteryInfo
   *
   */
  updateBatteryInfo(this: YoLinkPlatformAccessory) {
    const platform: YoLinkHomebridgePlatform = this.platform;
    let batteryLevel = 100;

    try {
      if (this.hasBattery) {
        // Some devices wrap battery information under a 'state' object.
        // If nothing defined then assume 100%
        batteryLevel = ((this.accessory.context.device.data.battery ?? this.accessory.context.device.data.state.battery) ?? 100) * 25;
        const msg = `Battery level for ${this.deviceMsgName} is: ${batteryLevel-25}..${batteryLevel}%`;
        if (batteryLevel <= 25) {
          this.batteryService.updateCharacteristic(platform.Characteristic.StatusLowBattery,
            platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
          this.platform.log.warn(msg);
        } else {
          this.batteryService.updateCharacteristic(platform.Characteristic.StatusLowBattery,
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
  async handleBatteryGet(this: YoLinkPlatformAccessory): Promise<CharacteristicValue> {
    const device = this.accessory.context.device;
    const platform = this.platform;
    // serialize access to device data.
    const releaseSemaphore = await this.deviceSemaphore.acquire();
    let rc = 100;
    try {
      if (await this.checkDeviceState(platform, device)) {
        rc = this.updateBatteryInfo.bind(this)();
      }
    } catch(e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in handleBatteryGet' + platform.reportError + msg);
    } finally {
      await releaseSemaphore();
    }
    return (rc);
  }
  /*********************************************************************
   * handleIdentifySet
   *
   */

  async handleIdentifySet(this: YoLinkPlatformAccessory, value): Promise<void> {
    const platform = this.platform;
    // serialize access to device data.
    const releaseSemaphore = await this.deviceSemaphore.acquire();
    try {
      platform.log.info(`YoLink Device: ${this.deviceMsgName} identify '${value}' (unsupported)`);
    } catch(e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in handleIdentitySet' + platform.reportError + msg);
    } finally {
      await releaseSemaphore();
    }
  }

  /*********************************************************************
   * mqttMessage
   *
   */
  async mqttMessage(message): Promise<void> {
    const device = this.accessory.context.device;
    const platform = this.platform;
    try {
      if (device.data) {
        // reportAtTime is the earlier of the time stamp on this message, or
        // or the time reported in the message from YoLink. We use this to
        // only log (in like mode), when we have an update.
        const msgTime = new Date(parseInt(message.msgid));
        const repTime = new Date(message.data?.reportAt ?? '9999-12-31');
        this.reportAtTime = (msgTime < repTime) ? msgTime : repTime;
        this.updateBatteryInfo.bind(this)();
        if (mqttHandler[device.type]) {
          mqttHandler[device.type].bind(this)(message);
        } else {
          mqttUnknownDevice.bind(this)(message);
        }
      } else {
        platform.log.warn(`MQTT: ${message.event} for uninitialized device ${this.deviceMsgName}`
                           + platform.reportError + JSON.stringify(message));
      }
    } catch(e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in mqttMessage' + platform.reportError + msg);
    }
    return;
  }
}
