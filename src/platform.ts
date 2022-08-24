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
const packageJSON = require('../package.json');

export class YoLinkHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  private readonly accessories: PlatformAccessory[] = [];
  private readonly deviceAccessories: YoLinkPlatformAccessory[] = [];

  public yolinkAPI: YoLinkAPI;

  public reportError = '\nPlease report all bugs at ' + packageJSON.bugs.url + '\n';

  /*********************************************************************
   * constructor
   *
   */
  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API) {

    Error.stackTraceLimit = 100;
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
    this.config.version ??= packageJSON.version;
    this.config.garageDoors ??= [];

    this.log.info(`YoLink plugin for HomeBridge version ${packageJSON.version} (c) 2022 David A. Kerr${this.reportError}`);
    this.verboseLog(`Loaded configuaration:\n${JSON.stringify(this.config)}`);

    this.yolinkAPI = new YoLinkAPI(this);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
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
      if (this.config.verboseLog) {
        this.log.info(`${msg} [lite]`);
      } else {
        this.log.debug(`${msg} [lite]`);
      }
    } else {
      this.log.info(`${msg} [lite]`);
    }
  }

  /*********************************************************************
   * discoverDevices
   */
  async discoverDevices() {
    try {
      await this.yolinkAPI.login(this);
      await this.registerDevices(await this.yolinkAPI.getDeviceList(this));
      await this.registerMqtt();
    } catch(e) {
      const msg = (e instanceof Error) ? e.stack : e;
      this.log.error('Fatal error during YoLink plugin initialization:\n' + msg);
    }
  }

  /*********************************************************************
   * registerDevices
   */
  async registerDevices(deviceList) {
    // Remove accessories from cache if they are no longer in list of
    // devices retrieved from YoLink.
    for (const accessory of this.accessories) {
      const device = accessory.context.device;
      if (!deviceList.some(x => x.deviceId === device.deviceId)) {
        this.log.warn(`Removing accessory from cache: ${accessory.displayName} (${device.deviceId}), device does not exist`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of deviceList) {
      this.verboseLog(JSON.stringify(device));
      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address.
      const uuid = this.api.hap.uuid.generate(device.deviceId);
      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above.
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (this.config.devices[device.deviceId]) {
        device.name = this.config.devices[device.deviceId].name ?? device.name;
      }

      // If device is assigned to a garage door then hide it as we will
      // handle those as special case.
      let skip = false;
      if (this.config.garageDoors?.some(x => (x.sensor === device.deviceId || x.controller === device.deviceId))) {
        this.log.info(`Device ${device.name} (${device.deviceId}) assigned to a Garage Door`);
        skip = true;
      }
      skip = skip || (!this.config.allDevices && !this.config.devices[device.deviceId])
                  || (this.config.devices[device.deviceId]
                      && (this.config.devices[device.deviceId].hide === true || this.config.devices[device.deviceId].hide === 'true'));

      if (skip) {
        if (existingAccessory){
          this.log.warn(`Remove accessory from cache as config 'hide=true' for: ${existingAccessory.displayName} (${device.deviceId})`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        }
      } else {
        let accessoryClass;
        if (existingAccessory){
          // update existing accessory
          this.verboseLog(`Restoring accessory from cache: ${existingAccessory.displayName} (${device.deviceId})`);
          existingAccessory.context.device = device;
          this.api.updatePlatformAccessories([existingAccessory]);
          accessoryClass = new YoLinkPlatformAccessory(this, existingAccessory);
        } else {
          // create a new accessory
          this.log.info(`Adding new accessory: ${device.name} (${device.deviceId})`);
          const accessory = new this.api.platformAccessory(device.name, uuid);
          accessory.context.device = device;
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          accessoryClass = new YoLinkPlatformAccessory(this, accessory);
        }
        this.deviceAccessories.push(accessoryClass);
      }
    }

    // Now handle garage doors... two devices bound together
    try {
      for (const accessory of this.accessories) {
        const device = accessory.context.device;
        const device2 = accessory.context.device2;
        if (device2) {
          if (!this.config.garageDoors?.some(x => x.controller === device.deviceId && x.sensor === device2.deviceId)) {
            this.log.warn(`Removing Garage Door accessory from cache: ${accessory.displayName} (${device.deviceId} & ${device2.deviceId})`);
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }
        }
      }
      for (const garage of this.config.garageDoors) {
      // check that sensor and controller are in our device list
        const garageDevices = deviceList.filter(x => (x.deviceId === garage.controller || x.deviceId === garage.sensor));
        if (garageDevices.length !== 2) {
          throw new Error(`Garage Door must have two known devices.  Ignoring this door:\n${JSON.stringify(garage)}`);
        }
        const controller = garageDevices.find(x => x.deviceId === garage.controller);
        const sensor = garageDevices.find(x => x.deviceId === garage.sensor);
        if (sensor.type !== 'DoorSensor' || !(controller.type === 'Finger' || controller.type === 'GarageDoor')) {
          throw new Error('Garage Door sensor must be of type \'DoorSensor\' and controller of type \'Finger\' or \'GarageDoor\'');
        }
        const uuid = this.api.hap.uuid.generate(`${garage.controller}${garage.sensor}`);
        // see if an accessory with the same uuid has already been registered and restored from
        // the cached devices we stored in the `configureAccessory` method above.
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

        let accessoryClass;
        if (existingAccessory){
          // update existing accessory
          this.verboseLog(`Restoring accessory from cache: ${existingAccessory.displayName} ` +
                          `(Controler: ${garage.controller}, Sensor: ${garage.sensor})`);
          existingAccessory.context.device = controller;
          existingAccessory.context.device2 = sensor;
          this.api.updatePlatformAccessories([existingAccessory]);
          accessoryClass = new YoLinkPlatformAccessory(this, existingAccessory);
        } else {
          // create a new accessory
          this.log.info(`Adding new accessory: ${controller.name} ` +
                        `(Controler: ${garage.controller}, Sensor: ${garage.sensor})`);
          const accessory = new this.api.platformAccessory(controller.name, uuid);
          accessory.context.device = controller;
          accessory.context.device2 = sensor;
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          accessoryClass = new YoLinkPlatformAccessory(this, accessory);
        }
        this.deviceAccessories.push(accessoryClass);
      }
    } catch(e) {
      const msg = String((e instanceof Error) ? e.message : e);
      this.log.error(msg);
    }
  }

  /*********************************************************************
   * registerMqtt
   */
  async registerMqtt() {
    // Now connect to YoLink MQTT server and subscribe to messages
    this.yolinkAPI.mqtt(this, (message) => {
      // This function is called for every message received over MQTT
      const data = JSON.parse(message);
      // Find the device in the deviceAccessories list
      const deviceAccessory = this.deviceAccessories.find(x => x.deviceId === data.deviceId || x.deviceId2 === data.deviceId);
      // pass the message on to the appropriate device accessory if it exists.
      if (deviceAccessory) {
        deviceAccessory.mqttMessage(data);
      } else {
        // If a device is hidden (not loaded into homebridge) then we may receive
        // messages for it... which is perfectly okay, but worth logging.
        this.log.info(`MQTT received ${message.event} message for unknown device (${data.deviceId})`);
      }
    });
  }

}
