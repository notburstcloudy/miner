const io = require('socket.io-client');
const { hostname } = require('os');
const EventEmitter = require('events');
const eventBus = require('../services/event-bus');
const config = require('../services/config');
const MiningInfo = require('../miningInfo');
const version = require('../version');
const outputUtil = require('../output-util');
const OutageDetectionMixin = require('./mixins/outage-detection-mixin');

class SocketIo extends OutageDetectionMixin(EventEmitter) {
  constructor(upstreamConfig) {
    super();
    this.upstreamName = outputUtil.getName(upstreamConfig);
    this.upstreamConfig = upstreamConfig;
    this.userAgent = `Foxy-Miner ${version}`;
    this.defaultMinerName = `${this.userAgent}/${hostname()}`;
    this.miningInfo = {height: 0, toObject: () => ({height: 0})};
  }

  async init() {
    this.connected = false;
    this.client = io(this.upstreamConfig.url);

    this.client.on('connect', () => {
      this.connected = true;
      eventBus.publish('log/debug', `${this.upstreamName} | url=${this.upstreamConfig.url} | socketio opened`);
    });
    this.client.on('disconnect', () => {
      this.connected = false;
      eventBus.publish('log/debug', `${this.upstreamName} | url=${this.upstreamConfig.url} | socketio closed`);
    });

    this.client.on('miningInfo', this.onNewRound.bind(this));
    this.client.on('connect', () => this.client.emit('getMiningInfo', this.onNewRound.bind(this)));
    this.client.emit('getMiningInfo', this.onNewRound.bind(this));
  }

  async onNewRound(para) {
    this.connected = true;
    if (this.upstreamConfig.sendTargetDL) {
      para.targetDeadline = this.upstreamConfig.sendTargetDL;
    }
    const miningInfo = new MiningInfo(para.height, para.baseTarget, para.generationSignature, para.targetDeadline);
    if (this.miningInfo && this.miningInfo.height === miningInfo.height && this.miningInfo.baseTarget === miningInfo.baseTarget) {
      return;
    }
    this.miningInfo = miningInfo;
    this.emit('new-round', miningInfo);
    let newBlockLine = `${this.upstreamName} | ${outputUtil.getString(`New block ${miningInfo.height}, baseTarget ${miningInfo.baseTarget}`, 'green')}`;
    if (!config.compact) {
      newBlockLine += outputUtil.getString(`, netDiff ${miningInfo.netDiff.toFixed(0)} TiB`, 'green');
      if (miningInfo.targetDeadline) {
        newBlockLine += outputUtil.getString(`, targetDeadline: ${miningInfo.targetDeadline}`, 'green');
      }
    }
    eventBus.publish('log/info', newBlockLine);
  }

  async submitNonce(submission, minerSoftware, options) {
    const result = await new Promise(resolve => this.client.emit('submitNonce', submission.toObject(), {
      minerName: this.upstreamConfig.minerName || options.minerName || this.defaultMinerName,
      userAgent: `${this.userAgent} | ${minerSoftware}`,
      capacity: options.capacity,
      accountKey: this.upstreamConfig.accountKey,
      payoutAddress: this.upstreamConfig.payoutAddress || this.upstreamConfig.accountKey,
      maxScanTime: this.upstreamConfig.maxScanTime,
      accountName: this.upstreamConfig.accountName || options.accountName || null,
      color: this.upstreamConfig.minerColor || options.color || null,
    }, resolve));

    return {
      error: null,
      result,
    };
  }

  getMiningInfo() {
    return this.miningInfo.toObject();
  }
}

module.exports = SocketIo;