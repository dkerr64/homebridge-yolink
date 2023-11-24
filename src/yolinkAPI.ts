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
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
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
  data: any;
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

/***********************************************************************
 * Support functions for HTTP calls to YoLink API
 * retryFn
 *
 */
function retryFn(platform: YoLinkHomebridgePlatform, fn, retriesLeft = 5, interval = 15000, intervalInc = 15000, intervalMax = 60000) {
  return new Promise((resolve, reject) => {
    fn()
      .then(resolve)
      .catch((e) => {
        if ((retriesLeft === 1) || (String(e.cause).startsWith('FATAL:'))) {
          platform.log.warn(`Retry for ${fn.name} aborted, too many errors`);
          reject(e);
          return;
        }
        const msg = (e instanceof Error) ? e.message : e;
        platform.liteLog(`Retry ${fn.name} due to error, try again in ${Math.floor(interval / 1000)} second(s): ${msg}`);
        setTimeout(() => {
          retryFn(platform, fn, (retriesLeft) ? retriesLeft - 1 : 0,
            Math.min(interval + intervalInc, intervalMax), intervalInc, intervalMax)
            .then(resolve, reject);
        }, interval);
      });
  });
}

function checkHttpStatus(response) {
  if (response.status >= 200 && response.status < 300) {
    return true;
  }
  throw (new Error(response.statusText));
}

function checkBudpStatus(platform: YoLinkHomebridgePlatform, budp, device: YoLinkDevice | undefined = undefined) {
  const devName = device ? `${device.name} (${device.deviceId}) ` : '';
  if (!budp) {
    throw (new Error(`${devName}YoLink API error: BUDP undefined or null`));
  }
  if (budp.state && budp.state === 'error') {
    throw (new Error(`${devName}YoLink API error: ${budp.msg}`));
  }
  if (budp.code && budp.code !== '000000') {
    if ((budp.code === '000201') || (budp.code === '010301') || (budp.code === '020104')) {
      // Common errors from YoLink API that I want user to see.
      platform.log.warn(`${devName}YoLink API error code: ${budp.code} ${budp.desc} (${budp.method})`);
    } else {
      // Unexpected error?
      platform.log.error(`${devName}YoLink API error code: ${budp.code} ${budp.desc} (${budp.method})`);
    }
    throw (new Error(`${devName}YoLink API error code: ${budp.code} ${budp.desc} (${budp.method})`));
  }
  return true;
}

