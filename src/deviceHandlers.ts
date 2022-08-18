/* eslint-disable brace-style */
/***********************************************************************
 * YoLink device list
 *
 * Copyright (c) 2022 David Kerr
 *
 */
import { YoLinkPlatformAccessory } from './platformAccessory';
import { initMotionSensor, mqttMotionSensor } from './motionDevice';
import { initLeakSensor, mqttLeakSensor } from './leakDevice';
import { initValveDevice, mqttValveDevice } from './valveDevice';
import { initThermoHydroDevice, mqttThermoHydroDevice } from './thermoHydroDevice';
import { initContactSensor, mqttContactSensor } from './contactDevice';
import { initSwitchDevice, mqttSwitchDevice } from './switchDevice';
import { initOutletDevice, mqttOutletDevice } from './outletDevice';
import { initStatelessSwitch, mqttStatelessSwitch } from './statelessSwitch';

export const deviceFeatures = {
  VibrationSensor: { experimental: false, hasBattery: true },
  MotionSensor: { experimental: false, hasBattery: true },
  LeakSensor: { experimental: false, hasBattery: true },
  Manipulator: { experimental: false, hasBattery: true },
  THSensor: { experimental: false, hasBattery: true },
  DoorSensor: { experimental: false, hasBattery: true },
  Siren: { experimental: true, hasBattery: true },
  Switch: { experimental: true, hasBattery: false },
  Outlet: { experimental: true, hasBattery: false },
  SmartRemoter: { experimental: false, hasBattery: true },
};

export const initDeviceService = {
  VibrationSensor(this: YoLinkPlatformAccessory) { initMotionSensor.bind(this)(); },
  MotionSensor(this: YoLinkPlatformAccessory) { initMotionSensor.bind(this)(); },
  LeakSensor(this: YoLinkPlatformAccessory) { initLeakSensor.bind(this)(); },
  Manipulator(this: YoLinkPlatformAccessory) { initValveDevice.bind(this)(); },
  THSensor(this: YoLinkPlatformAccessory) { initThermoHydroDevice.bind(this)(); },
  DoorSensor(this: YoLinkPlatformAccessory) { initContactSensor.bind(this)(); },
  Siren(this: YoLinkPlatformAccessory) { initSwitchDevice.bind(this)('alert', {'alarm':true}, {'alarm':false}); },
  Switch(this: YoLinkPlatformAccessory) { initSwitchDevice.bind(this)('closed', 'close', 'open'); },
  Outlet(this: YoLinkPlatformAccessory) { initOutletDevice.bind(this)('closed', 'close', 'open'); },
  SmartRemoter(this: YoLinkPlatformAccessory) { initStatelessSwitch.bind(this)(4); },
};

export const mqttHandler = {
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
};