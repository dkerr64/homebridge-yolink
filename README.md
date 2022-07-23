
<p align="center">

<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# Homebridge YoLink Plugin

*Unofficial* plugin for YoLink.  I wrote this plugin to integrate the YoLink devices that I own, so it is currently quite limited.  This is implemented by building on the Homebridge platform plugin template and the [YoLink API.](http://doc.yosmart.com)

**Warning** this plugin is new and not fully tested.

Pull requests and/or other offers of development assistance gratefully received.

## Features

Currently supports the following devices:

* Leak Sensor
* Motion Sensor
* Vibration Sensor (as a motion sensor)
* Manipulator (as a valve)
* Weatherproof Temperature and Humidity Sensor

The plugin registers as a MQTT client and subscribes to reports published by YoLink for real time alerts and status updates.

## Installation

**Option 1: Install via Homebridge Config UI X:**

Search for "yolink" in [homebridge-config-ui-x](https://github.com/oznu/homebridge-config-ui-x) and install `homebridge-yolink`.

**Option 2: Manually Install:**

```text
sudo npm install -g homebridge-yolink
```

YoLink status is retrieved over the internet.  While the plugin maintains a status cache, you may consider use of Homebridge [child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges).

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
            "devices": [
                {
                    "deviceId": "0123456789abcdef",
                    "config": {
                        "hide": true,
                        "name": "YoLink Hub",
                        "model": "YS1603-UC",
                        "refreshAfter": 14500
                    }
                }
            ]
        }
    ]
```

* **Platform Properties**
  * **name** *(required)*: Plaform name, set to 'YoLink'.
  * **platform** *(required)*: Platform identifier, set to 'YoLink'.
  * **tokenURL** *(required)*: YoLink's authentication server URL.
  * **apiURL** *(required)*: YoLink's API server URL.
  * **mqttPort** *(optional)*: MQTT port at the YoLink API server, defaults to 8003.
  * **userAccessId** *(required)*: Obtain from the YoLink app on your mobile device...  
  Settings->Account->Advanced Settings->User Access Credentials.  If none exist use the (+) button to request credentials be generated for you.  Copy down the UAID (user access ID) and Secret Key.
  * **secretKey** *(required)*: Secret key obtained as descrived above.
  * **refreshAfter** *(optional)*: The plugin maintains a cache of device status so that it can response very quickly to state requests from HomeKit without having to send a request to the YoLink servers.  This is specified in number of seconds and defaults to 14500 (just over 4 hours) which means that if the plugin cache is not updated during this period then retrieve status from the YoLink server.  If set to zero than the plugin will always request status from YoLink servers for every HomeKit request (not recommended).
  * **verboseLog** *(optional)*: Sometimes it is helpful to log more detail than *info* but somewhat less than *debug*. This is that half-way.  Defaults to false.
  * **liteLog** *(optional)*: HomeKit makes frequent requests for device status, this suppresses logging of every request (unless verboseLog is true).  Requests that require message be sent to YoLink servers are still logged.  Defaults to true.
  * **allDevices** *(optional)*: If set to false then only devices listed in the Devices section of the config file are loaded, and then only if the hide property is false. Defaults to true so all devices reported by YoLink are loaded (if hide property is false).
  * **devices** *(optional)*: Optional array of device settings, see below.

* **Device Properties** are an array of objects that allow settings or overrides on a device-by-device basis.  This array is optional but if provided contains the following fields:
  * **deviceId** *(required)*: ID to identify specific device.  You can find this from the Homebridge log or in the Homebridge Config UI X by clicking on an accessory settings and copying the Serial Number field.
  * **config** *(optional)*: Object with settings specific for this device:
    * **hide** *(optional)*: Hide this device from Homebridge / HomeKit.  You might want to do this to suppress the "device not supported" warning message in the log.  As there is no accessory type in HomeKit for a hub, you might want to set this to true for the YoLink hub.  Defaults to false
    * **name** *(optional)*: Override the name provided by YoLink for the device, this is what is shown in the Homebridge UI accessories page.
    * **model** *(optional)*: YoLink does not provide device model number when requesting device information.  If you want to keep a record of that and show it in the Homebridge accessories setting page then you can set it here, for example the original YoLink leak sensor has a model number of "YS7903-UC".  This is a purely cosmetic setting with no functional purpose.
    * **refreshAfter** *(optional)*: Device specific override of global *refreshAfter*, see above.  Defaults to global setting.

## MQTT

The plugin registers with YoLink servers as a MQTT client and subscribes to published messages to receive alerts (e.g. motion sensor detects movement) which are forwarded to homebridge. At the time of writing the resiliency of the MQTT client has not been fully tested, so how well it responds to roaming (change of IP address) or disconnects is not fully known.  Logging is enabled to trace events, please report if the MQTT client stops working.

MQTT client is receives updates from YoLink devices at different times depending on the device.  An alert event generates a message immediately but regular updates are received when there is no alert. Devices like the leak detector report every 4 hours, but tempearture and humidity sensor sends updates based on environmental change rate, or at least every hour.  This is documented in YoLink user guide.

If you are comfortable relying entirely on YoLink notifications you can set the *refreshAfter* property to something larger than 14400 seconds (4 hours) which will cause the plugin to always report the cached state of a device, updating the cache whenever YoLink sends a report or when an internal timer runs based on *refreshAfter*.  If this is set to less than 60 seconds then timers will not run, but data will be refreshed on HomeKit requests more than 60 seconds from the previous request.

## License

(c) Copyright 2022 David A. Kerr

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this program except in compliance with the License. You may obtain a copy of the License at [http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
