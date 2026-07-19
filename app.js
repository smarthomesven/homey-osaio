'use strict';

const Homey = require('homey');
const WebSocket = require('ws');
const axios = require('axios');

const WS_URL = 'wss://ali-wss-eu.osaio.net/ws';
const APPID = '3dab98eee85b7ae8';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 25000;
const PONG_TIMEOUT_MS = 10000;
const SEND_TIMEOUT_MS = 8000;

/**
 * Single shared WS connection for all OSAIO devices.
 * Devices register themselves and receive atr.post pushes for their own uuid.
 * Outbound atr.get / atr.set / service.* calls are routed by msg_id.
 */
class OsaioConnection {
  constructor(app) {
    this.app = app; // Homey.App instance, for logging + getAuthHeaders()
    this.ws = null;
    this.devices = new Map(); // uuid -> device instance (must implement onOsaioPush(data))
    this.pending = new Map(); // msg_id -> { resolve, reject, timeout }
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.connected = false;
    this.connecting = false;
    this.destroyed = false;
    this.wsUrl = null;
  }

  // --- lifecycle -----------------------------------------------------

  async start() {
    this.destroyed = false;
    this.wsUrl = this.app._wsUrl || WS_URL;
    await this._connect();
  }

  async stop() {
    this.destroyed = true;
    this._clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch (err) { /* ignore */ }
      this.ws = null;
    }
    this._rejectAllPending(new Error('connection stopped'));
  }

  async _connect() {
    if (this.connecting || this.destroyed) return;
    this.connecting = true;

    let headers;
    try {
      headers = await this.app.getAuthHeaders(); // { api_token, appid, phone_code, uid }
    } catch (err) {
      this.app.error('OSAIO: failed to get auth headers, will retry', err);
      this.connecting = false;
      this._scheduleReconnect();
      return;
    }

    this.app.log('OSAIO: connecting to', this.wsUrl);

    const ws = new WebSocket(this.wsUrl, {
      headers: {
        api_token: headers.api_token,
        appid: headers.appid,
        phone_code: headers.phone_code,
        uid: headers.uid,
      },
    });

    ws.on('open', () => this._onOpen());
    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('pong', () => this._onPong());
    ws.on('close', (code, reason) => this._onClose(code, reason));
    ws.on('error', (err) => this._onError(err));

    this.ws = ws;
  }

  // --- socket event handlers ------------------------------------------

  async _onOpen() {
    this.app.log('OSAIO: connected');
    this.connecting = false;
    this.connected = true;
    this.reconnectAttempt = 0;
    this._startPing();

    // Resync every registered device in case we missed pushes while down.
    for (const [uuid, device] of this.devices) {
      this._resyncDevice(uuid, device).catch((err) =>
        this.app.error(`OSAIO: resync failed for ${uuid}`, err));
    }
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      this.app.error('OSAIO: bad JSON from WS', err);
      return;
    }

    const { msg_id, method, uuid, code, data } = msg;

    // Unsolicited (or set-confirmation) state push from a device.
    if (method === 'atr.post' || method === 'event.IceCandidate' || method === 'response.SdpAnswer') {
      const device = this.devices.get(uuid);
      if (device && typeof device.onOsaioPush === 'function') {
        device.onOsaioPush(msg);
      }
      // still fall through in case something we sent is also waiting on this msg_id
    }

    const pending = this.pending.get(msg_id);
    if (pending) {
      this.pending.delete(msg_id);
      clearTimeout(pending.timeout);
      if (code !== undefined && code !== 1000) {
        pending.reject(new Error(msg.msg || `OSAIO error code ${code}`));
      } else {
        pending.resolve(data);
      }
    }
  }

  _onPong() {
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  _onClose(code, reason) {
    this.app.log(`OSAIO: WS closed (${code}) ${reason || ''}`);
    this._handleDisconnect();
  }

  _onError(err) {
    this.app.error('OSAIO: WS error', err);
    // 'close' usually follows an error, but don't double-schedule if it doesn't.
    if (this.connected || this.connecting) this._handleDisconnect();
  }

  _handleDisconnect() {
    this.connected = false;
    this.connecting = false;
    this._clearTimers();
    this._rejectAllPending(new Error('connection lost'));
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
    for (const device of this.devices.values()) {
      if (typeof device.setUnavailable === 'function') {
        device.setUnavailable('Reconnecting to OSAIO...').catch(() => {});
      }
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    ) * (0.75 + Math.random() * 0.5); // jitter
    this.reconnectAttempt += 1;
    this.app.log(`OSAIO: reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  // --- keepalive --------------------------------------------------------

  _startPing() {
    this._clearPingTimers();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        this.app.log('OSAIO: pong timeout, forcing reconnect');
        try { this.ws.terminate(); } catch (err) { /* ignore */ }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  _clearPingTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  _clearTimers() {
    this._clearPingTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  _rejectAllPending(err) {
    for (const [msg_id, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    this.pending.clear();
  }

  // --- device registry ----------------------------------------------

  registerDevice(uuid, device) {
    this.devices.set(uuid, device);
    if (this.connected) {
      this._resyncDevice(uuid, device).catch((err) =>
        this.app.error(`OSAIO: initial sync failed for ${uuid}`, err));
    }
  }

  unregisterDevice(uuid) {
    this.devices.delete(uuid);
  }

  async _resyncDevice(uuid, device) {
    if (typeof device.getPollAttributes !== 'function') return;
    const attrs = device.getPollAttributes(); // e.g. ['CameraOnOff','OnlineStatus',...]
    const data = await this.send('atr.get', uuid, device.deviceModel, attrs);
    if (typeof device.onOsaioPush === 'function') {
      device.onOsaioPush({ method: 'atr.post', uuid, data });
    }
  }

  // --- outbound send ---------------------------------------------------

  send(method, uuid, deviceModel, data, { timeoutMs = SEND_TIMEOUT_MS } = {}) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('OSAIO: not connected'));
    }

    const msg_id = `ad-${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const payload = {
      method,
      msg_id,
      ver: '1.0',
      origin: 1,
      time: Math.floor(Date.now() / 1000),
      uuid,
      device_model: deviceModel,
      data,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(msg_id);
        reject(new Error(`OSAIO: timeout waiting for ${method} response`));
      }, timeoutMs);

      this.pending.set(msg_id, { resolve, reject, timeout });

      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(msg_id);
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }
}

class OsaioApp extends Homey.App {
  async onInit() {
    this.log('OSAIO app starting');
    this._wsUrl = this.homey.settings.get('wsURL') || 'wss://ali-wss-eu.osaio.net/ws';
    this.connection = new OsaioConnection(this);
    await this.connection.start();
    try {
      const { randomUUID } = require('crypto');
      let id = this.homey.settings.get('id');
      if (!id) {
        id = randomUUID();
        this.homey.settings.set('id', id);
      }
      await axios.post('https://homey-apps-telemetry.vercel.app/api/installations', {
        id: id,
        appId: "net.osaio",
        homeyPlatform: this.homey.platformVersion ? this.homey.platformVersion : 1,
        appVersion: this.manifest.version,
      }).catch(error => {
        this.error('Error sending telemetry data:', error.message);
      });
    } catch (error) {
      this.error('Error in onInit:', error.message);
    }
  }

  async onUninit() {
    await this.connection.stop();
  }

  async getAuthHeaders() {
    const apiToken = this.homey.settings.get('apiToken');
    const uid = this.homey.settings.get('uid');
    const phoneCode = this.homey.settings.get('phoneCode');
    if (!apiToken || !uid || !phoneCode) {
      throw new Error('OSAIO: missing auth credentials, please login first');
    }
    return {
      api_token: apiToken,
      appid: APPID,
      phone_code: phoneCode,
      uid: uid,
    };
  }
}

module.exports = OsaioApp;