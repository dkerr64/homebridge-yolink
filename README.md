
<p align="center">

<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# Homebridge YoLink Plugin

*Unofficial* plugin for YoLink. I wrote this plugin to integrate the YoLink devices that I own. This is implemented by building on the Homebridge platform plugin template and the [YoLink API.](http://doc.yosmart.com)

**Warning** this plugin is new and not fully tested for all devices.

**Warning** this plugin is not intended to provide safety or security services. For critical applications use YoLink's own services and in particular consider their device-to-device capability. For example, do not rely on Homebridge or Homekit to turn off a main water supply in a leak detection -- use YoLink device-to-device.

Pull requests and/or other offers of development assistance gratefully received.

## Features

Currently supports the following devices:

* Hub and Speaker Hub
* Leak Sensor
* Motion Sensor
* Vibration Sensor (as a motion sensor)
* Manipulator (as a valve)
* Weatherproof Temperature and Humidity Sensor
* Door Sensor (as a contact sensor)
* Key fob remote (as stateless programmable switch)
* Siren (as a switch)
* Switch
* Outlet (single)
* Outlet (multiple)
* Garage Door Controller
* Finger Controller
* Lock
* PowerFailureAlarm (experimental)

The plugin registers as a MQTT client and subscribes to reports published by YoLink for real time alerts and status updates.

## Installation

**Option 1: Install via Homebridge Config UI X:**

Search for "yolink" in [homebridge-config-ui-x](https://github.com/oznu/homebridge-config-ui-x) and install `homebridge-yolink`.

**Option 2: Manually Install:**

```text
sudo npm install -g homebridge-yolink
```

YoLink status is retrieved over the internet. While the plugin maintains a status cache, **use of Homebridge [child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges)** is strongly encouraged.  As noted below in the *network resiliency* section, this plugin will make multiple attempts to fulfill a request if necessary, which can take time.

## Configuration

### Homebridge Config UI X

[Homebridge Config UI X](https://github.com/oznu/homebridge-config-ui-x) is the easiest way to configure this plugin.

### Configuration File

```json
"platforms": [
        {
            "name": "YoLink",
            "platform": "YoLink",
            "tokenURL": "https://api.yosmart.com/open/yolink/token",
            "apiURL": "https://api.yosmart.com/open/yolink/v2/api",
            "mqttPort": 8003,
            "userAccessId": "ua_0123456789abcdef",
            "secretKey": "sec_v1_0123456789abcdef==",
            "refreshAfter": 14500,
            "verboseLog": false,
            "liteLog": true,
            "allDevices": true,
            "excludeTypes": [
                "Hub",
                "SpeakerHub"
            ],
            "includeTypes": [
            ],
            "enableExperimental": false,
            "doublePress": 800,
            "powerFailureSensorAs": "Outlet",
            "deviceTemperatures": false,
            "devices": [
                {
                    "deviceId": "0123456789abcdef",
                    "config": {
                        "hide": true,
                        "name": "YoLink Hub",
                        "model": "YS1603-UC",
                        "refreshAfter": 14500,
                        "doublePress": 800,
                        "nOutlets": 5,
                        "temperature": false,
                        "enableExperimental": false
                    }
                }
            ],
            "garageDoors": [
                {
                    "controller": "0123456789abcdef",
                    "sensor": "abcdef0123456789",
                    "timeout": 45
                }
            ] 
        }
    ]
```

* **Platform Properties**
  * **name** *(required)*: Platform name, set to 'YoLink'.
  * **platform** *(required)*: Platform identifier, set to 'YoLink'.
  * **tokenURL** *(required)*: YoLink's authentication server URL.
  * **apiURL** *(required)*: YoLink's API server URL.
  * **mqttPort** *(optional)*: MQTT port at the YoLink API server, defaults to 8003.
  * **userAccessId** *(required)*: Obtain from the YoLink app on your mobile device... Settings->Account->Advanced Settings->User Access Credentials. If none exist use the (+) button to request credentials be generated for you. Copy down the UAID (user access ID) and Secret Key.
  * **secretKey** *(required)*: Secret key obtained as described above.
  * **refreshAfter** *(optional)*: The plugin maintains a cache of device status so that it can response very quickly to state requests from HomeKit without having to send a request to the YoLink servers. This is specified in number of seconds and defaults to 14500 (just over 4 hours) which means that if the plugin cache is not updated during this period then retrieve status from the YoLink server. If set to zero than the plugin will always request status from YoLink servers for every HomeKit request (not recommended).
  * **verboseLog** *(optional)*: Sometimes it is helpful to log more detail than *info* but somewhat less than *debug*. This is that half-way. Defaults to false.
  * **liteLog** *(optional)*: HomeKit makes frequent requests for device status, this suppresses logging of every request (unless verboseLog is true). Requests that require message be sent to YoLink servers are still logged. Defaults to true.
  * **allDevices** *(optional)*: If set to false then only devices listed in the Devices section of the config file are loaded, and then only if the hide property is false. Defaults to true so all devices reported by YoLink are loaded (if hide property is false).
  * **excludeTypes** *(optional)*: Array of YoLink device types that will be excluded even if *allDevices* is set to true. The currently supported list of device types is *Hub, SpeakerHub, VibrationSensor, MotionSensor, LeakSensor, Manipulator, THSensor, DoorSensor, Siren, Switch, Outlet, SmartRemoter, MultiOutlet, GarageDoor, Finger, Lock* and *PowerFailureAlarm*. Defaults to exclude Hub and Speaker Hub.  Note that capitalization is important and values must be entered exactly as listed here.
  * **includeTypes** *(optional)*: Array of YoLink device types that will be included even if *allDevices* is set to false.  Same list of device types as above with no default.
  * **enableExperimental** *(optional)*: If set to true, enables support for devices still considered experimental, see Device Notes below.
  * **doublePress** *(optional)*: Duration in milliseconds to trigger a double-press event on two button presses on a stateless device. Defaults to 800ms and a value of zero disables double-press feature. See notes below for YoLink FlexFob remote.
  * **powerFailureSensorAs** *(optional)*: How to represent the YoLink power failure alarm sensor in HomeKit, can be either *Outlet* or *Contact*, defaults to Outlet.
  * **deviceTemperatures** *(optional)*: If set to true then create a temperature service for those devices that report temperature in addition to their main function. See device notes below.
  * **devices** *(optional)*: Optional array of device settings, see below.
  * **garageDoors** *(optional)*: Optional array of sensor/controller pairs, see below.

* **Devices** are an array of objects that allow settings or overrides on a device-by-device basis. This array is optional but if provided contains the following fields:
  * **deviceId** *(required)*: ID to identify specific device. u can find this from the Homebridge log or in the Homebridge Config UI X by clicking on an accessory settings and copying the Serial Number field.
  * **config** *(optional)*: Object with settings specific for this device:
    * **hide** *(optional)*: See device notes below. Hide this device from Homebridge / HomeKit. You might want to do this to suppress the "device not supported" warning message in the log. As there is no accessory type in HomeKit for a hub, you might want to set this to true for the YoLink hub. Defaults to false
    * **name** *(optional)*: Override the name provided by YoLink for the device, this is what is shown in the Homebridge UI accessories page.
    * **model** *(optional)*: YoLink does not provide device model number when requesting device information. If you want to keep a record of that and show it in the Homebridge accessories setting page then you can set it here, for example the original YoLink leak sensor has a model number of "YS7903-UC". This is a purely cosmetic setting with no functional purpose.
    * **refreshAfter** *(optional)*: Device specific override of global *refreshAfter*, see above. Defaults to global setting.
    * **doublePress** *(optional)*: Device specific override of global *doublePress*, see above. Defaults to global setting.
    * **nOutlets** *(optional)*: For power strip or multi-outlet devices, number of controllable outlets.  See device notes below.
    * **temperature** *(optional)*: If set to true then create a temperature service in addition to the main function. See device notes below.
    * **enableExperimental** *(optional)*: Device specific override of global *enableExperimental*, see above. Defaults to global setting.

* **garageDoors** are an array of objects that allow you to pair two devices, either a *GarageDoor* or *Finger* controller with a *DoorSensor* that together represent a single garage door. The garage door inherits properties of the individual devices. The garage door *name* is taken from the controller device. See device notes below.
  * **controller** *(required)*: string representing the *deviceID* of the controlling device (activates door open or close). Must be a *GarageDoor* or *Finger* type device.
  * **sensor** *(required)*: string representing the *deviceID* of the sensor device (reports if door open or closed). Must be a *DoorSensor* type device.
  * **timeout** *(optional)*: time in seconds after which the door status is reset to 'open' or 'closed' after activating the controller if no report has been received from the door sensor. Defaults to 45 seconds.

## MQTT

The plugin registers with YoLink servers as a MQTT client and subscribes to published messages to receive alerts (e.g. motion sensor detects movement) which are forwarded to homebridge. At the time of writing the resiliency of the MQTT client has not been fully tested, so how well it responds to roaming (change of IP address) or disconnects is not fully known. Logging is enabled to trace events, please report if the MQTT client stops working.

MQTT client is receives updates from YoLink devices at different times depending on the device. An alert event generates a message immediately but regular updates are received when there is no alert. Devices like the leak detector report every 4 hours, but temperature and humidity sensor sends updates based on environmental change rate, or at least every hour. This is documented in YoLink user guide.

If you are comfortable relying entirely on YoLink notifications you can set the *refreshAfter* property to something larger than 14400 seconds (4 hours) which will cause the plugin to always report the cached state of a device, updating the cache whenever YoLink sends a report or when an internal timer runs based on *refreshAfter*. If this is set to less than 60 seconds then timers will not run, but data will be refreshed on HomeKit requests more than 60 seconds from the previous request.

## Device Notes

Observed behavior of various devices, and specific configuration settings are noted below for supported devices. Note the YoLink does not query a device on request for status in real-time. Requesting status usually returns the last known status either from a earlier alert, or from the last normal status report from a device.

Many YoLink devices are battery powered and report battery health. This plugin creates a battery service for each which shows in Homebridge as its own tile but in Apple Home is merged within the accessory settings. YoLink reports battery level of 0..4 which converts to 0, 25, 50, 75 and 100% in HomeKit.

**Experimental** devices are work-in-progress and may not function as expected. They are included to allow further testing and must be enabled by adding the setting *"enableExperimental": true* to the plugin configuration. Feedback and bug reports welcomed.

### Hub / Speaker Hub

The plugin recognizes these devices and register *Accessory Information* service in Homebridge... however as hubs are not defined in HomeKit no tile is created for these.

### Leak Sensor

Normal status reporting occurs every 4 hours. Alerts will be reported immediately. If you want to check on device status more frequently then set *refreshAfter* to desired interval.

YoLink leak sensors also report device temperature. If you set the *temperature* configuration setting to true then a Homebridge/HomeKit service is created to make this visible to the app. The name has "Temperature" appended to the end.

### Vibration Sensor

HomeKit does not have a vibration sensor device type so this plugin registers these devices as a Motion Sensor. Normal status reporting occurs every 4 hours. Alerts will be reported immediately. If you want to check on device status more frequently then set *refreshAfter* to desired interval.

YoLink vibration sensors also report device temperature. If you set the *temperature* configuration setting to true then a Homebridge/HomeKit service is created to make this visible to the app. The name has "Temperature" appended to the end.

### Motion Sensor

Normal status reporting occurs every 4 hours. Alerts will be reported immediately. If you want to check on device status more frequently then set *refreshAfter* to desired interval.

Some YoLink Motion sensors also report device temperature. If you set the *temperature* configuration setting to true then a Homebridge/HomeKit service is created to make this visible to the app. The name has "Temperature" appended to the end.

### Thermometer / Humidity Sensor

Normal status reporting occurs based on changes in temperature or humidity over time, with a maximum reporting period of one hour. If you want to check on device status more frequently then set *refreshAfter* to desired interval. While you can request an Alert in the YoLink app (for example when humidity or temperature exceeds a threshold), HomeKit does not support alerts for this device type so those alerts cannot be passed on to HomeKit.

If you have a Thermometer / Humidity sensor but only want to track one value then you can hide one or the other from HomeKit. Set the *hide* configuration parameter to "thermo" or "hydro" to hide that from HomeKit. You may want to do this for example with a remote temperature probe monitoring swimming pool water temperature where humidity value is not relevant.

### Water Valve Controller

YoLink water valve controllers report as a "manipulator" device, the plugin registers this as a HomeKit generic valve. HomeKit has the concept of both open/close and in use where in use means that fluid is actually flowing through the device. Presumably this allows for a valve to be open, but no fluid to flow. YoLink only reports open/close and so the plugin uses this state for both valve position and in use (fluid flowing). Normal status reporting occurs every 4 hours. If you want to check on device status more frequently then set *refreshAfter* to desired interval.

I have observed *Can't connect to Device* errors from YoLink when trying to retrieve device status. When these occur the plugin attempts to connect again, up to 5 times, before giving up. Warnings are written to log.

### Door Sensor

The YoLink door sensor is implemented as a HomeKit contact sensor which can then be used to trigger an action on contact open or contact closed.

### FlexFob Remote

The YoLink FlexFob four-button smart remote is setup as a HomeKit stateless programmable switch. In Homebridge it is represented with multiple service tiles that all combine into the one accessory on Apple Home. Each button can be programmed to trigger up to three actions in HomeKit; a single press, a double press or a long press.

Double press is not supported directly by the YoLink FlexFob but is generated when two button presses are received within a set timeout. This can be set in the plugin configuration with the *doublePress* setting which should be a value in milliseconds. The default is 800ms. You can experiment to find the ideal setting for yourself by looking at the Homebridge logs as you press the button... the time between each press is logged. If set to zero then the plugin will never generate a double-press event but will send two single-press events instead.

Simultaneously pressing more than one button will generate a long press signal for each button pressed

Some latency has been observed between pressing a button and it being reported by YoLink. Additional latency is incurred by waiting for a double-press event. If you never use double-press then a small reduction in latency can be achieved by setting the *doublePress* setting to zero.

### Siren

A YoLink siren has been implemented as a switch which can be turned on or off in Homebridge/HomeKit.

### Switch

A Switch device is implemented to support adding YoLink siren. This is untested, if you have a YoLink switch please report back.

### Outlet / Smart Plug

YoLink single outlet device is supported. Multi-outlet devices are not currently supported, if you have one please see below and report

I have observed *Can't connect to Device* errors from YoLink when trying to retrieve device status. When these occur the plugin attempts to connect again, up to 5 times, before giving up. Warnings are written to log.

### Multiple Outlet / Power Strip

YoLink power strip is supported.  Each individual outlet, including the bank of USB charging ports, is controllable.  Where USB ports are provided they are the first "outlet" in the Homebridge/HomeKit accessory (identified as Outlet 0).  The default number of outlets is five (one USB bank, four main outlets) but you can change this with the *nOutlets* property.

### Garage Door / Finger Controller

The YoLink devices for controlling garage doors are supported as a Homebridge/HomeKit switch. These are momentarily activated devices (activate and then immediately deactivate) and are represented in Homebridge/HomeKit by the switch turning on and then turning off one second later.

You can pair these devices with a Door Sensor and the combination appears in Homebridge/HomeKit as a Garage Door accessory.  The individual devices are removed from Homebridge/HomeKit. Door states of open and closed are supported but there is no support to report obstructions or a door stopped in either a fully open or fully closed position.

When you open or close a garage door its status is set to 'opening' or 'closing' until the sensor reports that it is complete.  You can set a timeout after which the door state is reset to either 'open' or 'closed' depending on last reported state from the sensor. Defaults to 45 seconds but you can change this with the *timeout* setting to value between 10 and 120 seconds.

### Lock

The YoLink Smart Lock M1 can be locked and unlocked from Homebridge / HomeKit and status of the lock and lock/unlock events triggered by the YoLink app or manually are received by this plugin. The plugin also creates a Door Bell service which is triggered when a user presses the door bell button on the YoLink smart lock keypad.

### Power Failure Alarm

The YoLink power failure alarm can be represented in Homebridge / HomeKit as either an electrical outlet or a contact sensor.  The outlet will show as powered on if power state is healthy, and off if failed.  A contact sensor will be closed for healthy state or open for a failure.  Any attempt to turn on or off the outlet device is ignored.

### Unsupported Devices

If you have a device not supported by the plugin then useful information will be logged as warnings, including callback messages received for any actions triggered by the device. Please capture these logs and report to the author by opening a [issue](https://github.com/dkerr64/homebridge-yolink/issues).

## Technical Notes

### Network Resiliency

Various strategies are employed in an attempt to handle an unstable network. If a failure occurs at any point while accessing the network then the plugin will attempt to reconnect.

For login and retrieving access tokens the plugin will retry indefinitely with 5 second initial delay, increasing by 5 seconds for each repeated attempt to a maximum of 60 seconds between retries. If the network goes down, then this should ensure that the connection to YoLink is reestablished within 60 seconds of network recovery.

For getting or setting device information the plugin will retry a maximum of 10 times before giving up. The initial retry delay is 2 seconds, incrementing by 2 seconds each time with a maximum interval of 10 seconds.  After all attempts it will fail with a message to log, but this will not terminate the plugin.

The MQTT callback will attempt to reconnect, if necessary with login / access token retrieval that follow the above procedure.

Warnings are logged when network retry events occur.

### Logging

Many log messages carry two timestamps. The first is current time and is logged by Homebridge. The second is either the current time, or if available, the *reportAt* time from YoLink. Most YoLink devices are not accessed in real time when requesting status, the time reported here is the time that status was last reported by the device to YoLink. The frequency of status updates varies by device and activity.  Below illustrates an example log for vibration sensor in a Mailbox where the last report was at 1:40pm but the time of logging was 2:22pm.

```log
[8/20/2022, 2:22:15 PM] [YoLink] At 8/20/2022, 1:40:02 PM: Device state for Mailbox (abcdef1234567890) is: Motion: normal, Battery: 4, DevTemp: 35
```

## License

(c) Copyright 2022 David A. Kerr

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this program except in compliance with the License. You may obtain a copy of the License at [http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

### Trademarks

Apple and HomeKit are registered trademarks of Apple Inc.

YoLink and YoSmart are trademarks of YoSmart Inc.
