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
import { initDeviceService, mqttHandler, experimentalDevice} from './deviceHandlers';

Error.stackTraceLimit = 100;

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
    const device = accessory.context.device;
    this.deviceId = device.deviceId;
    this.deviceMsgName = `${device.name} (${device.deviceId})`;
    this.config = platform.config.devices[device.deviceId] ? platform.config.devices[device.deviceId] : {};
    this.config.refreshAfter ??= (platform.config.refreshAfter ??= 3600);
    this.config.enableExperimental ??= (platform.config.enableExperimental ??= false);

    // We need to serialize requests to YoLink API for each device.  Multiple threads
    // can request state updates for a devices at the same time.  This would not be good,
    // so we need a semaphore to make sure we don't send a 2nd request to the same
    // device before prior one has completed.
    this.deviceSemaphore = new Semaphore();

    // Set accessory information
    this.infoService = this.accessory.getService(platform.Service.AccessoryInformation)!;
    this.infoService
      .setCharacteristic(platform.Characteristic.Manufacturer, 'YoLink')
      .setCharacteristic(platform.Characteristic.Model, (this.config.model) ? this.config.model : 'n/a')
      // YoLink does not return device serial number in the API, use deviceId instead.
      .setCharacteristic(platform.Characteristic.SerialNumber, device.deviceId);

    // All (almost all?) YoLink devices are battery powered, so makes sense to include
    // battery level service.  YoLink reports 0..4, we will convert to 0,25,50,75,100 percent
    this.batteryService = accessory.getService(platform.Service.Battery)
                       || accessory.addService(platform.Service.Battery);
    this.batteryService
      .setCharacteristic(platform.Characteristic.Name, device.name)
      .setCharacteristic(platform.Characteristic.ChargingState, platform.api.hap.Characteristic.ChargingState.NOT_CHARGEABLE)
      .setCharacteristic(platform.Characteristic.BatteryLevel, 100);
    this.batteryService
      .getCharacteristic(platform.Characteristic.BatteryLevel).onGet(this.handleBatteryGet.bind(this));

    // Now initialize each device type, creating the homebridge services as required.
    if (initDeviceService[device.type] && (!experimentalDevice[device.type] || this.config.enableExperimental)) {
      initDeviceService[device.type].bind(this)();
    } else {
      platform.log.warn('YoLink device type: \'' + device.type + '\' is not supported by this plugin (deviceID: ' + device.deviceId + ')'
      + platform.reportError + JSON.stringify(device));
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
        device.data = await platform.yolinkAPI.getDeviceState(platform, device);
        if (device.data) {
          device.updateTime = timestamp + this.config.refreshAfter;
          platform.log.info(`checkDeviceState received data for ${this.deviceMsgName}`);
        }
      }
    } catch(e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in checkDeviceState' + platform.reportError + msg);
    }
    return(device.data);
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
      platform.liteLog(`Set data refresh timer for ${this.deviceMsgName} to run in ${nextUpdateIn} seconds`);
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
    if (await this.checkDeviceState(platform, device)) {
      rc = this.updateBatteryInfo.bind(this)();
    }
    await releaseSemaphore();
    return (rc);
  }

  /*********************************************************************
   * mqttMessage
   *
   */
  async mqttMessage(message): Promise<void> {
    const device = this.accessory.context.device;
    const platform = this.platform;
    try {
      platform.log.info(`Received mqtt message '${message.event}' for device: ${this.deviceMsgName} State: '${message.data.state}'`);
      if (device.data && mqttHandler[device.type]) {
        mqttHandler[device.type].bind(this)(message);
      } else {
        platform.log.warn('Unsupported mqtt event: \'' + message.event + '\'' + platform.reportError + JSON.stringify(message));
      }
    } catch(e) {
      const msg = (e instanceof Error) ? e.stack : e;
      platform.log.error('Error in mqttMessage' + platform.reportError + msg);
    }
    return;
  }
}