/***********************************************************************
 * YoLinkAPI class and constructor
 *
 */
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
  private accessSemaphore: Semaphore;

  private accessTokenRefreshAt = 0.90;    // test with 0.005, production 0.90
  private accessTokenHeartbeatAt = 0.95;  // test with 0.008, production 0.95
  // Access Token heartbeat and refresh are percentage of the expire_in time.
  // HeartbeatAt must be larger than refresh at to ensure that when the interval
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
  private mqttTimer: null | ReturnType<typeof setTimeout> = null;

  constructor(private readonly platform: YoLinkHomebridgePlatform) {
    platform.verboseLog('YoLinkAPI.constructor');
    Error.stackTraceLimit = 100;

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
    // Infinitely retry. On failure retry after 15 seconds.  Add 15 seconds for
    // each failure with maximum of 60 seconds between each retry.
    await retryFn(platform, this.tryLogin.bind(this, platform), 0, 15000, 15000, 60000);
  }

  async tryLogin(platform: YoLinkHomebridgePlatform) {
    this.yolinkLoggedIn = false;
    if (!platform.config.userAccessId || !platform.config.secretKey) {
      throw (new Error('FATAL: Missing userAccessId or secretKey credentials in config.'));
    }
    platform.log.info('Login to YoLink API with credentials from config');

    // Login to retrieve YoLink tokens
    const timestamp = new Date().getTime();
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', platform.config.userAccessId);
    params.append('client_secret', platform.config.secretKey);
    platform.verboseLog('SENDING:\n' + params);
    let response = await fetch(platform.config.tokenURL, { method: 'POST', body: params });
    checkHttpStatus(response);
    this.yolinkTokens = await response.json();
    platform.verboseLog('RECEIVED:\n' + JSON.stringify(this.yolinkTokens));
    checkBudpStatus(platform, this.yolinkTokens);
    this.accessTokenExpireTime = Math.floor(this.yolinkTokens.expires_in * this.accessTokenRefreshAt) + Math.floor(timestamp / 1000);
    this.yolinkLoggedIn = true;

    // Now retrieve YoLink Home ID
    const bddp: yolinkBDDP = {
      time: new Date().getTime(),
      method: 'Home.getGeneralInfo',
    };
    platform.verboseLog('SENDING:\n' + JSON.stringify(bddp));
    response = await fetch(platform.config.apiURL,
      {
        method: 'POST', body: JSON.stringify(bddp),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.yolinkTokens.access_token,
        },
      });
    checkHttpStatus(response);
    const budp: yolinkBUDP = await response.json();
    platform.verboseLog('RECEIVED:\n' + JSON.stringify(budp));
    checkBudpStatus(platform, budp);
    this.yolinkHomeId = budp.data.id;

    if (this.accessTokenHeartbeat) {
      // If interval timer already running, kill it so we can start a new one.
      clearInterval(this.accessTokenHeartbeat);
    }
    platform.log.info('Starting interval timer to refresh accessToken every '
      + Math.floor(this.yolinkTokens.expires_in * this.accessTokenRefreshAt) + ' seconds');
    this.accessTokenHeartbeat = setInterval(() => {
      platform.verboseLog('Refresh access token timer fired');
      this.getAccessToken(platform);
    }, this.yolinkTokens.expires_in * 1000 * this.accessTokenHeartbeatAt);
  }

  /*********************************************************************
   * getAccessToken
   *
   */
  async getAccessToken(platform: YoLinkHomebridgePlatform): Promise<string> {
    // Infinitely retry. On failure retry after 15 seconds.  Add 15 seconds for
    // each failure with maximum of 60 seconds between each retry.
    return await retryFn(platform, this.tryGetAccessToken.bind(this, platform), 0, 15000, 15000, 60000) as string;
  }

  async tryGetAccessToken(platform: YoLinkHomebridgePlatform): Promise<string> {
    // need to serialize this
    const releaseSemaphore = await this.accessSemaphore.acquire();
    try {
      platform.verboseLog('YoLinkAPI.getAccessToken');

      if (!this.yolinkLoggedIn) {
        platform.log.error('Not logged in to YoLink API, try to login');
        await this.login(platform);
      }

      const timestamp = new Date().getTime();
      if (this.accessTokenExpireTime < Math.floor(timestamp / 1000)) {
        // We need to get a new access token, current one has or is about to expire
        platform.verboseLog('Current access token expired, or close to expiry, requesting new one');
        const params = new URLSearchParams();
        params.append('grant_type', 'refresh_token');
        params.append('client_id', platform.config.userAccessId);
        // TEST with bad refresh token
        params.append('refresh_token', this.yolinkTokens.refresh_token);
        platform.verboseLog('SENDING:\n' + params);
        const response = await fetch(platform.config.tokenURL, { method: 'POST', body: params });
        checkHttpStatus(response);
        this.yolinkTokens = await response.json();
        platform.verboseLog('RECEIVED:\n' + JSON.stringify(this.yolinkTokens));
        checkBudpStatus(platform, this.yolinkTokens);
        this.accessTokenExpireTime = Math.floor(this.yolinkTokens.expires_in * this.accessTokenRefreshAt) + Math.floor(timestamp / 1000);
      }
    } catch (e) {
      // If error occurred that we probably need to login again.  Propagate the error up.
      //const msg = (e instanceof Error) ? e.message : e;
      //platform.log.error(`Error retrieving access token: ${msg}`);
      this.yolinkLoggedIn = false;
      throw (e);
    } finally {
      releaseSemaphore();
    }
    return this.yolinkTokens.access_token;
  }

  /*********************************************************************
   * getDeviceList
   *
   */
  async getDeviceList(platform: YoLinkHomebridgePlatform): Promise<YoLinkDevice[]> {
    // Infinitely retry. On failure retry after 15 seconds.  Add 15 seconds for
    // each failure with maximum of 60 seconds between each retry.
    return await retryFn(platform, this.tryGetDeviceList.bind(this, platform), 0, 15000, 15000, 60000) as YoLinkDevice[];
  }

  async tryGetDeviceList(platform: YoLinkHomebridgePlatform): Promise<YoLinkDevice[]> {
    platform.verboseLog('YoLinkAPI.getDeviceList');
    const accessToken = await this.getAccessToken(platform);

    const bddp: yolinkBDDP = {
      time: new Date().getTime(),
      method: 'Home.getDeviceList',
    };
    platform.verboseLog('SENDING:\n' + JSON.stringify(bddp));
    const response = await fetch(platform.config.apiURL,
      {
        method: 'POST', body: JSON.stringify(bddp),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
      });
    checkHttpStatus(response);
    const budp: yolinkBUDP = await response.json();
    platform.verboseLog('RECEIVED:\n' + JSON.stringify(budp));
    checkBudpStatus(platform, budp);
    platform.liteLog(`YoLinkAPI.getDeviceList found ${budp.data.devices.length} devices`);
    return budp.data.devices;
  }

  /*********************************************************************
   * getDeviceState
   *
   */
  async getDeviceState(platform: YoLinkHomebridgePlatform, device): Promise<yolinkBUDP> {
    // Retry 30 times. On failure retry after 30 seconds.  Add 30 seconds for
    // each failure with maximum of 60 seconds between each retry.
    return await retryFn(platform, this.tryGetDeviceState.bind(this, platform, device), 30, 30000, 30000, 60000) as yolinkBUDP;
  }

  async tryGetDeviceState(platform: YoLinkHomebridgePlatform, device: YoLinkDevice) {
    platform.liteLog(`YoLinkAPI.getDeviceState for ${device.name} (${device.deviceId})`);
    let budp: yolinkBUDP = undefined!;
    const accessToken = await this.getAccessToken(platform);
    const bddp: yolinkBDDP = {
      time: new Date().getTime(),
      method: device.type + '.getState',
      targetDevice: device.deviceId,
      token: device.token,
    };
    platform.verboseLog('SENDING:\n' + JSON.stringify(bddp));
    const response = await fetch(platform.config.apiURL,
      {
        method: 'POST', body: JSON.stringify(bddp),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
      });
    checkHttpStatus(response);
    budp = await response.json();
    platform.verboseLog('RECEIVED:\n' + JSON.stringify(budp));
    checkBudpStatus(platform, budp, device);
    return budp;
  }

  /*********************************************************************
   * setDeviceState
   *
   */
  async setDeviceState(platform: YoLinkHomebridgePlatform, device: YoLinkDevice, state, method = 'setState')
    : Promise<yolinkBUDP | undefined> {
    try {
      return await this.trySetDeviceState.bind(this)(platform, device, state, method);
    } catch (e) {
      const msg = ((e instanceof Error) ? e.stack : e) as string;
      const errCode = msg.split('YoLink API error code: ').pop()?.substring(0, 6);
      if (!((errCode === '000201') || (errCode === '010301') || (errCode === '020104'))) {
        // ignore common errors, will have been logged already.
        platform.log.error('Error in setDeviceState' + platform.reportError + msg);
      }
      return (undefined);
    }
    // Retry 10 times. On failure retry after 10 seconds.  Add 10 seconds for
    // each failure with maximum of 30 seconds between each retry.
    // return await retryFn(platform, this.trySetDeviceState.bind(this, platform, device, state, method),
    //  1, 10000, 10000, 30000) as yolinkBUDP;
  }

  async trySetDeviceState(platform: YoLinkHomebridgePlatform, device, state, method = 'setState'): Promise<yolinkBUDP> {
    platform.log.info(`YoLinkAPI.setDeviceState for ${device.name} (${device.deviceId}): ${JSON.stringify(state)}`);
    let budp: yolinkBUDP = undefined!;
    const accessToken = await this.getAccessToken(platform);
    const bddp: yolinkBDDP = {
      time: new Date().getTime(),
      method: device.type + '.' + method,
      targetDevice: device.deviceId,
      token: device.token,
    };
    if (state) {
      bddp.params = state;
    }
    platform.verboseLog('SENDING:\n' + JSON.stringify(bddp));
    const response = await fetch(platform.config.apiURL,
      {
        method: 'POST', body: JSON.stringify(bddp),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
      });
    checkHttpStatus(response);
    budp = await response.json();
    platform.verboseLog('RECEIVED:\n' + JSON.stringify(budp));
    checkBudpStatus(platform, budp, device);
    return budp;
  }

  /*********************************************************************
   * mqtt
   *
   * Open a MQTT session with YoLink API server to receive update
   * messages from YoLink for each device.
   */
  mqtt(platform: YoLinkHomebridgePlatform, msgCallback) {
    // Make sure we don't have a timer waiting to fire.  That would cause
    // an unnecessary second call on this function.
    if (this.mqttTimer !== null) {
      clearTimeout(this.mqttTimer);
      this.mqttTimer = null;
    }
    const url = `mqtt://${this.mqttHost}:${platform.config.mqttPort.toString()}`;
    const reports = `yl-home/${this.yolinkHomeId}/+/report`;

    platform.log.info('Create MQTT client to connect to YoLink message service');
    const options = {
      clean: true,
      username: this.yolinkTokens.access_token,
      reconnectPeriod: 2000,
    };

    // Make a note of the access token expire time for the token used to start
    // the MQTT session. If we need to restart the MQTT session then we may need
    // to do so with a new access token.
    this.mqttTokenExpireTime = this.accessTokenExpireTime;
    platform.verboseLog(`MQTT options: ${JSON.stringify(options)}`);
    this.mqttClient = mqtt.connect(url, options);

    this.mqttClient.on('connect', () => {
      platform.verboseLog(`MQTT connect: subscribe to messages for '${reports}'`);
      this.mqttClient.subscribe(reports, (error) => {
        if (error) {
          throw (new Error(`MQTT subscribe error: ${error}`));
        } else {
          platform.log.info(`MQTT subscribed: ${reports}`);
        }
      });
    });

    this.mqttClient.on('message', (topic, message: Buffer) => {
      platform.verboseLog(`MQTT message: ${topic}\n${JSON.stringify(JSON.parse(message.toString()), null, 2)}`);
      msgCallback(message);
    });

    this.mqttClient.on('reconnect', () => {
      if (Math.floor(new Date().getTime() / 1000) >= this.mqttTokenExpireTime) {
        platform.log.info(`MQTT reconnect:  Connected: ${this.mqttClient.connected}, Access token expired, restart MQTT client`);
        this.mqttClient.end(true, undefined);
        this.mqtt(platform, msgCallback);
      } else {
        platform.log.info(`MQTT reconnect: Connected: ${this.mqttClient.connected}`);
      }
    });

    this.mqttClient.on('close', () => {
      platform.verboseLog(`MQTT close: Connected: ${this.mqttClient.connected}`);
    });

    this.mqttClient.on('disconnect', (packet) => {
      platform.verboseLog('MQTT disconnect:' + packet);
    });

    this.mqttClient.on('offline', () => {
      platform.verboseLog(`MQTT offline: Connected: ${this.mqttClient.connected}`);
    });

    this.mqttClient.on('end', () => {
      platform.verboseLog('MQTT end');
    });

    this.mqttClient.on('error', (error) => {
      platform.log.error(`MQTT error: '${error}' Connected: ${this.mqttClient.connected}`);
      if (!this.mqttClient.connected) {
        this.mqttClient.end(true, undefined);
        if (this.mqttTimer === null) {
          platform.log.info('MQTT client not connected, wait 5 seconds and then attempt restart');
          // We wait 5 seconds so as not to get into a really fast loop of retries if we
          // keep getting an error. Don't start new timer if one already running.
          this.mqttTimer = setTimeout(() => {
            this.mqttTimer = null;
            this.mqtt(platform, msgCallback);
          }, 5000);
        }
      }
    });

  }
}
