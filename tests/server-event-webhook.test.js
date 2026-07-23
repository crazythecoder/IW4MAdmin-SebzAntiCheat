const test = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../iw4madmin/Plugins/ServerEventWebhook');

plugin.config.webfrontBaseUrl = 'https://example.test';

test('plugin does not override IW4MAdmin reserved path metadata', () => {
  assert.equal(plugin.path, undefined);
});

test('country codes render with a flag and full country name', () => {
  assert.equal(plugin.countryFromCode('US'), 'United States 🇺🇸');
  assert.equal(plugin.countryFromCode('GB'), 'United Kingdom 🇬🇧');
});

const server = { Hostname: '^2Test Server', Map: 'mp_terminal', GameType: 'war' };
const player = {
  CleanedName: 'Player', Guid: 'abc123', ClientId: 42, ClientNumber: 3,
  Country: 'United States', CountryCode: 'US', SessionTime: 125, Kills: 6, Deaths: 2
};

test('join embed uses readable labels, profile link, footer, and compact fields', () => {
  const embed = plugin.buildConnectionWebhook('join', player, server, '2026-07-21T12:00:00.000Z').embeds[0];
  assert.equal(embed.title, 'Player Joined');
  assert.equal(embed.color, 0x2ecc71);
  assert.match(embed.description, /https:\/\/example\.test\/client\/42/);
  assert.match(embed.description, /Test Server/);
  assert.equal(embed.footer.text, "Xenon’s IW4X Servers");
  assert.equal(embed.timestamp, '2026-07-21T12:00:00.000Z');
  assert.deepEqual(embed.fields.map(field => field.name), ['Client ID', 'Country']);
  assert.equal(embed.fields.find(field => field.name === 'Client ID').value, '42');
  assert.match(embed.fields.find(field => field.name === 'Country').value, /United States/);
  assert.doesNotMatch(embed.description, /\\\(|\\\)/);
});

test('client ID uses the persistent IW4MAdmin profile ID, not a reused game slot', () => {
  const first = plugin.buildConnectionWebhook('join', {
    CleanedName: 'First', ClientId: 1001, ClientNumber: 10
  }, server).embeds[0];
  const second = plugin.buildConnectionWebhook('join', {
    CleanedName: 'Second', ClientId: 1002, ClientNumber: 10
  }, server).embeds[0];
  assert.equal(first.fields.find(field => field.name === 'Client ID').value, '1001');
  assert.equal(second.fields.find(field => field.name === 'Client ID').value, '1002');
});

test('leave embed includes available session and combat fields', () => {
  const embed = plugin.buildConnectionWebhook('leave', player, server).embeds[0];
  assert.equal(embed.title, 'Player Left');
  assert.equal(embed.color, 0xe74c3c);
  assert.equal(embed.fields.find(field => field.name === 'Session Time').value, '2m 5s');
  assert.equal(embed.fields.find(field => field.name === 'Kills / Deaths / KD').value, '6 / 2 / 3.00');
});

test('missing optional data is omitted instead of rendered as broken values', () => {
  const embed = plugin.buildConnectionWebhook('leave', { CleanedName: 'Player' }, { Hostname: 'Server' }).embeds[0];
  const json = JSON.stringify(embed);
  assert.deepEqual(embed.fields.map(field => field.name), ['Country']);
  assert.equal(embed.fields[0].value, '🌐 Unknown');
  assert.doesNotMatch(json, /undefined|null|N\/A/);
});

test('permanent ban embed follows the compact moderation format', () => {
  const embed = plugin.buildModerationWebhook('ban', player, server, {}, '', '2026-07-21T12:00:00.000Z').embeds[0];
  assert.equal(embed.title, 'Player Banned');
  assert.equal(embed.color, 0xfc4343);
  assert.match(embed.description, /permanently banned/);
  assert.deepEqual(embed.fields.map(field => field.name), ['Client ID', 'Country', 'Server', 'GUID']);
  assert.equal(embed.footer, undefined);
});

