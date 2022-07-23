/***********************************************************************
 * YoLink API class
 *
 * Copyright (c) 2022 David Kerr
 *
 * Based on documentation at http://doc.yosmart.com
 *
 * Manages login with User Access Credentials (UAC), obtaining list
 * of devices from YoLink servers, getting and setting values, and
 * subscribing to alerts and messages with MQTT
 */

import { URL, URLSearchParams } from 'url';
import { YoLinkHomebridgePlatform } from './platform';
import fetch from 'node-fetch';
import Semaphore from 'semaphore-promise';
import mqtt from 'mqtt';

// YoLink Basic Downlink Data Packet (BDDP) represents data format for
// API requests sent TO YoLink.
// See http://doc.yosmart.com/docs/protocol/datapacket
/* eslint-disable @typescript-eslint/no-explicit-any */
type yolinkBDDP = {
  time: number;
  method: string;
  msgid?: string;
  targetDevice?: string;
  token?: string;
  [key: string]: any;
};

// YoLink Basic Uplink Data Packet (BUDP) represents data format for
// data received FROM YoLink in reply to API requests.
// See http://doc.yosmart.com/docs/protocol/datapacket
type yolinkBUDP = {
  time: number;
  method: string;
  msgid: string;
  code: string;
  desc: string;
  [key: string]: any;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

type yolinkAccessTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  state?: string;
  msg?: string;
};

export class YoLinkAPI {

  private yolinkTokens: yolinkAccessTokens = {
    access_token: '',
    refresh_token: '',
    expires_in: 0,
    token_type: '',
  };
  // yolinkTokens object members match JSON returned from YoLink API.
  // see... http://doc.yosmart.com/docs/overall/intro

  private yolinkHomeId: string;
  private yolinkLoggedIn: boolean;
  private accessSemaphore;

  private accessTokenRefreshAt = 0.90;    //test with 0.005
  private accesstokenHeartbeatAt = 0.95;  // test with 0.008
  // Access Token heartbeat and refresh are percentage of the expire_in time.
  // Heartbeat at must be larger than refresh at to ensure that when the interval
  // timer fires and calls getAccessToken, the refresh time has already expired
  // which will force requesting new access token from YoLink.
  // At time of writing, YoLink access tokens have a 7200 second (2 hour) expire
  // time.  We will refresh at 90% of this (108 minutes) on request and fire the
  // interval timer at 95% (114 minutes) to force refresh.
  private accessTokenExpireTime = 0;
  private accessTokenHeartbeat;

  private mqttTokenExpireTime = 0;
  private mqttHost: string;
  private mqttClient;

  constructor( private readonly platform: YoLinkHomebridgePlatform) {
    platform.verboseLog('YoLinkAPI.constructor');

    this.yolinkLoggedIn = false;
    this.yolinkHomeId = '';
    this.mqttHost = new URL(platform.config.apiURL).hostname;

    // We need to serialize requests for an accessToken.  Multiple threads can request
    // state updates from multiple devices at the same time.  If the accessToken has
    // expired then we need to request a new one, but we can't have multiple threads
    // all requesting a new one at the same time.  Hence need for a semaphore.
    // We do allow multiple access for get/set status requests, those are not serialized.
    this.accessSemaphore = new Semaphore();
  }

  /*********************************************************************
   * login
   *
   */
  async login(platform: YoLinkHomebridgePlatform) {
    platform.log.info('Login to YoLink API with credentials from config');
    this.yolinkLoggedIn = false;
    this.yolinkTokens.state = '';
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', platform.config.userAccessId);
    params.append('client_secret', platform.config.secretKey);
    platform.log.debug('SENDING: ' + params);
    const timestamp = Math.floor(new Date().getTime() / 1000);
    const response = await fetch(platform.config.tokenURL, { method: 'POST', body: params } );
    this.yolinkTokens = await response.json();
    platform.log.debug('RECEIVED: ' + JSON.stringify(this.yolinkTokens));

    if (this._apiError(platform, 'YoLink Login', response, this.yolinkTokens)) {
      return false;
    }

    this.accessTokenExpireTime = Math.floor(this.yolinkTokens.expires_in * this.accessTokenRefreshAt) + timestamp;
    this.yolinkLoggedIn = true;

    platform.log.info('Access Token expires in ' + this.yolinkTokens.expires_in + ' seconds. We will refresh on requests after '
                                                 + Math.floor(this.yolinkTokens.expires_in * this.accessTokenRefreshAt) + ' seconds');

    if (this.accessTokenHeartbeat) {
      // If interval timer already running, kill it so we can start a new one.
      clearInterval(this.accessTokenHeartbeat);
    }
    platform.log.info('Starting heartbeat to force access token refresh every '
      + (this.yolinkTokens.expires_in * this.accesstokenHeartbeatAt) + ' seconds');
    this.accessTokenHeartbeat = setInterval( () => {
      platform.liteLog('Refresh access token timer fired');
      this.getAccessToken(platform);
    }, this.yolinkTokens.expires_in * 1000 * this.accesstokenHeartbeatAt );

    await this.getHomeId(platform);
    return true;
  }

