/***********************************************************************
 * YoLink API Interface
 *
 * Copyright (c) 2022-2024 David Kerr
 *
 * Abstract interface for YoLink API implementations (cloud and local)
 */

import { YoLinkHomebridgePlatform, YoLinkDevice } from './platform';

// YoLink Basic Downlink Data Packet (BDDP) represents data format for
// API requests sent TO YoLink.
export type yolinkBDDP = {
  time: number;
  method: string;
  msgid?: string;
  targetDevice?: string;
  token?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

// YoLink Basic Uplink Data Packet (BUDP) represents data format for
// data received FROM YoLink in reply to API requests.
export type yolinkBUDP = {
  time: number;
  method: string;
  msgid: string;
  code: string;
  desc: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

export type yolinkAccessTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  state?: string;
  msg?: string;
};

/**
 * Abstract interface for YoLink API implementations
 */
export interface IYoLinkAPI {
  /**
   * Login to YoLink API and obtain access tokens
   */
  login(platform: YoLinkHomebridgePlatform): Promise<void>;

  /**
   * Get access token (refresh if needed)
   */
  getAccessToken(platform: YoLinkHomebridgePlatform): Promise<string>;

  /**
   * Get list of devices from YoLink
   */
  getDeviceList(platform: YoLinkHomebridgePlatform): Promise<YoLinkDevice[]>;

  /**
   * Get current state of a device
   */
  getDeviceState(platform: YoLinkHomebridgePlatform, device: YoLinkDevice): Promise<yolinkBUDP>;

  /**
   * Set state of a device
   */
  setDeviceState(
    platform: YoLinkHomebridgePlatform, 
    device: YoLinkDevice, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state: any, 
    method?: string
  ): Promise<yolinkBUDP | undefined>;

  /**
   * Setup MQTT connection for real-time updates
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mqtt(platform: YoLinkHomebridgePlatform, msgCallback: (message: any) => void): void;
}