test('temporary ban embed includes Discord duration and expiration timestamps', () => {
  const penalty = { Expires: '2026-07-21T15:00:00.000Z' };
  const embed = plugin.buildModerationWebhook('tempban', player, server, penalty, '', '2026-07-21T12:00:00.000Z').embeds[0];
  assert.equal(embed.title, 'Player Temp Banned');
  assert.equal(embed.color, 0xff6c4d);
  assert.equal(embed.fields.find(field => field.name === 'Duration').value, '3 hours');
  assert.equal(embed.fields.find(field => field.name === 'Expires').value, '<t:1784646000:F>');
  assert.equal(embed.fields.find(field => field.name === 'Reason').value, 'No reason provided.');
});

test('temporary-ban durations use readable words instead of abbreviations', () => {
  assert.equal(plugin.formatLongDuration(4 * 7 * 86400), '4 weeks');
  assert.equal(plugin.formatLongDuration(86400), '1 day');
  assert.equal(plugin.formatLongDuration(6 * 3600), '6 hours');
  assert.equal(plugin.formatLongDuration(90 * 60), '1 hour 30 minutes');
});

test('kick embed includes a fallback reason without extra sections', () => {
  const embed = plugin.buildModerationWebhook('kick', player, server, {}, '', '2026-07-21T12:00:00.000Z').embeds[0];
  assert.equal(embed.title, 'Player Kicked');
  assert.equal(embed.color, 0xffc94d);
  assert.deepEqual(embed.fields.map(field => field.name), ['Client ID', 'Country', 'Server', 'Reason', 'GUID']);
  assert.equal(embed.fields.find(field => field.name === 'Reason').value, 'No reason provided.');
});

test('moderation client hydration restores exact GUID and name from profile map', () => {
  const previousSystem = global.System;
  global.System = { IO: { File: {
    Exists: () => true,
    ReadAllText: () => JSON.stringify({ clients: {
      '1ef7b42946dd9f1e': { clientId: 1420, name: 'Koiz2' }
    } })
  } } };
  try {
    const hydrated = plugin.hydrateClient({ ClientId: 1420, NetworkId: 2231450229760958200, Name: 'Unknown' });
    assert.equal(plugin.playerName(hydrated), 'Koiz2');
    assert.equal(plugin.guid(hydrated), '1ef7b42946dd9f1e');
    assert.equal(plugin.profileId(hydrated), '1420');
  } finally {
    global.System = previousSystem;
  }
});

test('server resolution prefers the penalty event owner', () => {
  const resolved = plugin.server({ CurrentServer: null }, { Owner: server });
  assert.equal(plugin.serverName(resolved), 'Test Server');
});

test('kick deduplication can use a longer action-specific window', () => {
  plugin.recent = {};
  assert.equal(plugin.isDuplicate('kick:test', 60), undefined);
  assert.equal(plugin.isDuplicate('kick:test', 60), true);
});

test('chat embed is compact and uses the clickable profile format', () => {
  const embed = plugin.buildChatWebhook(player, server, 'hello `server`', '2026-07-21T12:00:00.000Z').embeds[0];
  assert.equal(embed.title, 'Chat Logs');
  assert.equal(embed.color, 0xfafafa);
  assert.equal(embed.description, "**[Player (abc123)](https://example.test/client/42)** chatted:\n`hello 'server'`");
  assert.deepEqual(embed.fields, [{ name: 'Server', value: 'Test Server', inline: false }]);
  assert.equal(embed.timestamp, '2026-07-21T12:00:00.000Z');
  assert.equal(embed.footer, undefined);
});

test('player labels preserve underscores and negative identifiers without visible escapes', () => {
  const special = { CleanedName: 'xx_krico_xx', Guid: '-6466071627243186000', ClientId: 77 };
  const description = plugin.buildChatWebhook(special, server, 'hello').embeds[0].description;
  assert.match(description, /xx_krico_xx \(-6466071627243186000\)/);
  assert.doesNotMatch(description, /\\[_-]/);
});
