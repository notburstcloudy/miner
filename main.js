#!/usr/bin/env node

const bodyParser = require('koa-bodyparser');
const chalk = require('chalk');
const http = require('http');
const Integrations = require('@sentry/integrations');
const Koa = require('koa');
const Router = require('koa-router');
const Sentry = require('@sentry/node');
const program = require('commander');
const eventBus = require('./lib/services/event-bus');
const logger = require('./lib/services/logger');
const config = require('./lib/services/config');
const Proxy = require('./lib/proxy');
const store = require('./lib/services/store');
const version = require('./lib/version');
const Scavenger = require('./lib/scavenger');
const Conqueror = require('./lib/conqueror');
const IdleProgram = require('./lib/idle-program');
const startupMessage = require('./lib/startup-message');
const profitabilityService = require('./lib/services/profitability-service');

program
  .version(version)
  .option('--config <config.yaml>', 'The custom config.yaml file path')
  .parse(process.argv);

if (program.config) {
  store.configFilePath = program.config;
}

(async () => {
  await config.init();

  startupMessage();

  Sentry.init({
    dsn: 'https://2c5b7b184ad44ed99fc457f4442386e9@sentry.io/1462805',
    release: `foxy-miner@${version}`,
    attachStacktrace: true,
    integrations: [
      new Integrations.Dedupe(),
      new Integrations.ExtraErrorData(),
      new Integrations.Transaction(),
    ],
  });

  process.on('unhandledRejection', (err) => {
    eventBus.publish('log/error', `Error: ${err.message}`);
  });
  process.on('uncaughtException', (err) => {
    eventBus.publish('log/error', `Error: ${err.message}`);
  });

  const app = new Koa();
  app.on('error', err => {
    eventBus.publish('log/error', `Error: ${err.message}`);
  });

  const router = new Router();
  app.use(bodyParser());

  if (config.useProfitability) {
    await profitabilityService.init();
  }

  const enabledUpstreams = config.upstreams.filter(upstreamConfig => !upstreamConfig.disabled);
  const proxy = new Proxy(enabledUpstreams);
  await proxy.init();

  router.get('/burst', (ctx) => {
    const requestType = ctx.query.requestType;
    switch (requestType) {
      case 'getMiningInfo':
        ctx.body = proxy.getMiningInfo();
        break;
      default:
        eventBus.publish('log/error', `Unknown requestType ${requestType} with data: ${JSON.stringify(ctx.params)}. Please message this info to the creator of this software.`);
        ctx.status = 400;
        ctx.body = {
          error: {
            message: 'unknown request type',
            code: 4,
          },
        };
    }
  });
  router.post('/burst', async (ctx) => {
    const requestType = ctx.query.requestType;
    switch (requestType) {
      case 'getMiningInfo':
        ctx.body = proxy.getMiningInfo();
        break;
      case 'submitNonce':
        const options = {
          ip: ctx.request.ip,
          maxScanTime: ctx.params.maxScanTime,
          minerName: ctx.req.headers['x-minername'] || ctx.req.headers['x-miner'],
          userAgent: ctx.req.headers['user-agent'],
          miner: ctx.req.headers['x-miner'],
          capacity: ctx.req.headers['x-capacity'],
          accountKey: ctx.req.headers['x-account'],
          accountName: ctx.req.headers['x-accountname'] || ctx.req.headers['x-mineralias'] || null,
          color: ctx.req.headers['x-color'] || null,
        };
        const submissionObj = {
          accountId: ctx.query.accountId,
          blockheight: ctx.query.blockheight,
          nonce: ctx.query.nonce,
          deadline: ctx.query.deadline,
          secretPhrase: ctx.query.secretPhrase !== '' ? ctx.query.secretPhrase : null,
        };
        ctx.body = await proxy.submitNonce(submissionObj, options);
        if (ctx.body.error) {
          ctx.status = 400;
        }
        break;
      default:
        eventBus.publish('log/error', `Unknown requestType ${requestType} with data: ${JSON.stringify(ctx.params)}. Please message this info to the creator of this software.`);
        ctx.status = 400;
        ctx.body = {
          error: {
            message: 'unknown request type',
            code: 4,
          },
        };
    }
  });

  app.use(router.routes());
  app.use(router.allowedMethods());

  const server = http.createServer(app.callback());

  server.on('error', (err) => {
    eventBus.publish('log/error', `Error: ${err.message}`);
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      process.exit(1);
    }
  });

  server.listen(config.listenPort, config.listenHost);

  const startupLine = `Foxy-Miner ${version} initialized. Accepting connections on http://${config.listenAddr}`;
  eventBus.publish('log/info', store.getUseColors() ? chalk.green(startupLine) : startupLine);

  let miner = null;
  switch (config.minerType) {
    case 'scavenger':
      miner = new Scavenger(config.minerBinPath, config.minerConfigPath);
      break;
    case 'conqueror':
      miner = new Conqueror(config.minerBinPath, config.minerConfigPath);
      break;
  }
  await miner.start();

  if (config.config.runIdleBinPath) {
    const idleProgram = new IdleProgram(config.config.runIdleBinPath, config.config.runIdleKillBinPath);
    eventBus.subscribe('miner/new-round', () => idleProgram.stop());
    eventBus.subscribe('miner/all-rounds-finished', () => idleProgram.start());
  }
})();
