/***********************************************************************
 * YoLink Homebridge Platform class
 *
 * Copyright (c) 2022 David Kerr
 *
 * Based on https://github.com/homebridge/homebridge-plugin-template
 *
 * This class is the main constructor for the plugin.
 */

import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  YOLINK_MQTT_PORT,
  YOLINK_API_URL,
  YOLINK_TOKEN_URL,
  YOLINK_REFRESH_INTERVAL,
} from './settings';

import { YoLinkPlatformAccessory } from './platformAccessory';
import { YoLinkAPI } from './yolinkAPI';
import Semaphore from 'semaphore-promise';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJSON = require('../package.json');

export type YoLinkDevice = {
  deviceId: string;
  deviceUDID: string;
  name: string;
  token: string;
  type: string;
  parentDeviceId: string;
  semaphore: Semaphore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

export class YoLinkHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  private readonly accessories: PlatformAccessory[] = [];
  private readonly deviceAccessories: YoLinkPlatformAccessory[] = [];

  // track known devices so we can detect new ones.
  private readonly knownDevices: string[] = [];
  private readonly addDeviceSemaphore = new Semaphore();

  public readonly yolinkAPI: YoLinkAPI;
  // We need to serialize requests to YoLink API.  Multiple threads can request state
  // updates for a device at the same time.  This would not be good, so we need a
  // semaphore to make sure we don't send a 2nd request before prior one has completed.
  // using a global semaphore rather than per-device to fix YoLink 000201 errors.
  public readonly yolinkRequestSemaphore = new Semaphore();

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
    // transforms array of devices into object that can be referenced by deviceId...
    const devices = {};
    if (this.config.devices) {
      this.config.devices.forEach(x => devices[String(x.deviceId).toLowerCase()] = x.config);
    }
    this.config.devices = devices;
    this.config.verboseLog = this.makeBoolean(this.config.verboseLog, false);
    this.config.liteLog = this.makeBoolean(this.config.liteLog, true);
    this.config.allDevices = this.makeBoolean(this.config.allDevices, true);
    this.config.excludeTypes ??= ['Hub', 'SpeakerHub'];
    this.config.includeTypes ??= [];
    this.config.enableExperimental = this.makeBoolean(this.config.enableExperimental, false);
    this.config.deviceTemperatures = this.makeBoolean(this.config.deviceTemperatures, false);
    this.config.powerFailureSensorAs ??= 'Outlet';
    this.config.mqttPort ??= YOLINK_MQTT_PORT;
    this.config.apiURL ??= YOLINK_API_URL;
    this.config.tokenURL ??= YOLINK_TOKEN_URL;
    this.config.version ??= packageJSON.version;
    this.config.garageDoors ??= [];
    this.config.refreshAfter ??= YOLINK_REFRESH_INTERVAL;
    this.config.checkNewDeviceInterval ??= 0;

    this.log.info(`YoLink plugin for HomeBridge version ${packageJSON.version} (c) 2022 David A. Kerr${this.reportError}`);
    this.verboseLog(`Loaded configuration:\n${JSON.stringify(this.config, null, 2)}`);

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
   * makeBoolean
   * Allow for both 'true' as a boolean and "true" as a string to equal
   * true.  And provide a default for when it is undefined.
   */
  makeBoolean(a, b: boolean): boolean {
    return (typeof a === 'undefined') ? b : String(a).toLowerCase() === 'true' || a === true;
  }


  /*********************************************************************
   * discoverDevices
   */
  async discoverDevices() {
    try {
      await this.yolinkAPI.login(this);
      await this.registerDevices();
      await this.registerMqtt();
    } catch (e) {
      const msg = (e instanceof Error) ? e.stack : e;
      this.log.error('Fatal error during YoLink plugin initialization:\n' + msg);
    }
  }

  /*********************************************************************
   * registerDevices
   */
  async registerDevices() {
    const deviceList: YoLinkDevice[] = await this.yolinkAPI.getDeviceList(this);
    this.removeDeletedDevices(deviceList);

    // loop over the discovered devices and register each one
    for (const device of deviceList) {
      this.checkAddDevice(device);
    }

    // Now handle garage doors... two devices bound together. Start by removing
    // any existing garage door accessory that may no longer be configured.
    for (const accessory of this.accessories) {
      const device: YoLinkDevice = accessory.context.device;
      const device2: YoLinkDevice = accessory.context.device2;
      if (device2) {
        // Delete any existing garage door accessories that do not exactly match one
        // that we have setup in the config file.
        if (!this.config.garageDoors?.some(x => x.controller === device.deviceId && x.sensor === device2.deviceId)) {
          this.log.warn(`Removing Garage Door accessory from cache: ${accessory.displayName} (${device.deviceId} & ${device2.deviceId})`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
    }

    // Now add each garage door accessory
    for (const garage of this.config.garageDoors) {
      // check that sensor and controller are in our device list
      const garageDevices = deviceList.filter(x => (x.deviceId === garage.controller || x.deviceId === garage.sensor));
      if (garageDevices.length !== 2) {
        this.log.warn(`Garage Door must have two known devices. Ignoring this door:\n${JSON.stringify(garage, null, 2)}`);
        continue;
      }
      const controller = garageDevices.find(x => x.deviceId === garage.controller);
      const sensor = garageDevices.find(x => x.deviceId === garage.sensor);
      if (sensor?.type !== 'DoorSensor' || !(controller?.type === 'Finger' || controller?.type === 'GarageDoor')) {
        this.log.warn('Garage Door sensor must be of type \'DoorSensor\' and controller of type \'Finger\' or \'GarageDoor\' ' +
          `Check config file for deviceID typo. Ignoring this door:\n${JSON.stringify(garage, null, 2)}`);
        continue;
      }
      sensor.timeout = garage.timeout;

      const uuid = this.api.hap.uuid.generate(`${garage.controller}${garage.sensor}`);
      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above.
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
      this.addDevice(controller, uuid, existingAccessory, sensor);
      this.verboseLog(`Door Sensor: ${garage.sensor} linked to Garage Controller: ${garage.controller}`);
    }

    // check for mistyped deviceId's in config file
    for (const [device, info] of Object.entries(this.config.devices)) {
      if (!deviceList.some(x => x.deviceId === device)) {
        this.log.warn(`Device "${device}" does not exist in YoLink device list (${JSON.stringify(info, null, 2)}). ` +
          'Check config file for deviceID typo.');
      }
    }

    // Add an interval timer to check if device has been added or removed
    if (this.config.checkNewDeviceInterval > 0) {
      this.log.info(`Setting interval timer to check for new devices every ${this.config.checkNewDeviceInterval} seconds`);
      setInterval(async () => {
        this.liteLog(`Check new devices timer fired, next check in ${this.config.checkNewDeviceInterval} seconds`);
        await this.checkNewDevice();
      }, this.config.checkNewDeviceInterval * 1000);
    }
  }

  /*********************************************************************
   * addDevice
   */
  checkAddDevice(device: YoLinkDevice) {
    this.verboseLog(JSON.stringify(device, null, 2));
    // Track all devices by ID
    this.knownDevices.push(device.deviceId);
    // Get the config file settings for this device (if set)
    device.config = this.config.devices[device.deviceId] ?? {};
    device.name = device.config.name ?? device.name;
    // If device is assigned to a garage door then hide it as we will
    // handle those as special case.
    const garage = this.config.garageDoors?.some(x => (x.sensor === device.deviceId || x.controller === device.deviceId));
    // Skip over devices that are marked to as hide true, or the device type is listed in the excludeTypes or
    // includeTypes array based on whether allDevices is set to true or false...
    const skip = this.makeBoolean(device.config.hide,
      !((this.config.allDevices && this.config.excludeTypes.some(x => (x === device.type))) !==
        (this.config.allDevices || this.config.includeTypes.some(x => (x === device.type)))));
    // Generate a unique id for the accessory
    const uuid = this.api.hap.uuid.generate(device.deviceId);
    // See if an accessory with the same uuid has already been registered and restored from
    // the cached devices we stored in the `configureAccessory` method above.
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    // Now add the device...
    if (skip || garage) {
      if (existingAccessory) {
        this.log.warn(`Remove accessory from cache as ${(garage) ? 'device assigned to garage door' : 'config \'hide=true\''}` +
          `for: ${existingAccessory.displayName} (${device.deviceId})`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
      } else {
        if (garage) {
          this.log.info(`Device ${device.name} (${device.deviceId}) assigned to a garage door`);
        } else {
          this.log.info(`Not registering device ${device.name} (${device.deviceId}) as config 'hide=true'`);
        }
      }
    } else {
      this.addDevice(device, uuid, existingAccessory);
    }
  }

  /*********************************************************************
   * addDevice
   */
  addDevice(device: YoLinkDevice, uuid: string, existingAccessory: PlatformAccessory | undefined,
    device2: YoLinkDevice | undefined = undefined): PlatformAccessory {
    if (existingAccessory) {
      // update existing accessory
      this.verboseLog(`Restoring accessory from cache: ${existingAccessory.displayName} (${device.deviceId})`);
      existingAccessory.context.device = device;
      existingAccessory.context.device2 = device2;
      this.api.updatePlatformAccessories([existingAccessory]);
      this.deviceAccessories.push(new YoLinkPlatformAccessory(this, existingAccessory));
      return (existingAccessory);
    } else {
      // create a new accessory
      this.log.info(`Adding new accessory: ${device.name} (${device.deviceId})`);
      const accessory = new this.api.platformAccessory(device.name, uuid);
      accessory.context.device = device;
      accessory.context.device2 = device2;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.deviceAccessories.push(new YoLinkPlatformAccessory(this, accessory));
      return (accessory);
    }
  }

  /*********************************************************************
   * deleteRemovedDevices
   */
  removeDeletedDevices(deviceList: YoLinkDevice[]) {
    // Remove accessories from cache if they are no longer in list of
    // devices retrieved from YoLink.
    for (let i = this.accessories.length - 1; i >= 0; i--) {
      const accessory = this.accessories[i];
      const device: YoLinkDevice = accessory.context.device;
      if (!deviceList.some(x => x.deviceId === device.deviceId)) {
        this.log.warn(`Removing accessory from cache: ${accessory.displayName} (${device.deviceId}), device does not exist`);
        const indexKnownDevices = this.knownDevices.indexOf(device.deviceId);
        if (indexKnownDevices >= 0) {
          this.knownDevices.splice(indexKnownDevices, 1);
        }
        this.accessories.splice(i, 1);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  /*********************************************************************
   * checkNewDevices
   */
  async checkNewDevice(deviceId: string | undefined = undefined): Promise<boolean> {
    // serialize adding new devices
    const releaseSemaphore = await this.addDeviceSemaphore.acquire();
    try {
      if (deviceId && this.knownDevices.includes(deviceId)) {
        // If deviceId already a known device then return
        return false;
      }
      const deviceList: YoLinkDevice[] = await this.yolinkAPI.getDeviceList(this);
      this.verboseLog(`Known Device List: \n${this.knownDevices}`);
      this.removeDeletedDevices(deviceList);

      // loop over the discovered devices and register each one if it has not already been registered
      for (const device of deviceList) {
        if (!this.knownDevices.includes(device.deviceId)) {
          if (deviceId === undefined || deviceId === device.deviceId) {
            this.checkAddDevice(device);
          }
        }
      }
      return (true);
    } catch (e) {
      const msg = (e instanceof Error) ? e.stack : e;
      this.log.error(`Fatal error checkNewDevices:\n${msg}`);
      return (false);
    } finally {
      releaseSemaphore();
    }
  }

  /*********************************************************************
   * registerMqtt
   */
  async registerMqtt() {
    // Now connect to YoLink MQTT server and subscribe to messages
    this.yolinkAPI.mqtt(this, async (message: string) => {
      // This function is called for every message received over MQTT
      const data = JSON.parse(message);
      // Find the device in the deviceAccessories list
      const deviceAccessory = this.deviceAccessories.find(x => x.deviceId === data.deviceId || x.deviceId2 === data.deviceId);
      // pass the message on to the appropriate device accessory if it exists.
      if (deviceAccessory) {
        deviceAccessory.mqttMessage(data);
      } else {
        this.verboseLog(`Known Device List: \n${this.knownDevices}`);
        if (await this.checkNewDevice(data.deviceId)) {
          // New device added
          this.log.warn(`New device detected: MQTT received ${data.event} message for (${data.deviceId})`);
        } else {
          // If a device is hidden (not loaded into homebridge) then we may receive
          // messages for it... which is perfectly okay, but worth logging (only if not lite-logging)
          this.liteLog(`MQTT received ${data.event} message for hidden device (${data.deviceId})`);
        }

      }
    });
  }

}
