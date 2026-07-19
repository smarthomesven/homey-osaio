'use strict';

const Homey = require('homey');
const axios = require('axios');

module.exports = class MyDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');
    if (!this.hasCapability('onoff')) {
      await this.addCapability('onoff');
    }
    if (!this.hasCapability('refresh')) {
      await this.addCapability('refresh');
    }
    this._snapshot = await this.homey.images.createImage();
    await this.setSnapshot();
    this.homey.setInterval(() => this.setSnapshot(), 10 * 60 * 1000);
    this.setCameraImage('camera', 'Camera', this._snapshot);
    this.deviceModel = this.getStoreValue("type");
    this.osaioUuid = this.getData().uuid;
    this.homey.app.connection.registerDevice(this.osaioUuid, this);
    this.registerCapabilityListener('onoff', async (value) => {
      await this.setCameraOnOff(value);
    });
    this.registerCapabilityListener('refresh', async () => {
      this.log('Refresh capability triggered, fetching new snapshot...');
      await this.setSnapshot();
    });
    const refreshSnapshotAction = this.homey.flow.getActionCard('refresh_snapshot');
    refreshSnapshotAction.registerRunListener(async (args, state) => {
      this.log('Flow action triggered, fetching new snapshot...');
      await this.setSnapshot();
      return true;
    });
  }

  async setSnapshot() {
    try {
      this.log('Fetching snapshot for device:', this.getName());
      this._snapshot.setStream(async (stream) => {
        const client = this.driver._getAuthedClient();
        if (!client) {
          this.log('No authenticated client available');
          return;
        }
        const tz = this.homey.clock.getTimezone();
        const date = new Date().toLocaleDateString('en-CA', { timeZone: tz });
        this.log('Fetching snapshot for date:', date);
        const response = await client.get('/msg/device/all', {
          params: { 
            uuids: this.getData().uuid, 
            date: date,
            rows: 10,
            zone: 0.0,
            direction: 'desc',
            sort: 1,
            contain_start_id: 0 },
        });
        const respData = response.data;
        if (respData.code === 1006) {
          await this.homey.driver.auth();
          return;
        }
        const data = respData.data[0];
        const imageResponse = await axios.get(data.files, {
          responseType: 'stream',
        });
        return imageResponse.data.pipe(stream);
      });
      this._snapshot.update();
    } catch (error) {
      this.error('Error fetching snapshot:', error);
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MyDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('MyDevice settings were changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
async onDeleted() {
  this.homey.app.connection.unregisterDevice(this.osaioUuid);
}

getPollAttributes() {
  return ['CameraOnOff', 'OnlineStatus', 'MotionDetectSW', 'LedOnOff'];
}

onOsaioPush({ data }) {
  if ('CameraOnOff' in data) this.setCapabilityValue('onoff', !!data.CameraOnOff).catch(this.error);
  if ('OnlineStatus' in data) {
    data.OnlineStatus ? this.setAvailable().catch(this.error)
                      : this.setUnavailable('Camera is offline. Make sure it\'s powered up and connected to the internet.').catch(this.error);
  }
}

async setCameraOnOff(value) {
  return this.homey.app.connection.send('atr.set', this.osaioUuid, this.deviceModel, {
    CameraOnOff: value ? 1 : 0,
  });
}

};
