/* eslint-disable brace-style */
/***********************************************************************
 * YoLink device list
 *
 * Copyright (c) 2022-2024 David Kerr
 *
 */
import { initUnknownDevice, mqttUnknownDevice }         from './unknownDevice';
import { YoLinkPlatformAccessory }                      from './platformAccessory';
import { initHubDevice, mqttHubDevice }                 from './hubDevice';
import { initMotionSensor, mqttMotionSensor }           from './motionDevice';
import { initLeakSensor, mqttLeakSensor }               from './leakDevice';
import { initValveDevice, mqttValveDevice }             from './valveDevice';
import { initThermoHydroDevice, mqttThermoHydroDevice } from './thermoHydroDevice';
import { initContactSensor, mqttContactSensor }         from './contactDevice';
import { initSwitchDevice, mqttSwitchDevice }           from './switchDevice';
import { initOutletDevice, mqttOutletDevice }           from './outletDevice';
import { initStatelessSwitch, mqttStatelessSwitch }     from './statelessSwitch';
import { initGarageDoor, mqttGarageDoor }               from './garageDoor';
import { initLockDevice, mqttLockDevice }               from './lockDevice';
import { initPowerSensor, mqttPowerSensor }             from './powerDevice';
import { initLightbulb, mqttLightbulb }                 from './lightbulbDevice';
import { initInfraredRemoter, mqttInfraredRemoter }     from './infraredRemoter';
import { initCoSmokeDetector, mqttCoSmokeDetector }     from './coSmokeDetector';

export const deviceFeatures = {
  Unknown:            { hasBattery: false, experimental: false },
  Hub:                { hasBattery: false },
  SpeakerHub:         { hasBattery: false },
  VibrationSensor:    { hasBattery: true },
  MotionSensor:       { hasBattery: true },
  LeakSensor:         { hasBattery: true },
  Manipulator:        { hasBattery: true },
  THSensor:           { hasBattery: true },
  DoorSensor:         { hasBattery: true },
  Siren:              { hasBattery: true },
  Switch:             { hasBattery: false },
  Outlet:             { hasBattery: false },
  SmartRemoter:       { hasBattery: true },
  MultiOutlet:        { hasBattery: false },
  GarageDoor:         { hasBattery: false },
  Finger:             { hasBattery: true },
  GarageDoorCombo:    { hasBattery: false },
  Lock:               { hasBattery: true },
  LockV2:             { hasBattery: true },
  PowerFailureAlarm:  { hasBattery: true },
  Dimmer:             { hasBattery: false },
  InfraredRemoter:    { hasBattery: true },
  COSmokeSensor:      { hasBattery: true },
  WaterMeterController: { hasBattery: true },
};

export const initDeviceService = {
  Unknown(this: YoLinkPlatformAccessory)            { initUnknownDevice.bind(this)(); },
  Hub(this: YoLinkPlatformAccessory)                { initHubDevice.bind(this)(); },
  SpeakerHub(this: YoLinkPlatformAccessory)         { initHubDevice.bind(this)(); },
  VibrationSensor(this: YoLinkPlatformAccessory)    { initMotionSensor.bind(this)(); },
  MotionSensor(this: YoLinkPlatformAccessory)       { initMotionSensor.bind(this)(); },
  LeakSensor(this: YoLinkPlatformAccessory)         { initLeakSensor.bind(this)(); },
  Manipulator(this: YoLinkPlatformAccessory)        { initValveDevice.bind(this)(); },
  THSensor(this: YoLinkPlatformAccessory)           { initThermoHydroDevice.bind(this)(); },
  DoorSensor(this: YoLinkPlatformAccessory)         { initContactSensor.bind(this)(); },
  Siren(this: YoLinkPlatformAccessory)              { initSwitchDevice.bind(this)('alert', { 'alarm':true }, { 'alarm':false }); },
  Switch(this: YoLinkPlatformAccessory)             { initSwitchDevice.bind(this)('open', 'open', 'close'); },
  Outlet(this: YoLinkPlatformAccessory)             { initOutletDevice.bind(this)('open', 'open', 'close'); },
  SmartRemoter(this: YoLinkPlatformAccessory)       { initStatelessSwitch.bind(this, 4)(); },
  MultiOutlet(this: YoLinkPlatformAccessory)        { initOutletDevice.bind(this)('open', 'open', 'close'); },
  GarageDoor(this: YoLinkPlatformAccessory)         { initSwitchDevice.bind(this)('toggle', '', ''); },
  Finger(this: YoLinkPlatformAccessory)             { initSwitchDevice.bind(this)('toggle', '', ''); },
  GarageDoorCombo(this: YoLinkPlatformAccessory)    { initGarageDoor.bind(this)(); },
  Lock(this: YoLinkPlatformAccessory)               { initLockDevice.bind(this)(); },
  LockV2(this: YoLinkPlatformAccessory)             { initLockDevice.bind(this)(); },
  PowerFailureAlarm(this: YoLinkPlatformAccessory)  { initPowerSensor.bind(this)(); },
  Dimmer(this: YoLinkPlatformAccessory)             { initLightbulb.bind(this)('open', 'open', 'close'); },
  InfraredRemoter(this: YoLinkPlatformAccessory)    { initInfraredRemoter.bind(this)(); },
  COSmokeSensor(this: YoLinkPlatformAccessory)      { initCoSmokeDetector.bind(this)(); },
  WaterMeterController(this: YoLinkPlatformAccessory) { initValveDevice.bind(this)(); },
};

