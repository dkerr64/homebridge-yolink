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

export const experimentalDevice = {
  VibrationSensor: false,
  MotionSensor: false,
  LeakSensor: false,
  Manipulator: false,
  THSensor: false,
  DoorSensor: true,
  Siren: true,
  Switch: true,
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
};