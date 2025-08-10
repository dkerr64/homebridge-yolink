/***********************************************************************
 * YoLink Local API class
 *
 * Copyright (c) 2022-2024 David Kerr
 *
 * Based on documentation at http://doc.yosmart.com/docs/protocol/local_hub/openAPILocal
 *
 * Manages login with Local Hub credentials, obtaining list
 * of devices from local YoLink hub, getting and setting values, and
 * subscribing to alerts and messages with MQTT
 */

import { URLSearchParams } from 'url';
import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';
import { IYoLinkAPI, yolinkBDDP, yolinkBUDP, yolinkAccessTokens } from './yolinkAPIInterface';
import fetch from 'node-fetch';
import Semaphore from 'semaphore-promise';
import mqtt, { IClientOptions } from 'mqtt';

/***********************************************************************
 * Support functions for HTTP calls to YoLink Local API
 * retryFn - reused from main API file pattern
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
  const devName = device ? `[${device.deviceMsgName}] ` : '';
  if (!budp) {
    throw (new Error(`${devName}YoLink Local API error: BUDP undefined or null`));
  }
  if (budp.state && budp.state === 'error') {
    if (device) {
      device.errorState = true;
    }
    throw (new Error(`${devName}YoLink Local API error: ${budp.msg}`));
  }
  if (!budp.code) {
    // If no return code part of the packet then can return now without further checking.
    return true;
  }
  if (budp.code !== '000000') {
    if ((budp.code === '000201') || (budp.code === '010301') || (budp.code === '020104')) {
      // Common errors from YoLink API that I want user to see.
      platform.log.warn(`${devName}YoLink Local API error code: ${budp.code} ${budp.desc} (${budp.method})`);
    } else {
      // Unexpected error?
      platform.log.error(`${devName}YoLink Local API error code: ${budp.code} ${budp.desc} (${budp.method})`);
    }
    if (device) {
      device.errorState = true;
    }
    throw (new Error(`${devName}YoLink Local API error code: ${budp.code} ${budp.desc} (${budp.method})`));
  } else if (!budp.data) {
    platform.log.warn(`${devName}Successful YoLink Local API call but no data field:\n${JSON.stringify(budp, null, 2)}`);
  }
  return true;
}

/***********************************************************************
 * YoLinkLocalAPI class and constructor
 */
export class YoLinkLocalAPI implements IYoLinkAPI {

  private yolinkTokens: yolinkAccessTokens = {
    access_token: '',
    refresh_token: '',
    expires_in: 0,
    token_type: '',
  };

  private yolinkLoggedIn: boolean;
  private accessSemaphore: Semaphore;

  private accessTokenRefreshAt = 0.90;    // test with 0.005, production 0.90
  private accessTokenHeartbeatAt = 0.95;  // test with 0.008, production 0.95
  private accessTokenExpireTime = 0;
  private accessTokenHeartbeat;

  private mqttTokenExpireTime = 0;
  private mqttClient;
  private mqttTimer: null | ReturnType<typeof setTimeout> = null;

  private baseURL: string;
  private tokenURL: string;
  private apiURL: string;
  private subnetId: string;

  constructor(private readonly platform: YoLinkHomebridgePlatform) {
    platform.verboseLog('YoLinkLocalAPI.constructor');
    Error.stackTraceLimit = 100;

    this.yolinkLoggedIn = false;
    
    // Validate local hub configuration
    if (!platform.config.hubIPAddress) {
      throw new Error('FATAL: Local hub IP address is required for local API');
    }
    if (!platform.config.subnetId) {
      throw new Error('FATAL: Subnet ID is required for local API MQTT subscriptions');
    }

    this.baseURL = `http://${platform.config.hubIPAddress}:1080`;
    this.tokenURL = `${this.baseURL}/open/yolink/token`;
    this.apiURL = `${this.baseURL}/open/yolink/v2/api`;
    this.subnetId = platform.config.subnetId;

    this.accessSemaphore = new Semaphore();
  }

  /*********************************************************************
   * login
   */
  async login(platform: YoLinkHomebridgePlatform) {
    // Infinitely retry. On failure retry after 15 seconds.  Add 15 seconds for
    // each failure with maximum of 60 seconds between each retry.
    await retryFn(platform, this.tryLogin.bind(this, platform), 0, 15000, 15000, 60000);
  }