export const mqttHandler = {
  Unknown(this: YoLinkPlatformAccessory, data)            { mqttUnknownDevice.bind(this)(data); },
  Hub(this: YoLinkPlatformAccessory, data)                { mqttHubDevice.bind(this)(data); },
  SpeakerHub(this: YoLinkPlatformAccessory, data)         { mqttHubDevice.bind(this)(data); },
  VibrationSensor(this: YoLinkPlatformAccessory, data)    { mqttMotionSensor.bind(this)(data); },
  MotionSensor(this: YoLinkPlatformAccessory, data)       { mqttMotionSensor.bind(this)(data); },
  LeakSensor(this: YoLinkPlatformAccessory, data)         { mqttLeakSensor.bind(this)(data); },
  Manipulator(this: YoLinkPlatformAccessory, data)        { mqttValveDevice.bind(this)(data); },
  THSensor(this: YoLinkPlatformAccessory, data)           { mqttThermoHydroDevice.bind(this)(data); },
  DoorSensor(this: YoLinkPlatformAccessory, data)         { mqttContactSensor.bind(this)(data); },
  Siren(this: YoLinkPlatformAccessory, data)              { mqttSwitchDevice.bind(this)(data); },
  Switch(this: YoLinkPlatformAccessory, data)             { mqttSwitchDevice.bind(this)(data); },
  Outlet(this: YoLinkPlatformAccessory, data)             { mqttOutletDevice.bind(this)(data); },
  SmartRemoter(this: YoLinkPlatformAccessory, data)       { mqttStatelessSwitch.bind(this)(data); },
  MultiOutlet(this: YoLinkPlatformAccessory, data)        { mqttOutletDevice.bind(this)(data); },
  GarageDoor(this: YoLinkPlatformAccessory, data)         { mqttSwitchDevice.bind(this)(data); },
  Finger(this: YoLinkPlatformAccessory, data)             { mqttSwitchDevice.bind(this)(data); },
  GarageDoorCombo(this: YoLinkPlatformAccessory, data)    { mqttGarageDoor.bind(this)(data); },
  Lock(this: YoLinkPlatformAccessory, data)               { mqttLockDevice.bind(this)(data); },
  LockV2(this: YoLinkPlatformAccessory, data)             { mqttLockDevice.bind(this)(data); },
  PowerFailureAlarm(this: YoLinkPlatformAccessory, data)  { mqttPowerSensor.bind(this)(data); },
  Dimmer(this: YoLinkPlatformAccessory, data)             { mqttLightbulb.bind(this)(data); },
  InfraredRemoter(this: YoLinkPlatformAccessory, data)    { mqttInfraredRemoter.bind(this)(data); },
  COSmokeSensor(this: YoLinkPlatformAccessory, data)      { mqttCoSmokeDetector.bind(this)(data); },
  WaterMeterController(this: YoLinkPlatformAccessory, data) { mqttValveDevice.bind(this)(data); },
};
