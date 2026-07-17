#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-discord-policy-'));
const reportLog = path.join(root, 'anti-cheat-combined.log');
const configFile = path.join(root, 'config.json');
fs.writeFileSync(reportLog, '');
fs.writeFileSync(configFile, JSON.stringify({
  webhookUrl: 'https://discord.com/api/webhooks/1/test',
  logs: [{ name: 'test', file: path.join(root, 'game.log') }],
  acLogFile: reportLog,
  reportLogFile: reportLog,
  clientMapFile: path.join(root, 'clients.json'),
  healthFile: path.join(root, 'health.json'),
  minDiscordScore: 120,
  minDiscordStrongEvents: 2,
  minDiscordEvidenceEvents: 3,
  minDiscordUniqueVictims: 2
}));
process.env.AC_DISCORD_CONFIG = configFile;

const policy = require('../anticheat-discord-watcher');

function event(overrides) {
  return Object.assign({
    guid: 'abc123',
    player: 'Suspect',
    hostname: 'Test Server',
    victim: 'Victim A',
    distance: '1376',
    angleMismatch: '12',
    visibleMs: '0',
    hasLos: false,
    addedScore: '35',
    score: '130',
    reasons: 'Aimed at this target through a wall before killing them (1000ms)'
  }, overrides || {});
}

const noisySingle = event({
  score: '200',
  addedScore: '107',
  angleMismatch: '52',
  reasons: 'Aimed at this target through a wall before killing them (300ms) | Kill happened with poor/no clear view at long range | Target was not visible before the kill | Many kills in a short window | Victim recently fired an unsuppressed weapon and radar was not blocked, confidence reduced'
});
assert.strictEqual(policy.shouldSendDiscordAlert(noisySingle, [noisySingle]), false, 'short mitigated wall pre-aim must not ping');

const repeated = [
  event({ victim: 'Victim A', reasons: 'Aimed at this target through a wall before killing them (1100ms)' }),
  event({ victim: 'Victim B', reasons: 'Held crosshair on this hidden target before killing them (1300ms within 2 degrees)' }),
  event({ victim: 'Victim B', addedScore: '28', reasons: 'Fast aim snap right before the kill (55 degrees)' })
];
assert.strictEqual(policy.shouldSendDiscordAlert(event({ victim: 'Victim B' }), repeated), true, 'repeated strong multi-victim evidence should ping');

const reportTime = new Date().toISOString();
fs.writeFileSync(reportLog, [
  '============================================================',
  `[${reportTime}] PLAYER_REPORT | Test Server`,
  'Player: Suspect | GUID: abc123 | Client: 7',
  'Server: Test Server',
  'Reporter: Admin One | GUID: reporter-1',
  'Reason: suspicious aim',
  ''
].join('\n'));

const reportSupported = [
  event({ victim: 'Victim A', reasons: 'Aimed at this target through a wall before killing them (1000ms)' }),
  event({ victim: 'Victim B', addedScore: '30', reasons: 'Fast aim snap right before the kill (55 degrees)' })
];
assert.strictEqual(policy.recentReportsForAlert(event()).count, 1, 'successful GUID-matched report should attach');
assert.strictEqual(policy.shouldSendDiscordAlert(event({ score: '125' }), reportSupported), true, 'report plus repeated meaningful telemetry should ping');
assert.strictEqual(policy.shouldSendDiscordAlert(event({ score: '200', reasons: 'Many kills in a short window' }), [event({ addedScore: '5', reasons: 'Many kills in a short window' })]), false, 'report without strong telemetry must not ping');

const exceptional = event({
  score: '145',
  addedScore: '70',
  reasons: 'ADS aim stayed tightly locked on the victim after a sudden correction (900ms lock, 40 degree correction, 1 degree final aim)'
});
assert.strictEqual(policy.shouldSendDiscordAlert(exceptional, [exceptional]), true, 'exceptional hard mechanical evidence should ping');

console.log('Discord alert policy tests passed.');