  /*********************************************************************
   * getAccessToken
   *
   */
  async getAccessToken(platform: YoLinkHomebridgePlatform) {
    platform.verboseLog('YoLinkAPI.getAccessToken');
    if (!this.yolinkLoggedIn) {
      platform.log.error('Not logged in to YoLink API');
      return null;
    }
    // need to serialize this
    const releaseSemaphore = await this.accessSemaphore.acquire();
    const timestamp = Math.floor(new Date().getTime() / 1000);
    if (this.accessTokenExpireTime < timestamp) {
      // We need to get a new access token, current one has or is about to expire
      platform.verboseLog('Current access token expired, or close to expiry, request new one');
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('client_id', platform.config.userAccessId);
      params.append('refresh_token', this.yolinkTokens.refresh_token);
      platform.log.debug('SENDING: ' + params);
      const response = await fetch(platform.config.tokenURL, { method: 'POST', body: params } );
      this.yolinkTokens.state = '';
      this.yolinkTokens = await response.json();
      platform.log.debug('RECEIVED: ' + JSON.stringify(this.yolinkTokens));
      // TEST with bad refresh token
      if (this._apiError(platform, 'YoLink Refresh Token', response, this.yolinkTokens)) {
        if (response.ok) {
          platform.log.warn('YoLink refresh token error: ' + this.yolinkTokens.msg);
          await this.login(platform);
        }
      }

      this.accessTokenExpireTime = Math.floor(this.yolinkTokens.expires_in * this.accessTokenRefreshAt) + timestamp;
    }
    await releaseSemaphore();
    return this.yolinkTokens.access_token;
  }

