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

export const initDeviceService = {
  VibrationSensor(this: YoLinkPlatformAccessory) { initMotionSensor.bind(this)(); },
  MotionSensor(this: YoLinkPlatformAccessory) { initMotionSensor.bind(this)(); },
  LeakSensor(this: YoLinkPlatformAccessory) { initLeakSensor.bind(this)(); },
  Manipulator(this: YoLinkPlatformAccessory) { initValveDevice.bind(this)(); },
  THSensor(this: YoLinkPlatformAccessory) { initThermoHydroDevice.bind(this)(); },
};

export const mqttHandler = {
  VibrationSensor(this: YoLinkPlatformAccessory, data) { mqttMotionSensor.bind(this)(data); },
  MotionSensor(this: YoLinkPlatformAccessory, data) { mqttMotionSensor.bind(this)(data); },
  LeakSensor(this: YoLinkPlatformAccessory, data) { mqttLeakSensor.bind(this)(data); },
  Manipulator(this: YoLinkPlatformAccessory, data) { mqttValveDevice.bind(this)(data); },
  THSensor(this: YoLinkPlatformAccessory, data) { mqttThermoHydroDevice.bind(this)(data); },
};