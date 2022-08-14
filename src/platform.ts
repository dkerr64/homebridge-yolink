/***********************************************************************
 * YoLink Homebridge Platform class
 *
 * Copyright (c) 2022 David Kerr
 *
 * Based on https://github.com/homebridge/homebridge-plugin-template
 *
 * This class is the main constructor for the plugin.
 */

import { API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME,
  PLUGIN_NAME,
  YOLINK_MQTT_PORT,
  YOLINK_API_URL,
  YOLINK_TOKEN_URL,
  YOLINK_REFRESH_INTERVAL,
} from './settings';

import { YoLinkPlatformAccessory } from './platformAccessory';
import { YoLinkAPI } from './yolinkAPI';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const issuesURL = require('../package.json').bugs.url;
Error.stackTraceLimit = 100;

export class YoLinkHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  private readonly accessories: PlatformAccessory[] = [];
  private readonly yolinkDevices: YoLinkPlatformAccessory[] = [];

  public yolinkAPI: YoLinkAPI;

  public reportError = '\nPlease report all bugs at ' + issuesURL + '\n';

  /*********************************************************************
   * constructor
   *
   */
  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API) {
    // transforms array of devices into object that can be referrenced by deviceId...
    const devices = {};
    if (this.config.devices) {
      this.config.devices.forEach(x => devices[x.deviceId] = x.config);
    }
    this.config.devices = devices;
    this.config.verboseLog ??= false;
    this.config.liteLog ??= true;
    this.config.allDevices ??= true;
    this.config.mqttPort ??= YOLINK_MQTT_PORT;
    this.config.apiURL ??= YOLINK_API_URL;
    this.config.tokenURL ??= YOLINK_TOKEN_URL;
    this.config.refreshAfter ??= YOLINK_REFRESH_INTERVAL;

    this.log.info('YoLink plugin for HomeBridge (c) 2022 David A. Kerr' + this.reportError);
    this.log.debug('Loaded configuaration: ' + JSON.stringify(this.config));

    this.yolinkAPI = new YoLinkAPI(this);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      this.verboseLog('Executing didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  /*********************************************************************
   * This function is invoked when homebridge restores cached accessories
   * from disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.verboseLog('Loading accessory from cache:' + accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }


  /*********************************************************************
   * verboseLog
   */
  verboseLog(msg: string) {
    if (this.config.verboseLog) {
      this.log.info(`[verbose] ${msg}`);
    } else {
      this.log.debug(`[verbose] ${msg}`);
    }
  }

  /*********************************************************************
   * liteLog
   */
  liteLog(msg: string) {
    if (this.config.liteLog) {
      this.verboseLog(`[lite] ${msg}`);
    } else {
      this.log.info(`[lite] ${msg}`);
    }
  }

  /*********************************************************************
   * discoverDevices
   */
  async discoverDevices() {

    if (!await this.yolinkAPI.login(this)) {
      // If login failed an error message will have been displayed in the
      // Homebridge log. Pointless to continue.
      return;
    }

    const deviceList = await this.yolinkAPI.getDeviceList(this);
    if (!deviceList) {
      // Should never occur if we successfully logged in.
      this.log.error('failed to retrieve list of devices from server');
      return;
    }

    // Remove accessories from cache if they are no longer in list of
    // devices retrieved from YoLink.
    for (const accessory of this.accessories) {
      const device = accessory.context.device;
      if (!deviceList.find(x => x.deviceId === device.deviceId)) {
        this.log.warn(`Removing accessory from cache: ${accessory.displayName} (${device.deviceId}), device does not exist`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of deviceList) {
      this.log.debug(JSON.stringify(device));
      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address.
      const uuid = this.api.hap.uuid.generate(device.deviceId);

      if (this.config.devices[device.deviceId]) {
        if (this.config.devices[device.deviceId].name) {
          device.name = this.config.devices[device.deviceId].name;
        }
      }

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above.
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
      const skip = (!this.config.allDevices && !this.config.devices[device.deviceId])
                 || (this.config.devices[device.deviceId] && (this.config.devices[device.deviceId].hide === true
                                                            ||this.config.devices[device.deviceId].hide === 'true'));
      // If "hide" is not true then we will add the accessory and the individual handler
      // can decide what to do.

      if (skip) {
        if (existingAccessory){
          this.log.warn(`Remove accessory from cache as config 'hide=true' for: ${existingAccessory.displayName} (${device.deviceId})`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        }
      } else {
        let deviceClass;
        if (existingAccessory){
          // update existing accessory
          this.verboseLog(`Restoring accessory from cache: ${existingAccessory.displayName} (${device.deviceId})`);
          existingAccessory.context.device = device;
          this.api.updatePlatformAccessories([existingAccessory]);
          deviceClass = new YoLinkPlatformAccessory(this, existingAccessory);
        } else {
          // create a new accessory
          this.log.info(`Adding new accessory: ${device.name} (${device.deviceId})`);
          const accessory = new this.api.platformAccessory(device.name, uuid);
          accessory.context.device = device;
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          deviceClass = new YoLinkPlatformAccessory(this, accessory);
        }
        this.yolinkDevices.push(deviceClass);
      }
    }

    // Now connect to YoLink MQTT server and subscribe to messages
    await this.yolinkAPI.mqtt(this, (message) => {
      // This function is called for every message received over MQTT
      const data = JSON.parse(message);
      // Find the device in the yolinkDevices list
      const yolinkDevice = this.yolinkDevices.find(x => x.deviceId === data.deviceId);
      // pass the message on to the appropriate device accessory if it exists.
      if (yolinkDevice) {
        yolinkDevice.mqttMessage(data);
      } else {
        // If a device is hidden (not loaded into homebridge) then we may receive
        // messages for it... which is perfectly okay, but worth logging.
        this.verboseLog(`mqtt received message for unknown device (${data.deviceId})`);
      }
    });

  }
}