  async tryLogin(platform: YoLinkHomebridgePlatform) {
    this.yolinkLoggedIn = false;
    if (!platform.config.userAccessId || !platform.config.secretKey) {
      throw (new Error('FATAL: Missing userAccessId (Client ID) or secretKey (Client Secret) credentials in config.'));
    }
    platform.log.info('Login to YoLink Local API with credentials from config');

    // Login to retrieve YoLink tokens from local hub
    const timestamp = new Date().getTime();
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', platform.config.userAccessId.trim());
    params.append('client_secret', platform.config.secretKey.trim());
    platform.verboseLog('SENDING TO LOCAL HUB:\n' + params);
    
    try {
      const response = await fetch(this.tokenURL, { method: 'POST', body: params });
      checkHttpStatus(response);
      this.yolinkTokens = await response.json();
      platform.verboseLog('RECEIVED FROM LOCAL HUB:\n' + JSON.stringify(this.yolinkTokens));
      checkBudpStatus(platform, this.yolinkTokens);
      this.accessTokenExpireTime = Math.floor(this.yolinkTokens.expires_in * this.accessTokenRefreshAt) + Math.floor(timestamp / 1000);
      this.yolinkLoggedIn = true;
    } catch (error) {
      throw new Error(`Failed to connect to local hub at ${this.baseURL}: ${error.message}`);
    }

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
      platform.verboseLog('YoLinkLocalAPI.getAccessToken');

      if (!this.yolinkLoggedIn) {
        platform.log.error('Not logged in to YoLink Local API, try to login');
        await this.login(platform);
      }

      const timestamp = new Date().getTime();
      if (this.accessTokenExpireTime < Math.floor(timestamp / 1000)) {
        // We need to get a new access token, current one has or is about to expire
        platform.verboseLog('Current access token expired, or close to expiry, requesting new one from local hub');
        const params = new URLSearchParams();
        params.append('grant_type', 'refresh_token');
        params.append('client_id', platform.config.userAccessId.trim());
        params.append('refresh_token', this.yolinkTokens.refresh_token);
        platform.verboseLog('SENDING TO LOCAL HUB:\n' + params);
        const response = await fetch(this.tokenURL, { method: 'POST', body: params });
        checkHttpStatus(response);
        this.yolinkTokens = await response.json();
        platform.verboseLog('RECEIVED FROM LOCAL HUB:\n' + JSON.stringify(this.yolinkTokens));
        checkBudpStatus(platform, this.yolinkTokens);
        this.accessTokenExpireTime = Math.floor(this.yolinkTokens.expires_in * this.accessTokenRefreshAt) + Math.floor(timestamp / 1000);
      }
    } catch (e) {
      // If error occurred that we probably need to login again.  Propagate the error up.
      this.yolinkLoggedIn = false;
      throw (e);
    } finally {
      releaseSemaphore();
    }
    return this.yolinkTokens.access_token;
  }

  /*********************************************************************
   * getDeviceList
   */
  async getDeviceList(platform: YoLinkHomebridgePlatform): Promise<YoLinkDevice[]> {
    // Infinitely retry. On failure retry after 15 seconds.  Add 15 seconds for
    // each failure with maximum of 60 seconds between each retry.
    return await retryFn(platform, this.tryGetDeviceList.bind(this, platform), 0, 15000, 15000, 60000) as YoLinkDevice[];
  }

  async tryGetDeviceList(platform: YoLinkHomebridgePlatform): Promise<YoLinkDevice[]> {
    platform.verboseLog('YoLinkLocalAPI.getDeviceList');
    const accessToken = await this.getAccessToken(platform);

    const bddp: yolinkBDDP = {
      time: new Date().getTime(),
      method: 'Home.getDeviceList',
    };
    platform.verboseLog('SENDING TO LOCAL HUB:\n' + JSON.stringify(bddp));
    const response = await fetch(this.apiURL,
      {
        method: 'POST', body: JSON.stringify(bddp),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
      });
    checkHttpStatus(response);
    const budp: yolinkBUDP = await response.json();
    platform.verboseLog('RECEIVED FROM LOCAL HUB:\n' + JSON.stringify(budp));
    checkBudpStatus(platform, budp);
    
    // Local API returns devices array directly or single device
    let devices = budp.data.devices || [budp.data];
    if (!Array.isArray(devices)) {
      devices = [devices];
    }
    
    platform.liteLog(`YoLinkLocalAPI.getDeviceList found ${devices.length} devices`);
    return devices;
  }

  /*********************************************************************
   * getDeviceState
   */
  async getDeviceState(platform: YoLinkHomebridgePlatform, device): Promise<yolinkBUDP> {
    // Retry 30 times. On failure retry after 5 seconds.  Add 5 seconds for
    // each failure with maximum of 60 seconds between each retry.
    return await retryFn(platform, this.tryGetDeviceState.bind(this, platform, device), 30, 5000, 5000, 60000) as yolinkBUDP;
  }

  async tryGetDeviceState(platform: YoLinkHomebridgePlatform, device: YoLinkDevice) {
    platform.liteLog(`[${device.deviceMsgName}] YoLinkLocalAPI.getDeviceState`);
    let budp: yolinkBUDP = undefined!;
    const accessToken = await this.getAccessToken(platform);
    const bddp: yolinkBDDP = {
      time: new Date().getTime(),
      method: device.type + '.getState',
      targetDevice: device.deviceId,
      token: device.token,
    };
    platform.verboseLog('SENDING TO LOCAL HUB:\n' + JSON.stringify(bddp, null, 2));
    const response = await fetch(this.apiURL,
      {
        method: 'POST', body: JSON.stringify(bddp),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
      });
    checkHttpStatus(response);
    budp = await response.json();
    platform.verboseLog('RECEIVED FROM LOCAL HUB:\n' + JSON.stringify(budp, null, 2));
    checkBudpStatus(platform, budp, device);
    return budp;
  }

  /*********************************************************************
   * setDeviceState
   */
  async setDeviceState(platform: YoLinkHomebridgePlatform, device: YoLinkDevice, state, method = 'setState'): Promise<yolinkBUDP | undefined> {
    // Retry 5 times. On failure retry after 10 seconds.  Add 10 seconds for
    // each failure with maximum of 30 seconds between each retry.
    return await retryFn(platform, this.trySetDeviceState.bind(this, platform, device, state, method), 5, 10000, 10000, 30000) as yolinkBUDP;
  }

  async trySetDeviceState(platform: YoLinkHomebridgePlatform, device, state, method = 'setState'): Promise<yolinkBUDP> {
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
    platform.verboseLog('SENDING TO LOCAL HUB:\n' + JSON.stringify(bddp, null, 2));
    const response = await fetch(this.apiURL,
      {
        method: 'POST', body: JSON.stringify(bddp),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
      });
    checkHttpStatus(response);
    budp = await response.json();
    platform.verboseLog('RECEIVED FROM LOCAL HUB:\n' + JSON.stringify(budp, null, 2));
    checkBudpStatus(platform, budp, device);
    platform.log.info(`[${device.deviceMsgName}] Device state set: ${(state) ? JSON.stringify(state) : method}`);
    return budp;
  }

  /*********************************************************************
   * mqtt
   *
   * Open a MQTT session with YoLink Local Hub to receive update
   * messages from YoLink for each device.
   */
  mqtt(platform: YoLinkHomebridgePlatform, msgCallback) {
    // Make sure we don't have a timer waiting to fire.  That would cause
    // an unnecessary second call on this function.
    if (this.mqttTimer !== null) {
      clearTimeout(this.mqttTimer);
      this.mqttTimer = null;
    }
    
    const url = `mqtt://${platform.config.hubIPAddress}:18080`;
    const reports = `ylsubnet/${this.subnetId}/+/report`;

    platform.log.info('Create MQTT client to connect to YoLink Local Hub message service');
    const options: IClientOptions = {
      clean: true,
      username: platform.config.userAccessId,
      password: this.yolinkTokens.access_token,
      reconnectPeriod: 30 * 1000,
      connectTimeout: 30 * 1000,
    };

    // Make a note of the access token expire time for the token used to start
    // the MQTT session. If we need to restart the MQTT session then we may need
    // to do so with a new access token.
    this.mqttTokenExpireTime = this.accessTokenExpireTime;
    platform.verboseLog(`Local MQTT options: ${JSON.stringify(options)}`);
    this.mqttClient = mqtt.connect(url, options);

    this.mqttClient.on('connect', () => {
      platform.verboseLog(`Local MQTT connect: subscribe to messages for '${reports}'`);
      this.mqttClient.subscribe(reports, (error) => {
        if (error) {
          throw (new Error(`Local MQTT subscribe error: ${error}`));
        } else {
          platform.log.info(`Local MQTT subscribed: ${reports}`);
        }
      });
    });

    this.mqttClient.on('message', (topic, message: Buffer) => {
      platform.verboseLog(`Local MQTT message: ${topic}\n${JSON.stringify(JSON.parse(message.toString()), null, 2)}`);
      msgCallback(message);
    });

    this.mqttClient.on('reconnect', () => {
      if (Math.floor(new Date().getTime() / 1000) >= this.mqttTokenExpireTime) {
        platform.log.info(`Local MQTT reconnect:  Connected: ${this.mqttClient.connected}, Access token expired, restart MQTT client`);
        this.mqttClient.end(true, undefined);
        this.mqtt(platform, msgCallback);
      } else {
        platform.log.info(`Local MQTT reconnect: Connected: ${this.mqttClient.connected}`);
      }
    });

    this.mqttClient.on('close', () => {
      platform.verboseLog(`Local MQTT close: Connected: ${this.mqttClient.connected}`);
    });

    this.mqttClient.on('disconnect', (packet) => {
      platform.verboseLog('Local MQTT disconnect:' + packet);
    });

    this.mqttClient.on('offline', () => {
      platform.verboseLog(`Local MQTT offline: Connected: ${this.mqttClient.connected}`);
    });

    this.mqttClient.on('end', () => {
      platform.verboseLog('Local MQTT end');
    });

    this.mqttClient.on('error', (error) => {
      platform.log.error(`Local MQTT error: '${error}' Connected: ${this.mqttClient.connected}`);
      if (!this.mqttClient.connected) {
        this.mqttClient.end(true, undefined);
        if (this.mqttTimer === null) {
          platform.log.info('Local MQTT client not connected, wait 5 seconds and then attempt restart');
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
