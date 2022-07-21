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

import { Service, PlatformAccessory } from 'homebridge';
import { YoLinkHomebridgePlatform } from './platform';
import Semaphore from 'semaphore-promise';
import { mqttHandler } from './deviceHandlers';

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

  constructor(
    readonly platform: YoLinkHomebridgePlatform,
    readonly accessory: PlatformAccessory,
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

    return(this);
  }

  /*********************************************************************
   * checkDeviceState
   * Updates device status object, sending a request to the YoLink API if we
   * have no data yet, or it has been a long time since the data was updated.
   */
  async checkDeviceState(platform, device) {
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
   * mqttMessage
   *
   */
  async mqttMessage(data): Promise<void> {
    const device = this.accessory.context.device;
    const platform = this.platform;

    platform.log.info('Received mqtt message \'' + data.event + '\' for device: '
                          + device.name + ' (' + device.deviceId + ')'
                          + ' State: \'' + data.data.state + '\'');

    if (device.data && mqttHandler[device.type]) {
      mqttHandler[device.type](this, data);
    } else {
      platform.log.warn('Unsupported mqtt event: \'' + data.event + '\'\n'
                      + 'Please report at https://github.com/dkerr64/homebridge-yolink/issues\n'
                      + ((data)?JSON.stringify(data):''));
    }
    return;
  }
}
