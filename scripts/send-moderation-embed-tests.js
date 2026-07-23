#!/usr/bin/env node

const fs = require('node:fs');
const https = require('node:https');
const plugin = require('../iw4madmin/Plugins/ServerEventWebhook');

if (!process.argv.includes('--confirm-send')) {
  console.error('Refusing to send. Re-run with --confirm-send.');
  process.exit(2);
}

const configPath = process.env.IW4M_DISCORD_CONFIG;
if (!configPath) {
  console.error('Set IW4M_DISCORD_CONFIG to BetterIW4ToDiscord.json.');
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const webhookUrl = config.WebHooks && config.WebHooks.ClientPenalty;
if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
  console.error('ClientPenalty webhook is not configured.');
  process.exit(2);
}

plugin.config.webfrontBaseUrl = 'https://xenonservers.codewithstephen.com';

const server = { Hostname: "^8Xenon's Webhook Test Server" };
const player = {
  CleanedName: 'Embed Preview Player',
  Guid: 'TEST-GUID-0001',
  ClientId: 560,
  ClientNumber: 7,
  Country: 'Brazil',
  CountryCode: 'BR'
};
const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const samples = [
  plugin.buildModerationWebhook('ban', player, server, {}, '', undefined, 'Brazil 🇧🇷'),
  plugin.buildModerationWebhook('tempban', player, server, { Expires: expires }, 'Testing temporary-ban embed formatting.', undefined, 'Brazil 🇧🇷'),
  plugin.buildModerationWebhook('kick', player, server, {}, 'Testing kick embed formatting.', undefined, 'Brazil 🇧🇷')
];

function send(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const payload = JSON.stringify(body);
    const request = https.request({
      hostname: url.hostname,
      path: `${url.pathname}?wait=true`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, response => {
      let responseBody = '';
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`Discord returned HTTP ${response.statusCode}: ${responseBody}`));
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

(async () => {
  for (const sample of samples) await send(sample);
  console.log('Sent sample ban, temporary-ban, and kick embeds.');
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
