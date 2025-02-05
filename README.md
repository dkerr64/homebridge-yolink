# Homebridge YoLink Plugin

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm](https://badgen.net/npm/v/homebridge-yolink/latest?icon=npm&label)](https://www.npmjs.com/package/homebridge-yolink)
[![npm](https://badgen.net/npm/dt/homebridge-yolink?label=downloads)](https://www.npmjs.com/package/homebridge-yolink)

*Unofficial* plugin for YoLink. I wrote this plugin to integrate the YoLink devices that I own. This is implemented by building on the Homebridge platform plugin template and the [YoLink API.](http://doc.yosmart.com)

This plugin is new and not fully tested for all devices. Pull requests and/or other offers of development assistance gratefully received.

>[!IMPORTANT]
>This plugin is not intended to provide safety or security services. For critical applications use YoLink's own services and in particular consider their device-to-device capability. For example, do not rely on Homebridge or HomeKit to turn off a main water supply in a leak detection -- use YoLink device-to-device.

>[!NOTE]
>YoLink have implemented rate limits on their cloud servers that impact any application that uses their published User Access Credentials (UAC) API, including this plugin.  See discussion in *network resiliency* section below.

## Features

Currently supports the following devices:

* Carbon Monoxide Alarm
* Dimmer (as light bulb)
* Door Sensor
* Finger Controller
* FlexFob Remote
* Garage Door Controller
* Hub and Speaker Hub
* IR Remote / Blaster
* Leak Sensor
* Lock & LockV2
* Manipulator (as a valve)
* Motion Sensor
* Outlet (multiple)
* Outlet (single)
* PowerFailureAlarm
* Siren (as a switch)
* Smoke & CO Alarm
* Switch
* Temperature and Humidity Sensor
* Vibration Sensor (as a motion sensor)
* Water Meter Controller (as a valve)

The plugin registers as a MQTT client and subscribes to reports published by YoLink for real time alerts and status updates.

## Installation

**Option 1: Install via Homebridge Config UI X:**

Search for "yolink" in [homebridge-config-ui-x](https://github.com/oznu/homebridge-config-ui-x) and install `homebridge-yolink`.

**Option 2: Manually Install:**

```text
sudo npm install -g homebridge-yolink
```

YoLink status is retrieved over the internet. While the plugin maintains a status cache, **use of Homebridge [child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges)** is strongly encouraged. As noted below in the *network resiliency* section, this plugin will make multiple attempts to fulfill a request if necessary, which can take time.

## Configuration

### Homebridge Config UI X

[Homebridge Config UI X](https://github.com/oznu/homebridge-config-ui-x) is the easiest way to configure this plugin.

### API URLs

The default YoLink cloud server URLs are:
* **tokenURL**: "https://api.yosmart.com/open/yolink/token"
* **apiURL**: "https://api.yosmart.com/open/yolink/v2/api"

These work for devices shipped in the USA wih model names ending in `-UC`. In other countries you may receive devices with model names ending in `-EC` and you must change the URLs to:
* **tokenURL**: "https://api-eu.yosmart.com/open/yolink/token"
* **apiURL**: "https://api-eu.yosmart.com/open/yolink/v2/api"

If you see an error message in the log similar to the following then you are likely using the wrong server URLs
```log
[YS7805-UC (abcdef1234567890) Motion] Device offline or other error
```

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
            "checkNewDeviceInterval": 0,
            "enableExperimental": false,
            "doublePress": 800,
            "powerFailureSensorAs": "Outlet",
            "deviceTemperatures": false,
            "useWaterFlowing": false,
            "devices": [
                {
                    "deviceId": "0123456789abcdef",
                    "config": {
                        "hide": true,
                        "name": "YoLink Hub",
                        "refreshAfter": 14500,
                        "doublePress": 800,
                        "nOutlets": 5,
                        "temperature": false,
                        "useWaterFlowing": false,
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
  * **tokenURL** *(required)*: YoLink's authentication server URL, see *API URLs* section below.
  * **apiURL** *(required)*: YoLink's API server URL, see *API URLs* section below.
  * **mqttPort** *(optional)*: MQTT port at the YoLink API server, defaults to 8003.
  * **userAccessId** *(required)*: Obtain from the YoLink app on your mobile device... Settings->Account->Advanced Settings->User Access Credentials. If none exist use the (+) button to request credentials be generated for you. Copy down the UAID (user access ID) and Secret Key.
  * **secretKey** *(required)*: Secret key obtained as described above.
  * **refreshAfter** *(optional)*: The plugin maintains a cache of device status so that it can response very quickly to state requests from HomeKit without having to send a request to the YoLink servers. This is specified in number of seconds and defaults to 14500 (just over 4 hours) which means that if the plugin cache is not updated during this period then retrieve status from the YoLink server. If set to zero than the plugin will always request status from YoLink servers for every HomeKit request (not recommended).
  * **verboseLog** *(optional)*: Provides most detailed log information without having to enable Homebridge debug mode.
  * **liteLog** *(optional)*: HomeKit makes frequent requests for device status, this suppresses logging of every request (unless *verboseLog* is true). Requests that require message be sent to YoLink servers are still logged. Defaults to true.
  * **allDevices** *(optional)*: If set to false then only devices listed in the Devices section of the config file are loaded, and then only if the hide property is false. Defaults to true so all devices reported by YoLink are loaded (if device's *hide* property is false).
  * **excludeTypes** *(optional)*: Array of YoLink device types that will be excluded even if *allDevices* is set to true. The currently supported list of device types is *Hub, SpeakerHub, VibrationSensor, MotionSensor, LeakSensor, Manipulator, THSensor, DoorSensor, Siren, Switch, Outlet, SmartRemoter, MultiOutlet, GarageDoor, Finger, Lock, LockV2* and *PowerFailureAlarm*. Defaults to exclude Hub and Speaker Hub. Note that capitalization is important and values must be entered exactly as listed here.
  * **includeTypes** *(optional)*: Array of YoLink device types that will be included even if *allDevices* is set to false. Same list of device types as above with no default.
  * **checkNewDeviceInterval** *(optional)*: Interval (in seconds) to check for new YoLink devices added *or removed* from YoLink.  Defaults to zero (feature disabled). This feature will allow new devices to be detected and added to Homebridge/HomeKit without restarting the plugin. Also will detect when a device is deleted and remove it from Homebridge/HomeKit. Note that if a device requires config file changes then the plugin must be restarted to pick up config file changes. As this polls the YoLink server, a value less than 60 seconds is not recommended.
  * **enableExperimental** *(optional)*: If set to true, enables support for devices still considered experimental, see Device Notes below.
  * **doublePress** *(optional)*: Duration in milliseconds to trigger a double-press event on two button presses on a stateless device. Defaults to 800ms and a value of zero disables double-press feature. See notes below for YoLink FlexFob remote.
  * **powerFailureSensorAs** *(optional)*: How to represent the YoLink power failure alarm sensor in HomeKit, can be either *Outlet* or *Contact*, defaults to Outlet.
  * **deviceTemperatures** *(optional)*: If set to true then create a temperature service for those devices that report temperature in addition to their main function. See Device Notes below.
  * **useWaterFlowing** *(optional)*: If set to true then the plugin will use the *waterFlowing* status from YoLink *WaterMeterController* valves to report the *InUse* status to HomeKit. See Device Notes below.
  * **devices** *(optional)*: Optional array of device settings, see below.
  * **garageDoors** *(optional)*: Optional array of sensor/controller pairs, see below.

* **Devices** is an array of objects that allow settings or overrides on a device-by-device basis. This array is optional but if provided contains the following fields:
  * **deviceId** *(required)*: ID to identify specific device. You can find this from the Homebridge log or in the Homebridge Config UI X by clicking on an accessory settings and copying the Serial Number field.
  * **config** *(optional)*: Object with settings specific for this device:
    * **hide** *(optional)*: Hide this device from Homebridge/HomeKit. You might want to do this to suppress the "device not supported" warning message in the log. Defaults to false. See Device Notes below for Thermometer / Hydrometer, Carbon Monoxide and Smoke Alarm for settings specific to that device.
    * **name** *(optional)*: Override the name provided by YoLink for the device, this is what is shown in the Homebridge UI accessories page.
    * **refreshAfter** *(optional)*: Device specific override of global *refreshAfter*, see above. Defaults to global setting.
    * **doublePress** *(optional)*: Device specific override of global *doublePress*, see above. Defaults to global setting.
    * **nOutlets** *(optional)*: For power strip or multi-outlet devices, number of controllable outlets. See device notes below.
    * **temperature** *(optional)*: If set to true then create a temperature service in addition to the main function. See Device Notes below.
    * **useWaterFlowing** *(optional)*: Device specific override of global *useWaterFlowing*, see above.  Defaults to global setting.
    * **enableExperimental** *(optional)*: Device specific override of global *enableExperimental*, see above. Defaults to global setting.

* **garageDoors** are an array of objects that allow you to pair two devices, either a *GarageDoor* or *Finger* controller with a *DoorSensor* that together represent a single garage door. The garage door inherits properties of the individual devices. The garage door *name* is taken from the controller device. See device notes below.
  * **controller** *(required)*: string representing the *deviceID* of the controlling device (activates door open or close). Must be a *GarageDoor* or *Finger* type device.
  * **sensor** *(required)*: string representing the *deviceID* of the sensor device (reports if door open or closed). Must be a *DoorSensor* type device.
  * **timeout** *(optional)*: time in seconds after which the door status is reset to 'open' or 'closed' after activating the controller if no report has been received from the door sensor. Defaults to 45 seconds.

## Multiple home support

YoLink allows you to setup multiple homes. This plugin supports this by using multiple [child bridges](https://github.com/homebridge/homebridge/wiki/Child-Bridges) and unique access credentials for each home. Start at the YoLink app, go into your profile, select advanced, select user access credentials, and click the + icon to add new credentials... select the home you want new credentials for.

Make sure that the plugin is set to use child bridge. If not, do that first, restart, and continue...

In HomeBridge, go to the YoLink plugin, select JSON config from the dot-dot-dot menu.  Again there is a + icon to add an additional config. Copy/paste the existing config into this new one.  You **must** make the following changes...

- Change the `name` to make it different from first home.
- Replace `userAccessId` and `secretKey` values with the credentials for second home.
- In the `_bridge` section change `username` to be unique (I just changed one of the hex bytes, modeled on the example).
- If the bridge section also has a `port` setting, change it to be unique too (I did not, so one is randomly assigned).
- Optionally, edit the list of `excludeTypes` and `includeTypes` if applicable.

Save that and restart the child bridges.

Once restarted, back at the plugin dot-dot-dot menu select Child Bridge Config.  The drop-down next to Platform should have two entries, one for each home.  Select the new one and a QR code should appear to allow pairing with HomeKit.  I stopped at this point as I just assumed that part would work.

If there is no QR code, follow instructions at above link to manually add accessory to HomeKit.

## MQTT

The plugin registers with YoLink servers as a MQTT client and subscribes to published messages to receive alerts (e.g. motion sensor detects movement) which are forwarded to Homebridge/HomeKit. The plugin receives updates from YoLink devices at different times depending on the device. An alert event generates a message immediately but regular updates are received when there is no alert. Devices like the leak detector report at least every 4 hours, but temperature and humidity sensor sends updates based on environmental change rate, or at least every hour. This is documented in YoLink user guides for each device.

If you are comfortable relying entirely on YoLink notifications you can set the *refreshAfter* property to something larger than 14400 seconds (4 hours) which will cause the plugin to always report the cached state of a device, updating the cache whenever YoLink sends a report. If you want the plugin to query for status more frequently then an internal timer runs based on *refreshAfter* seconds. If this is set to less than 60 seconds then timers will not run, but data will be refreshed on HomeKit requests more than 60 seconds from the previous request.

## Device Notes

Observed behavior of various devices, and specific configuration settings are noted below for supported devices. Note that YoLink does not always query a device for its status in real-time. Requesting status usually returns the last known status either from a earlier alert, or from the last normal status report from a device.

Many YoLink devices are battery powered and report battery health. This plugin creates a battery service for each which shows in Homebridge as its own tile but in Apple Home is merged within the accessory settings. YoLink reports battery level of 0..4 which converts to 0, 25, 50, 75 and 100% in HomeKit.

**Experimental** devices are work-in-progress and may not function as expected. They are included to allow further testing and must be enabled by adding the setting *"enableExperimental": true* to the plugin configuration. Feedback and bug reports welcomed.

### Carbon Monoxide Alarm

See *Smoke & CO Alarm* section below

### Dimmer

YoLink smart dimmer is implemented as a HomeKit light bulb.

### Door Sensor

The YoLink door sensor is implemented as a HomeKit contact sensor which can then be used to trigger an action on contact open or contact closed.

### Finger / Garage Door Controller

The YoLink devices for controlling garage doors are supported as a Homebridge/HomeKit switch. These are momentarily activated devices (activate and then immediately deactivate) and are represented in Homebridge/HomeKit by the switch turning on and then turning off one second later.

You can pair these devices with a Door Sensor and the combination appears in Homebridge/HomeKit as a Garage Door accessory, the individual devices are removed from Homebridge/HomeKit. Door states of open and closed are supported but there is no support to report obstructions or a door stopped in neither a fully open or fully closed position.

When you open or close a garage door its status is set to 'opening' or 'closing' until the sensor reports that it is complete. You can set a timeout after which the door state is reset to either 'open' or 'closed' depending on last reported state from the sensor. Defaults to 45 seconds but you can change this with the *timeout* setting to value between 10 and 120 seconds.

### FlexFob Remote

The YoLink FlexFob four-button smart remote is setup as a HomeKit stateless programmable switch. In Homebridge it is represented with multiple service tiles that all combine into the one accessory on Apple Home. Each button can be programmed to trigger up to three actions in HomeKit; a single press, a double press or a long press.

Double press is not supported directly by the YoLink FlexFob but is generated when two button presses are received within a set timeout. This can be set in the plugin configuration with the *doublePress* setting which should be a value in milliseconds. The default is 800ms. You can experiment to find the ideal setting for yourself by looking at the Homebridge logs as you press the button... the time between each press is logged. If set to zero then the plugin will never generate a double-press event but will send two single-press events instead.

Simultaneously pressing more than one button will generate a long press signal for each button pressed

Some latency has been observed between pressing a button and it being reported by YoLink. Additional latency is incurred by waiting for a double-press event. If you never use double-press then a small reduction in latency can be achieved by setting the *doublePress* setting to zero.

### Hub / Speaker Hub

The plugin recognizes these devices and registers *Accessory Information* service in Homebridge... however as hubs are not defined in HomeKit no tile is created for these. As these devices are not useful in Homebridge the *excludeTypes* field default value is set to exclude them.

### IR Remote / Blaster

The YoLink Infrared Remote is supported in Homebridge/Homekit as a series of switches and as a battery service. In Homebridge these are represented with multiple service tiles that all combine into the one accessory on Apple Home.  See section on *Network Resiliency* below for comments on YoLink server rate limits.

Sending an IR signal is stateless and so the switch does not remain in the on position, it automatically resets itself to off.

### Leak Sensor

Normal status reporting occurs every 4 hours. Alerts will be reported immediately. If you want to check on device status more frequently then set *refreshAfter* to desired interval.

YoLink leak sensors also report device temperature. If you set the *temperature* configuration setting to true then a Homebridge/HomeKit service is created to make this visible to the app. The name has "Temperature" appended to the end.

### Lock

The YoLink Smart Lock M1 can be locked and unlocked from Homebridge/HomeKit and status of the lock and lock/unlock events triggered by the YoLink app or manually are received by this plugin. The plugin also creates a Door Bell service which is triggered when a user presses the door bell button on the YoLink smart lock keypad. The plugin does not support advanced features like setting user or visitor pass codes.

### Manipulator / Water Valve Controller

YoLink water valve controllers report as a *Manipulator* device, the plugin registers this as a HomeKit generic valve. HomeKit has the concept of both open/close and in-use where in-use means that fluid is actually flowing through the device. Presumably this allows for a valve to be open, but no fluid to flow. YoLink only reports open/close and so the plugin uses this state for both valve position and in-use (fluid flowing). Normal status reporting occurs every 4 hours. If you want to check on device status more frequently then set *refreshAfter* to desired interval.

### Motion Sensor

Normal status reporting occurs every 4 hours. Alerts will be reported immediately. If you want to check on device status more frequently then set *refreshAfter* to desired interval.

Some YoLink Motion sensors also report device temperature. If you set the *temperature* configuration setting to true then a Homebridge/HomeKit service is created to make this visible to the app. The name has "Temperature" appended to the end.

### Outlet / Smart Plug (single)

YoLink single outlet smart devices are supported. Reporting of power consumption and setting schedules / timer is not supported.

I have observed *Can't connect to Device* errors from YoLink when trying to retrieve device status. When these occur the plugin attempts to connect again, up to 5 times, before giving up. Warnings are written to log.

### Outlet (multiple) / Power Strip

YoLink power strip is supported. Each individual outlet, including the bank of USB charging ports, is controllable. Where USB ports are provided they are the first "outlet" in the Homebridge/HomeKit accessory (identified as Outlet 0). The plugin attempts to discover the number of outlets but if that fails then you can change this with the *nOutlets* property.

### Power Failure Alarm

The YoLink power failure alarm can be represented in Homebridge/HomeKit as either an electrical outlet or a contact sensor. The outlet will show as powered on if power state is healthy, and off if failed. A contact sensor will be closed for healthy state or open for a failure. Any attempt to turn on or off the outlet device is ignored.

### Siren

A YoLink siren has been implemented as a switch which can be turned on or off in Homebridge/HomeKit.

### Smoke & CO Alarm

>[!IMPORTANT]
>This plugin is not intended to provide safety or security services.

YoLink smoke and carbon monoxide alarm are supported and the plugin assumes that both sensors are supported in the device.  If your device has only a smoke detector, or only a carbon monoxide detector, then you must hide the missing sensor in your config file. Set the *hide* configuration parameter to *co* or *smoke* to hide the unsupported sensor from HomeKit.

### Switch

A Switch device is implemented to support adding YoLink siren. This is untested, if you have a YoLink switch please report back.

### Thermometer / Humidity Sensor

Normal status reporting occurs based on changes in temperature or humidity over time, with a maximum reporting period of one hour. If you want to check on device status more frequently then set *refreshAfter* to desired interval. While you can request an Alert in the YoLink app (for example when humidity or temperature exceeds a threshold), HomeKit does not support alerts for this device type so those alerts cannot be passed on to HomeKit.

If you have a Thermometer / Humidity sensor but only want to track one value then you can hide one or the other from HomeKit. Set the *hide* configuration parameter to *thermo* or *hydro* to hide that from HomeKit. You may want to do this for example with a remote temperature probe monitoring water temperature where humidity value is not relevant.

### Vibration Sensor

HomeKit does not have a vibration sensor device type so this plugin registers these devices as a Motion Sensor. Normal status reporting occurs every 4 hours. Alerts will be reported immediately. If you want to check on device status more frequently then set *refreshAfter* to desired interval.

YoLink vibration sensors also report device temperature. If you set the *temperature* configuration setting to true then a Homebridge/HomeKit service is created to make this visible to the app. The name has "Temperature" appended to the end.

### Water Meter Controller

YoLink water meter and valve controllers report as a *WaterMeterController* device, the plugin registers this as a HomeKit generic valve. HomeKit has the concept of both open/close and in-use where in-use means that fluid is actually flowing through the device. This allows for a valve to be open, but no fluid to flow.

The *YS-5008-UC* valve does report whether water is flowing.  However these devices currently do not update this status in real time and this can confuse Apple Home which will repport "Waiting..." after you open the valve -- as it waits for the in-use characteristic to indicate water flowing. Therefore, by default, this plugin will report in-use based on whether the value is open or closed. You can set the config *useWaterFlowing* setting to change this to use the water flowing status from the device.

This plugin expects to receive status updates from YoLink devices when status changes. As this device is not currently doing this for *waterFlowing*, an alternative would be to change the *refreshAfter* config setting for this device only (do not change it globally) and the plugin will poll the device for status more regularly. The minimum time you can set this to is 60 seconds. However this is *not recommended* as it places additional load on the LoRa protocol and the affects on device battery life are unknown.

A Leak Sensor and, if supported, a Temperature Sensor service is added with this device. The name of each has "Leak" and "Temperature" appended to the end. *YS-5006-UC* is known not to report temperature.

### Unsupported Devices

If you have a device not supported by the plugin then useful information will be logged as warnings, including callback messages received for any alerts or status changes triggered by the device. Please capture these logs and report to the author by opening a [issue](https://github.com/dkerr64/homebridge-yolink/issues).

## Technical Notes

### Network Resiliency

Various strategies are employed in an attempt to handle an unstable network. If a failure occurs at any point while accessing the network then the plugin will attempt to reconnect.

YoLink have implemented rate limits on their cloud servers that impact any application that uses their published User Access Credentials (UAC) API, including this plugin.  The current rate limits are 100 requests within a 5 minute period and 6 requests to the same device within one minute. If you have certain YoLink devices you are likely to run into these limits and see *warning* messages in the Homebridge log.  Possible warning message include these:  

```log
[YoLink] YoLink Dimmer (abcdef1234567890) YoLink API error code: 000201 Can't connect to Device (Dimmer.getState)
[YoLink] YoLink Dimmer (abcdef1234567890) YoLink API error code: 020104 Device is busy, try again later. (Dimmer.setState)
[YoLink] YoLink Dimmer (abcdef1234567890) YoLink API error code: 010301 Access denied due to reaching limits,Please have a retry later. (MultiOutlet.getState)
```

* `000201` errors indicate that the LoRa radio channel is busy so the YoLink hub is unable to connect to the device.  The more devices you have the more likely this is to occur. The plugin will retry the request, which is normally successful after a few retries.
* `020104` errors occur when you send more than 6 requests to the same device within one minute. You are likely to run into this with Dimmer switches, IR remote/blaster, and multi-outlet power strips where you may need to send multiple requests.
* `010301` errors occur when the plugin sends more than 100 requests to YoLink cloud servers within 5 minutes.

YoLink devices cannot be controlled locally, all requests go through YoLink cloud servers, so there is no workaround to the rate limits.
For login and retrieving access tokens the plugin will retry indefinitely with 15 second initial delay, increasing by 15 seconds for each repeated attempt to a maximum of 60 seconds between retries. If the network goes down, then this should ensure that the connection to YoLink is reestablished within 60 seconds of network recovery.

For getting device information the plugin will retry a maximum of 30 times before giving up. The initial retry delay is 5 seconds, incrementing by 5 seconds each time with a maximum interval of 60 seconds. After all attempts it will fail with a message to log, but this will not terminate the plugin.

For setting device state (e.g. turning an outlet on or off) the plugin will retry a maximum of 5 times before giving up. The initial retry delay is 10 seconds, incrementing by 10 seconds each time with a maximum interval of 30 seconds. After all attempts it will fail with a message to log, but this will not terminate the plugin.  We use fewer retries for setting device states because attempting to retry will slow down Homebridge and/or potentially cause a backlog of *setState* requests that can take some time to clear because of YoLink cloud server rate limits.

The MQTT callback will attempt to reconnect, if necessary with login / access token retrieval that follow the above procedure.

### Logging

Many log messages carry two timestamps. The first is current time and is logged by Homebridge. The second is either the current time, or if available, the *reportAt* time from YoLink. Most YoLink devices are not accessed in real time when requesting status, the time reported here is the time that status was last reported by the device to YoLink. The frequency of status updates varies by device and activity. Below illustrates an example log for vibration sensor in a Mailbox where the last report was at 1:40pm but the time of logging was 2:22pm.

```log
[8/20/2022, 2:22:15 PM] [YoLink] At 8/20/2022, 1:40:02 PM: Device state for Mailbox (abcdef1234567890) is: Motion: normal, Battery: 4, DevTemp: 35
```

## License

(c) Copyright 2022-2024 David A. Kerr

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this program except in compliance with the License. You may obtain a copy of the License at [http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

### Trademarks

Apple and HomeKit are registered trademarks of Apple Inc.

YoLink and YoSmart are trademarks of YoSmart Inc.
