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

export class YoLinkPlatformAccessory {
  private deviceService!: Service;
  private infoService!: Service;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private config!: {
    [key: string]: any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  private deviceSemaphore;
  public deviceId;

  constructor(
    private readonly platform: YoLinkHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const device = accessory.context.device;
    this.deviceId = device.deviceId;
    this.config = platform.config.devices[device.deviceId] ? platform.config.devices[device.deviceId] : {};
    this.config.refreshAfter ??= (platform.config.refreshAfter ??= 3600);

    // We need to serialize requests to YoLink API for each device.  Multiple threads
    // can request state updates for a devices at the same time.  YoLink API doesn't
    // like this so we need a semaphore to make sure we don't send a 2nd request to
    // the same device before prior one has completed.
    this.deviceSemaphore = new Semaphore();

    // set accessory information
    this.infoService = this.accessory.getService(platform.Service.AccessoryInformation)!;
    this.infoService
      .setCharacteristic(platform.Characteristic.Manufacturer, 'YoLink')
      .setCharacteristic(platform.Characteristic.Model, (this.config.model) ? this.config.model : 'n/a')
      .setCharacteristic(platform.Characteristic.SerialNumber, device.deviceId);

    // Now set up for each device type
    switch (device.type) {
      //================================================================
      case 'LeakSensor':
        this.deviceService = this.accessory.getService(platform.Service.LeakSensor)
                          || this.accessory.addService(platform.Service.LeakSensor);
        this.deviceService.setCharacteristic(platform.Characteristic.Name, device.name);
        this.deviceService.getCharacteristic(platform.Characteristic.LeakDetected)
          .onGet(this.handleLeakDetectedGet.bind(this));
        // Call onGet handler to initialize data fields to current state
        this.handleLeakDetectedGet();
        break;
      //================================================================
      case 'VibrationSensor':
        // Homebridge/HomeKit does not have vibration sensor type.
        // Will use motion sensor type as a substitute.
        // falls through
      case 'MotionSensor':
        this.deviceService = this.accessory.getService(platform.Service.MotionSensor)
          || this.accessory.addService(platform.Service.MotionSensor);
        this.deviceService.setCharacteristic(platform.Characteristic.Name, device.name);
        this.deviceService.getCharacteristic(platform.Characteristic.MotionDetected)
          .onGet(this.handleMotionDetectedGet.bind(this));
        // Call onGet handler to initialize data fields to current state
        this.handleMotionDetectedGet();
        break;
      //================================================================
      case 'Manipulator':
        this.deviceService = this.accessory.getService(platform.Service.Valve)
          || this.accessory.addService(platform.Service.Valve);
        this.deviceService.setCharacteristic(platform.Characteristic.Name, device.name);
        this.deviceService.getCharacteristic(platform.Characteristic.Active)
          .onGet(this.handleValveActiveGet.bind(this))
          .onSet(this.handleValveActiveSet.bind(this));
        this.deviceService.getCharacteristic(platform.Characteristic.InUse)
          .onGet(this.handleValveInUseGet.bind(this));
        this.deviceService.getCharacteristic(platform.Characteristic.ValveType)
          .onGet(this.handleValveTypeGet.bind(this));
        // Call onGet handler to initialize data fields to current state
        this.handleValveActiveGet();
        break;
      //================================================================
      // Add new devices here, before default case.
      default:
        platform.log.warn('YoLink device type: \'' + device.type + '\''
                                + ' is not supported by this plugin (deviceID: ' + device.deviceId + ')\n'
                                + 'Please report at https://github.com/dkerr64/homebridge-yolink/issues\n'
                                + JSON.stringify(device));
    }
    return(this);
  }

  /*********************************************************************
   * _checkDeviceState
   * Updates device status object, sending a request to the YoLink API if we
   * have no data yet, or it has been a long time since the data was updated.
   */
  async _checkDeviceState(platform, device) {
    platform.verboseLog('checkDeviceState for ' + device.name
                          + ' (refresh after ' + this.config.refreshAfter + ' seconds)');

    const timestamp = Math.floor(new Date().getTime() / 1000);
    if (!device.data
        || (this.config.refreshAfter === 0)
        || ((this.config.refreshAfter > 0) && (timestamp > device.updateTime))) {
      // If we have never retrieved data from the device, or data is older
      // than period we want to allow, then retireve new data from the device.
      // Else return with data unchanged.
      device.data = await platform.yolinkAPI.getDeviceState(platform, device);
      if (device.data) {
        device.updateTime = timestamp + this.config.refreshAfter;
      }
    }
  }

  /*********************************************************************
   * handleMotionDetectGet
   *
   */
  async handleMotionDetectedGet(): Promise<CharacteristicValue> {
    // serialize access to device data.
    const releaseSemaphore = await this.deviceSemaphore.acquire();
    const platform = this.platform;

    const device = this.accessory.context.device;
    await this._checkDeviceState(platform, device);
    // some device characteristics may have changed, update it.
    this.infoService
      .setCharacteristic(platform.Characteristic.FirmwareRevision, device.data.state.version);
    this.deviceService
      .updateCharacteristic(platform.Characteristic.StatusLowBattery, (device.data.state.battery <= 1)
        ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    platform.liteLog('Device state for ' + device.name + ' (' + device.deviceId + ') is: ' + device.data.state.state);

    await releaseSemaphore();
    return (device.data.state.state === 'alert');
  }

  /*********************************************************************
   * handleLeakDetectGet
   *
   */
  async handleLeakDetectedGet(): Promise<CharacteristicValue> {
    // serialize access to device data.
    const releaseSemaphore = await this.deviceSemaphore.acquire();
    const platform = this.platform;

    const device = this.accessory.context.device;
    await this._checkDeviceState(platform, device);
    // some device characteristics may have changed, update it.
    this.infoService
      .setCharacteristic(platform.Characteristic.FirmwareRevision, device.data.state.version);
    this.deviceService
      .updateCharacteristic(platform.Characteristic.StatusLowBattery, (device.data.state.battery <= 1)
        ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    platform.liteLog('Device state for ' + device.name + ' (' + device.deviceId + ') is: ' + device.data.state.state);

    await releaseSemaphore();
    return ((device.data.state.state === 'alert')
      ? platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED
      : platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
  }

  /*********************************************************************
   * handleValve events
   *
   */
  async handleValveInUseGet(): Promise<CharacteristicValue> {
    const device = this.accessory.context.device;
    // Not sure exactly what "in use" is for.  Should I always return true?
    this.platform.verboseLog('Valve in use state for ' + device.name + ' (' + device.deviceId + '), calling isActive?');
    return(await this.handleValveActiveGet());
  }

  async handleValveActiveGet(): Promise<CharacteristicValue> {
    // serialize access to device data.
    const releaseSemaphore = await this.deviceSemaphore.acquire();
    const platform = this.platform;

    const device = this.accessory.context.device;
    await this._checkDeviceState(platform, device);
    // some device characteristics may have changed, update it.
    this.infoService
      .setCharacteristic(platform.Characteristic.FirmwareRevision, device.data.version);
    this.deviceService
      .updateCharacteristic(platform.Characteristic.StatusLowBattery, (device.data.battery <= 1)
        ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    platform.liteLog('Device state for ' + device.name + ' (' + device.deviceId + ') is: ' + device.data.state);

    await releaseSemaphore();
    return ((device.data.state === 'open')
      ? platform.api.hap.Characteristic.Active.ACTIVE
      : platform.api.hap.Characteristic.Active.INACTIVE);
  }

  async handleValveActiveSet(value: CharacteristicValue) {
    // serialize access to device data.
    const releaseSemaphore = await this.deviceSemaphore.acquire();
    const device = this.accessory.context.device;
    const platform = this.platform;

    platform.verboseLog('setDeviceState for ' + device.name + ' (' + device.deviceId + ')');

    const newState = (value === platform.api.hap.Characteristic.Active.ACTIVE) ? 'open' : 'close';
    const data = await platform.yolinkAPI.setDeviceState(platform, device, {'state':newState});

    // Should I now force next call to handle a Get request to request status from YoLink?
    // Or just set device.data.state to data.state, which should have come back from the
    // server on this call.
    device.data.state = (data) ? data.state : '';

    await releaseSemaphore();
  }

  async handleValveTypeGet(): Promise<CharacteristicValue> {
    return this.platform.Characteristic.ValveType.GENERIC_VALVE;
  }


  /*********************************************************************
   * mqtt events
   *
   */
  async mqttMessage(topic, data) {
    const device = this.accessory.context.device;
    const platform = this.platform;

    platform.log.info('Received event \'' + data.event + '\' for device: '
                          + device.name + ' (' + device.deviceId + ')'
                          + ' State: \'' + data.data.state + '\'');
    if (!device.data) {
      platform.log.error('No device.data field to update, ignoring mqtt message');
      return;
    }

    const _msgWarn = (data) => {
      platform.log.warn('Unsupported mqtt event: \'' + data.event + '\'\n'
                              + 'Please report at https://github.com/dkerr64/homebridge-yolink/issues\n'
                              + JSON.stringify(data));
    };

    // serialize access to device data.
    const releaseSemaphore = await this.deviceSemaphore.acquire();

    const event = data.event.split('.');
    const timestamp = Math.floor(new Date().getTime() / 1000);
    device.updateTime = timestamp + this.config.refreshAfter;

    switch (event[0]) {
      //================================================================
      case 'LeakSensor':
        switch (event[1]) {
          case 'Alert':
            // falls through
          case 'Report':
            device.data.state.battery = data.data.battery;
            device.data.state.state = data.data.state;

            this.deviceService
              .updateCharacteristic(platform.Characteristic.StatusLowBattery,
                (data.data.battery <= 1)
                  ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                  : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
              .updateCharacteristic(platform.Characteristic.LeakDetected,
                (data.data.state === 'alert')
                  ? platform.api.hap.Characteristic.LeakDetected.LEAK_DETECTED
                  : platform.api.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
            break;
          default:
            _msgWarn(data);
        }
        break;
      //================================================================
      case 'VibrationSensor':
        // falls through
      case 'MotionSensor':
        switch (event[1]) {
          case 'Alert':
            // falls through
          case 'Report':
            // falls through
          case 'StatusChange':
            device.data.state.battery = data.data.battery;
            device.data.state.state = data.data.state;
            this.deviceService
              .updateCharacteristic(platform.Characteristic.StatusLowBattery,
                (data.data.battery <= 1)
                  ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                  : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
              .updateCharacteristic(platform.Characteristic.MotionDetected,
                (data.data.state === 'alert') ? true : false );
            break;
          case 'setOpenRemind':
            // I don't know what this is intended for.  I have seen it from the YoLink
            // outdoor motion sensor.  It does not carry either motion state or battery
            // state fields, so there is nothing we can update.  Sample packet...
            // {"event":"MotionSensor.setOpenRemind","time":1658089933504,"msgid":"1658089933504",
            // "data":{"alertInterval":1,"ledAlarm":false,"nomotionDelay":1,"sensitivity":2,
            // "loraInfo":{"signal":-87,"gatewayId":"<redacted>","gateways":1}},"deviceId":"<redacted>"}
            break;
          default:
            _msgWarn(data);
        }
        break;
      //================================================================
      case 'Manipulator':
        switch (event[1]) {
          case 'Report':
            // falls through
          case 'getState':
            device.data.battery = data.data.battery;
            this.deviceService
              .updateCharacteristic(platform.Characteristic.StatusLowBattery,
                (data.data.battery <= 1)
                  ? platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                  : platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
            // falls through
          case 'setState':
            device.data.state = data.data.state;
            this.deviceService
              .updateCharacteristic(platform.Characteristic.Active,
                (data.data.state === 'open') ? platform.api.hap.Characteristic.Active.ACTIVE
                  : platform.api.hap.Characteristic.Active.INACTIVE);
            break;
          default:
            _msgWarn(data);
        }
        break;
      //================================================================
      // Add new devices here, before default case.
      default:
        _msgWarn(data);
    }

    await releaseSemaphore();
  }
}