  /*********************************************************************
   * getDeviceList
   *
   */
  async getDeviceList(platform: YoLinkHomebridgePlatform) {
    platform.verboseLog('YoLinkAPI.getDeviceList');
    const accessToken = await this.getAccessToken(platform);
    if (!accessToken) {
      return null;
    }

    const timestamp = Math.floor(new Date().getTime() / 1000);
    const bddp: yolinkBDDP = {
      time: timestamp,
      method: 'Home.getDeviceList',
    };
    platform.log.debug('SENDING: ' + JSON.stringify(bddp));
    const response = await fetch(platform.config.apiURL,
      { method: 'POST', body: JSON.stringify(bddp),
        headers: { 'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
      });
    const budp: yolinkBUDP = await response.json();
    platform.log.debug('RECEIVED: ' + JSON.stringify(budp));

    if (this._apiError(platform, bddp.method, response, budp)) {
      return null;
    }

    return (budp.data) ? budp.data.devices : undefined;
  }

  /*********************************************************************
   * getHomeId
   *
   */
  async getHomeId(platform: YoLinkHomebridgePlatform) {
    platform.verboseLog('YoLinkAPI.getHomeId');
    if (!this.yolinkLoggedIn) {
      platform.log.error('Not logged in to YoLink API');
      return null;
    }

    if (this.yolinkHomeId) {
      return this.yolinkHomeId;
    }

    const accessToken = await this.getAccessToken(platform);
    if (!accessToken) {
      return null;
    }

    const timestamp = Math.floor(new Date().getTime() / 1000);
    const bddp: yolinkBDDP = {
      time: timestamp,
      method: 'Home.getGeneralInfo',
    };
    platform.log.debug('SENDING: ' + JSON.stringify(bddp));
    const response = await fetch(platform.config.apiURL,
      { method: 'POST', body: JSON.stringify(bddp),
        headers: { 'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
      });
    const budp: yolinkBUDP = await response.json();
    platform.log.debug('RECEIVED: ' + JSON.stringify(budp));

    if (this._apiError(platform, bddp.method, response, budp)) {
      return null;
    }

    this.yolinkHomeId = budp.data.id;
    return this.yolinkHomeId;
  }


  /*********************************************************************
   * getDeviceState
   *
   */
  async getDeviceState(platform: YoLinkHomebridgePlatform, device) {
    platform.log.info('YoLinkAPI.getDeviceState for \'' + device.name +'\' (' + device.deviceId + ')');

    const accessToken = await this.getAccessToken(platform);
    if (!accessToken) {
      return null;
    }

    const timestamp = Math.floor(new Date().getTime() / 1000);
    const bddp: yolinkBDDP = {
      time: timestamp,
      method: device.type + '.getState',
      targetDevice: device.deviceId,
      token: device.token,
    };
    platform.log.debug('SENDING: ' + JSON.stringify(bddp));
    const response = await fetch(platform.config.apiURL,
      { method: 'POST', body: JSON.stringify(bddp),
        headers: { 'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
      });
    const budp: yolinkBUDP = await response.json();
    platform.log.debug('RECEIVED: ' + JSON.stringify(budp));

    if (this._apiError(platform, bddp.method, response, budp)) {
      return null;
    }

    return budp.data;
  }

  /*********************************************************************
   * setDeviceState
   *
   */
  async setDeviceState(platform: YoLinkHomebridgePlatform, device, state) {
    platform.log.info('YoLinkAPI.setDeviceState for \'' + device.name +'\' (' + device.deviceId + ')');
    const accessToken = await this.getAccessToken(platform);
    if (!accessToken) {
      return null;
    }

    const timestamp = Math.floor(new Date().getTime() / 1000);
    const bddp: yolinkBDDP = {
      time: timestamp,
      method: device.type + '.setState',
      targetDevice: device.deviceId,
      token: device.token,
      params: state,
    };
    platform.log.debug('SENDING: ' + JSON.stringify(bddp));
    const response = await fetch(platform.config.apiURL,
      { method: 'POST', body: JSON.stringify(bddp),
        headers: { 'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
      });
    const budp: yolinkBUDP = await response.json();
    platform.log.debug('RECEIVED: ' + JSON.stringify(budp));

    if (this._apiError(platform, bddp.method, response, budp)) {
      return null;
    }

    return budp.data;
  }


  /*********************************************************************
   * _apiError
   *
   */
  _apiError(platform: YoLinkHomebridgePlatform, method, response, budp) {
    if (!response.ok) {
      platform.log.error('HTTP error: ' + method + ': ' + response.status);
      return true;
    }
    if (budp) {
      if (budp.state && budp.state === 'error') {
        platform.log.error('YoLink API error: ' + method + ': ' + budp.msg);
        return true;
      }
      if (budp.code && budp.code !== '000000') {
        platform.log.error('YoLink API error code: ' + method + ': ' + budp.code + ' ' + budp.desc);
        return true;
      }
    }
    return false;
  }

  /*********************************************************************
   * mqtt
   *
   * Open a MQTT session with YoLink API server to recieve update
   * messages from YoLink for each device.
   *
   * This has not been thoroughly tested.  How it behaves on roaming (IP
   * address changes) or temporary disconnects/reconnects has not been
   * full tested.  Info logging is enabled to capture as much information
   * as possible for events like this. Please report bugs.
   */
  async mqtt(platform: YoLinkHomebridgePlatform, msgCallback) {
    const url = 'mqtt://' + this.mqttHost + ':' + platform.config.mqttPort.toString();
    const accessToken = await this.getAccessToken(platform);

    const options = {
      clean: true,
      username: accessToken!,
      reconnectPeriod: 2000,
    };
    await this.getHomeId(platform);

    // Make a note of the access token expire time for the token used to start
    // the MQTT session. If we need to restart the MQTT session then we may need
    // to do so with a new access token.
    this.mqttTokenExpireTime = this.accessTokenExpireTime;

    platform.log.debug('MQTT options: ' + JSON.stringify(options));
    this.mqttClient = mqtt.connect(url, options);

    this.mqttClient.on('connect', () => {
      this.mqttClient.subscribe('yl-home/' + this.yolinkHomeId + '/+/report', (error) => {
        if (error) {
          platform.log.error('mqtt subscribe error: ' + error);
        } else {
          platform.log.info('mqtt subscribed: ' + 'yl-home/' + this.yolinkHomeId + '/+/report');
        }
      });
    });

    this.mqttClient.on('message', (topic, message) => {
      platform.log.debug('mqtt received: ' + topic + '\n  ' + message.toString());
      msgCallback(message.toString());
    });

    this.mqttClient.on('reconnect', () => {
      platform.log.info('mqtt reconnect, Connected: ' + this.mqttClient.connected);
      const timestamp = Math.floor(new Date().getTime() / 1000);
      if (timestamp < this.mqttTokenExpireTime) {
        return;
      }
      // The access token we used to setup mqtt connection has or is about to expire.
      // End this connection and establish a new one.
      this.mqttClient.end(true, undefined, () => {
        platform.log.info('mqtt client closed down, restart with new credentials');
        this.mqtt(platform, msgCallback);
      });

    });

    this.mqttClient.on('close', () => {
      platform.log.info('mqtt close, Connected: ' + this.mqttClient.connected);
    });

    this.mqttClient.on('disconnect', (packet) => {
      platform.log.info('mqtt disconnect' + packet);
    });

    this.mqttClient.on('offline', () => {
      platform.log.info('mqtt offline, Connected: ' + this.mqttClient.connected);
    });

    this.mqttClient.on('end', () => {
      platform.log.info('mqtt end, Connected: ' + this.mqttClient.connected);
    });

    this.mqttClient.on('error', (error) => {
      platform.log.error('mqtt connect error: \'' + error + '\' Connected: ' + this.mqttClient.connected);
      if (!this.mqttClient.connected) {
        platform.log.info('mqtt client not connected, attempt restart');
        this.mqtt(platform, msgCallback);
      }
    });

  }
}
