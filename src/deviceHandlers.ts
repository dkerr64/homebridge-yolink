/* eslint-disable brace-style */
/***********************************************************************
 * YoLink device list
 *
 * Copyright (c) 2022 David Kerr
 *
 */
import { YoLinkPlatformAccessory } from './platformAccessory';
import { initHubDevice, mqttHubDevice } from './hubDevice';
import { initMotionSensor, mqttMotionSensor } from './motionDevice';
import { initLeakSensor, mqttLeakSensor } from './leakDevice';
import { initValveDevice, mqttValveDevice } from './valveDevice';
import { initThermoHydroDevice, mqttThermoHydroDevice } from './thermoHydroDevice';
import { initContactSensor, mqttContactSensor } from './contactDevice';
import { initSwitchDevice, mqttSwitchDevice } from './switchDevice';
import { initOutletDevice, mqttOutletDevice } from './outletDevice';
import { initStatelessSwitch, mqttStatelessSwitch } from './statelessSwitch';

export const deviceFeatures = {
  Hub: { experimental: false, hasBattery: false },
  SpeakerHub: { experimental: false, hasBattery: false },
  VibrationSensor: { experimental: false, hasBattery: true },
  MotionSensor: { experimental: false, hasBattery: true },
  LeakSensor: { experimental: false, hasBattery: true },
  Manipulator: { experimental: false, hasBattery: true },
  THSensor: { experimental: false, hasBattery: true },
  DoorSensor: { experimental: false, hasBattery: true },
  Siren: { experimental: false, hasBattery: true },
  Switch: { experimental: false, hasBattery: false },
  Outlet: { experimental: false, hasBattery: false },
  SmartRemoter: { experimental: false, hasBattery: true },
  MultiOutlet: { experimental: true, hasBattery: false },
};

export const initDeviceService = {
  Hub(this: YoLinkPlatformAccessory) { initHubDevice.bind(this)(); },
  SpeakerHub(this: YoLinkPlatformAccessory) { initHubDevice.bind(this)(); },
  VibrationSensor(this: YoLinkPlatformAccessory) { initMotionSensor.bind(this)(); },
  MotionSensor(this: YoLinkPlatformAccessory) { initMotionSensor.bind(this)(); },
  LeakSensor(this: YoLinkPlatformAccessory) { initLeakSensor.bind(this)(); },
  Manipulator(this: YoLinkPlatformAccessory) { initValveDevice.bind(this)(); },
  THSensor(this: YoLinkPlatformAccessory) { initThermoHydroDevice.bind(this)(); },
  DoorSensor(this: YoLinkPlatformAccessory) { initContactSensor.bind(this)(); },
  Siren(this: YoLinkPlatformAccessory) { initSwitchDevice.bind(this)('alert', {'alarm':true}, {'alarm':false}); },
  Switch(this: YoLinkPlatformAccessory) { initSwitchDevice.bind(this)('open', 'open', 'close'); },
  Outlet(this: YoLinkPlatformAccessory) { initOutletDevice.bind(this)(1, 'open', 'open', 'close'); },
  SmartRemoter(this: YoLinkPlatformAccessory) { initStatelessSwitch.bind(this)(4); },
  MultiOutlet(this: YoLinkPlatformAccessory) { initOutletDevice.bind(this)(4, 'open', 'open', 'close'); },
};

export const mqttHandler = {
  Hub(this: YoLinkPlatformAccessory, data) { mqttHubDevice.bind(this)(data); },
  SpeakerHub(this: YoLinkPlatformAccessory, data) { mqttHubDevice.bind(this)(data); },
  VibrationSensor(this: YoLinkPlatformAccessory, data) { mqttMotionSensor.bind(this)(data); },
  MotionSensor(this: YoLinkPlatformAccessory, data) { mqttMotionSensor.bind(this)(data); },
  LeakSensor(this: YoLinkPlatformAccessory, data) { mqttLeakSensor.bind(this)(data); },
  Manipulator(this: YoLinkPlatformAccessory, data) { mqttValveDevice.bind(this)(data); },
  THSensor(this: YoLinkPlatformAccessory, data) { mqttThermoHydroDevice.bind(this)(data); },
  DoorSensor(this: YoLinkPlatformAccessory, data) { mqttContactSensor.bind(this)(data); },
  Siren(this: YoLinkPlatformAccessory, data) { mqttSwitchDevice.bind(this)(data); },
  Switch(this: YoLinkPlatformAccessory, data) { mqttSwitchDevice.bind(this)(data); },
  Outlet(this: YoLinkPlatformAccessory, data) { mqttOutletDevice.bind(this)(data); },
  SmartRemoter(this: YoLinkPlatformAccessory, data) { mqttStatelessSwitch.bind(this)(data); },
  MultiOutlet(this: YoLinkPlatformAccessory, data) { mqttOutletDevice.bind(this)(data); },
};