'use strict';
const Homey = require('homey');
const axios = require('axios');
const crypto = require('crypto');
const APPID = '3dab98eee85b7ae8';
/* NOTE:
 The secret is omitted from GitHub for security reasons.
 When building from source, you'll need to extract it yourself from the Android app.
*/
const SECRET = Homey.env.SECRET;

module.exports = class K1ProDriver extends Homey.Driver {
  async onInit() {
    this.log('K1Pro driver has been initialized');
  }

  // Build (or rebuild) an authenticated client from stored settings.
  // Call this whenever you need it, instead of relying on a handler-scoped variable.
  _getAuthedClient() {
    const baseURL = this.homey.settings.get('baseURL');
    const uid = this.homey.settings.get('uid');
    const apiToken = this.homey.settings.get('apiToken');
    if (!baseURL || !uid || !apiToken) return null;
    return this.createOsaioClient({ baseURL, uid, apiToken, baseUrlName: 'web_baseurl' });
  }

  async onPair(session) {
    session.setHandler('showView', async (viewId) => {
      if (viewId === 'notice') {
        if (this._getAuthedClient()) {
          await session.showView('list_devices');
        }
      }
    });

    session.setHandler('login', async (loginData) => {
      try {
        const email = loginData.email;
        const password = loginData.password;
        if (!email || !password) {
          return false;
        }

        const bootstrapClient = this.createOsaioClient({
          baseURL: 'https://global.osaio.net/v2',
          baseUrlName: 'global',
        });
        const response = await bootstrapClient.get('/account/get-baseurl', {
          params: { account: email, country: '1' },
        });

        const homeyId = await this.homey.cloud.getHomeyId();
        const phoneCode = crypto.createHash('md5').update(homeyId).digest('hex');

        const preLoginClient = this.createOsaioClient({
          baseURL: response.data.data.web,
          baseUrlName: 'web',
        });
        const loginResponse = await preLoginClient.post('/login/login', {
          account: email,
          country: '1',
          password: crypto.createHash('md5').update(password).digest('hex'),
          phone_brand: 'google',
          phone_code: phoneCode,
          timezone_name: 'GMT',
          zone: 0.0,
        });

        const respData = loginResponse.data;
        if (respData.code !== 1000 || !respData.data) {
          this.error(`Login failed: code=${respData.code} msg=${respData.msg}`);
          return false;
        }
        if (!respData.data.api_token || !respData.data.uid) {
          this.error('Login failed: Missing api_token or uid in response');
          return false;
        }

        this.homey.settings.set('baseURL', response.data.data.web);
        this.homey.settings.set('wsURL', response.data.data.ws);
        this.homey.settings.set('email', email);
        this.homey.settings.set('password', password);

        this.homey.settings.set('apiToken', respData.data.api_token);
        this.homey.settings.set('uid', respData.data.uid);
        this.homey.settings.set('refreshToken', respData.data.refresh_token);
        this.homey.settings.set('phoneCode', phoneCode);
        this.homey.app._wsUrl = response.data.data.ws;

        await session.showView('list_devices');
        return true;
      } catch (error) {
        this.error('Error during login:', error);
        return false;
      }
    });

    session.setHandler('list_devices', async () => {
      const client = this._getAuthedClient();
      if (!client) {
        this.error('list_devices called with no authenticated client available');
        return [];
      }

      const devicesResponse = await client.get('/device/list', {
        params: { page: 1, per_page: 100 },
        headers: { 'BaseUrlName': 'web' }, 
      });

      this._devices = devicesResponse.data.data.data
        .filter((device) => device.type === 'K1PRO')
        .map((device) => ({
          id: device.device_id,
          name: device.name,
          data: { uuid: device.uuid },
          store: {
            mac: device.mac,
            model: device.type,
            productCode: device.product_code,
            secret: device.secret,
            delay_relay: device.delay_relay,
            id: device.id,
            live_time: device.live_time,
          },
        }));

      return this._devices || [];
    });
  }

  getSign({ appid = APPID, uid = '', apiToken = '', secret = SECRET, timestamp }) {
    const message = appid + timestamp + uid + apiToken;
    const hexDigest = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return Buffer.from(hexDigest, 'utf8').toString('base64');
  }

  getTime() {
    return Math.floor(Date.now() / 1000).toString();
  }

  createOsaioClient({ baseURL, uid = '', apiToken = '', signType, baseUrlName = 'web_baseurl' } = {}) {
    const resolvedSignType = signType || (uid && apiToken ? '2' : '1');
    const client = axios.create({
      baseURL,
      headers: {
        'User-Agent': 'OSAIO_ANDROID_4.4.0_657',
        appid: APPID,
        ApiSignType: resolvedSignType,
        timeout: '10',
      },
    });

    client.interceptors.request.use((config) => {
      const timestamp = this.getTime();
      const sign = this.getSign({ uid, apiToken, timestamp });
      config.headers['timestamp'] = timestamp;
      config.headers['sign'] = sign;
      if (resolvedSignType === '2') {
        config.headers['uid'] = uid;
        config.headers['api-token'] = apiToken;
      }
      return config;
    });

    return client;
  }

  async onPairListDevices() {
    return [];
  }

  async auth() {
    const email = this.homey.settings.get('email');
    const password = this.homey.settings.get('password');
    if (!email || !password) {
      throw new Error('OSAIO: missing email or password, please login first');
    }

    const bootstrapClient = this.createOsaioClient({
      baseURL: 'https://global.osaio.net/v2',
      baseUrlName: 'global',
    });
    const response = await bootstrapClient.get('/account/get-baseurl', {
      params: { account: email, country: '1' },
    });

    const homeyId = await this.homey.cloud.getHomeyId();
    const phoneCode = crypto.createHash('md5').update(homeyId).digest('hex');

    const preLoginClient = this.createOsaioClient({
      baseURL: response.data.data.web,
      baseUrlName: 'web',
    });
    const loginResponse = await preLoginClient.post('/login/login', {
      account: email,
      country: '1',
      password: crypto.createHash('md5').update(password).digest('hex'),
      phone_brand: 'google',
      phone_code: phoneCode,
      timezone_name: 'GMT',
      zone: 0.0,
    });

    const respData = loginResponse.data;
    if (respData.code !== 1000 || !respData.data) {
      throw new Error(`Login failed: code=${respData.code} msg=${respData.msg}`);
    }
    if (!respData.data.api_token || !respData.data.uid) {
      throw new Error('Login failed: Missing api_token or uid in response');
    }

    this.homey.settings.set('apiToken', respData.data.api_token);
    this.homey.settings.set('refreshToken', respData.data.refresh_token);
  }
};