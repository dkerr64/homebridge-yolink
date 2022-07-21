/* eslint-disable brace-style */
/***********************************************************************
 * YoLink device list
 *
 * Copyright (c) 2022 David Kerr
 *
 */

import { initMotionSensor, mqttMotionSensor } from './motionDevice';
import { initLeakSensor, mqttLeakSensor } from './leakDevice';
import { initValveDevice, mqttValveDevice } from './valveDevice';

export const initDeviceService = {
  VibrationSensor(deviceClass) { initMotionSensor(deviceClass); },
  MotionSensor(deviceClass) { initMotionSensor(deviceClass); },
  LeakSensor(deviceClass) { initLeakSensor(deviceClass); },
  Manipulator(deviceClass) { initValveDevice(deviceClass); },
};

export const mqttHandler = {
  VibrationSensor(deviceClass, data) { mqttMotionSensor(deviceClass, data); },
  MotionSensor(deviceClass, data) { mqttMotionSensor(deviceClass, data); },
  LeakSensor(deviceClass, data) { mqttLeakSensor(deviceClass, data); },
  Manipulator(deviceClass, data) { mqttValveDevice(deviceClass, data); },
};