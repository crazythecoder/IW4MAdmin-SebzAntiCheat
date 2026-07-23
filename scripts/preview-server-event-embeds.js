#!/usr/bin/env node

const plugin = require('../iw4madmin/Plugins/ServerEventWebhook');

plugin.config.webfrontBaseUrl = 'https://xenonservers.codewithstephen.com';

const server = {
  Hostname: "^8Xenon's Search & Destroy ^2[Bots]",
  Map: 'mp_terminal',
  GameType: 'sd'
};

const player = {
  CleanedName: 'Example Player',
  Guid: '381a02a8a7e839ed',
  ClientId: 560,
  ClientNumber: 7,
  Country: 'United States',
  CountryCode: 'US',
  SessionTime: 754,
  Kills: 12,
  Deaths: 4
};

const timestamp = '2026-07-21T12:00:00.000Z';

console.log('SAMPLE JOIN EMBED JSON');
console.log(JSON.stringify(plugin.buildConnectionWebhook('join', player, server, timestamp), null, 2));
console.log('\nSAMPLE LEAVE EMBED JSON');
console.log(JSON.stringify(plugin.buildConnectionWebhook('leave', player, server, timestamp), null, 2));
console.log('\nSAMPLE CHAT EMBED JSON');
console.log(JSON.stringify(plugin.buildChatWebhook(player, server, 'Hello from the IW4X server!', timestamp), null, 2));
