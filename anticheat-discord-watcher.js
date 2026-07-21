#!/usr/bin/env node
'use strict';

/*
  Watches IW4x game logs for CUSTOM_AC_ALERT lines written by
  _anticheat_suspicion.gsc and sends Discord @here alerts.

  This helper is intentionally outside GSC because IW4x GSC is not a reliable
  place to make HTTP webhook requests. GSC logs evidence; this process handles
  Discord delivery and rate limiting.
*/

const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');

const configPath = process.env.AC_DISCORD_CONFIG || path.join(__dirname, 'anticheat-discord-config.json');
const state = new Map();
const cooldowns = new Map();
const evidenceHistory = new Map();
const queue = [];
const MAX_FIELD_LENGTH = 1024;
const MAX_TIMELINE_EVENTS = 7;
const HISTORY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_REPORT_WINDOW_MS = 30 * 60 * 1000;

function loadConfig() {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);

  if (!config.webhookUrl || config.webhookUrl === 'DISCORD_WEBHOOK_URL_HERE') {
    throw new Error(`Discord webhook is not configured in ${configPath}`);
  }

  if (!config.webhookUrl.includes('discord.com/api/webhooks/')) {
    throw new Error(`Invalid Discord webhook URL in ${configPath}`);
  }

  if (!Array.isArray(config.logs) || config.logs.length === 0) {
    throw new Error(`No logs configured in ${configPath}`);
  }

  return {
    webhookUrl: config.webhookUrl,
    mention: config.mention || '@here',
    cooldownMs: Math.max(600000, Number(config.cooldownMs || 600000)),
    minDiscordScore: Number(config.minDiscordScore || 120),
    minDiscordStrongEvents: Number(config.minDiscordStrongEvents || 2),
    minDiscordEvidenceEvents: Number(config.minDiscordEvidenceEvents || 3),
    minDiscordUniqueVictims: Number(config.minDiscordUniqueVictims || 2),
    allowIncompleteMetricAlerts: config.allowIncompleteMetricAlerts === true,
    acLogFile: config.acLogFile || path.join(__dirname, 'logs', 'anti-cheat-combined.log'),
    reportLogFile: config.reportLogFile || config.acLogFile || path.join(__dirname, 'logs', 'anti-cheat-combined.log'),
    reportEvidenceWindowMs: Number(config.reportEvidenceWindowMs || DEFAULT_REPORT_WINDOW_MS),
    healthFile: config.healthFile || path.join(path.dirname(config.acLogFile || path.join(__dirname, 'logs', 'anti-cheat-combined.log')), 'anticheat-health.json'),
    databaseFile: config.databaseFile || '/home/mw2-cluster/base_files/data/iw4madmin/Database/Database.db',
    clientMapFile: config.clientMapFile || '/home/mw2-cluster/base_files/data/iw4madmin/Logs/iw4m-client-map.json',
    clientMapRefreshMs: Number(config.clientMapRefreshMs || 60000),
    logs: config.logs
  };
}

const config = loadConfig();
fs.mkdirSync(path.dirname(config.acLogFile), { recursive: true });
fs.mkdirSync(path.dirname(config.clientMapFile), { recursive: true });
fs.mkdirSync(path.dirname(config.healthFile), { recursive: true });

const health = {
  version: 1,
  startedAt: new Date().toISOString(),
  generatedAt: new Date().toISOString(),
  watcher: { status: 'running' },
  servers: {}
};

function serverHealth(log) {
  if (!health.servers[log.name]) {
    health.servers[log.name] = {
      name: log.name,
      file: log.file,
      consoleFile: log.consoleFile || '',
      customScript: log.customScript || '',
      serverConfig: log.serverConfig || '',
      logReadable: false,
      antiCheat: { lastSeenAt: null },
      killstreakLogger: { lastSeenAt: null }
    };
  }

  return health.servers[log.name];
}

function inspectScriptInstallation(log) {
  const target = serverHealth(log);
  const now = new Date().toISOString();
  let customSource = '';
  let consoleOutput = '';
  let serverConfig = '';

  try {
    customSource = log.customScript ? fs.readFileSync(log.customScript, 'utf8') : '';
  } catch (_) {
  }

  try {
    consoleOutput = log.consoleFile ? fs.readFileSync(log.consoleFile, 'utf8') : '';
  } catch (_) {
  }

  try {
    serverConfig = log.serverConfig ? fs.readFileSync(log.serverConfig, 'utf8') : '';
  } catch (_) {
  }

  const hostnameMatch = serverConfig.match(/^\s*(?:set|seta)\s+sv_hostname\s+"([^"]+)"/im);
  target.hostName = clean(hostnameMatch ? hostnameMatch[1] : log.hostName || log.name);

  const compileFailed = /script compile error|unknown function/i.test(consoleOutput);
  const customLoaded = /Executing 'scripts\/mp\/custom::init'/.test(consoleOutput);

  if (customLoaded && !compileFailed && (!target.lifecycle || target.lifecycle.state === 'loading')) {
    target.lifecycle = { state: 'running', changedAt: now };
  }
  const checks = [
    {
      key: 'antiCheat',
      file: log.antiCheatScript,
      hook: '_anticheat_suspicion::init',
      consoleMarker: null
    },
    {
      key: 'killstreakLogger',
      file: log.killstreakScript,
      hook: '_killstreak_logger::init',
      consoleMarker: '[KSLOG] killstreak logger loaded'
    }
  ];

  checks.forEach(check => {
    const previous = target[check.key] || {};
    const installed = !!check.file && fs.existsSync(check.file);
    const hooked = !!customSource && customSource.includes(check.hook);
    const markerSeen = !check.consoleMarker || consoleOutput.includes(check.consoleMarker);
    let stateName = 'waiting';
    let detail = 'Waiting for the current game session to load.';

    if (!installed) {
      stateName = 'missing';
      detail = `Script file is missing: ${check.file || 'path not configured'}`;
    } else if (!hooked) {
      stateName = 'hook_missing';
      detail = `custom.gsc does not call ${check.hook}.`;
    } else if (compileFailed) {
      stateName = 'failed';
      detail = 'The current IW4X console contains a script compile error.';
    } else if (customLoaded && markerSeen) {
      stateName = 'verified';
      detail = check.consoleMarker
        ? 'Script file, custom.gsc hook, and runtime load marker were verified.'
        : 'Script file and custom.gsc hook were verified in a successfully loaded custom script.';
    }

    target[check.key] = {
      ...previous,
      installed,
      hooked,
      state: stateName,
      detail,
      file: check.file || '',
      lastSeenAt: stateName === 'verified' ? now : null,
      lastVerifiedAt: stateName === 'verified' ? now : previous.lastVerifiedAt || null
    };
  });
}

function markScriptHealth(log, component, line) {
  const target = serverHealth(log);
  const parts = String(line || '').trim().split(';');
  target[component] = {
    lastSeenAt: new Date().toISOString(),
    lastActivityAt: target[component] && target[component].lastActivityAt || null,
    state: 'loaded',
    serverName: clean(parts[1] && parts[1] !== 'LOADED' ? parts[1] : log.name),
    map: clean(parts[2] || target[component] && target[component].map || ''),
    gameType: clean(parts[3] || target[component] && target[component].gameType || '')
  };
  target.lifecycle = { state: 'running', changedAt: new Date().toISOString() };
}

function markScriptActivity(log, component) {
  const target = serverHealth(log);
  const previous = target[component] || {};
  target[component] = {
    ...previous,
    lastSeenAt: previous.lastSeenAt || new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    state: previous.state || 'active'
  };
}

function writeHealthState() {
  config.logs.forEach(inspectScriptInstallation);
  health.generatedAt = new Date().toISOString();
  health.watcher = {
    status: 'running',
    startedAt: health.startedAt,
    lastHeartbeatAt: health.generatedAt
  };

  const temporary = `${config.healthFile}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(health, null, 2)}\n`, { mode: 0o640 });
    fs.renameSync(temporary, config.healthFile);
  } catch (err) {
    console.error(`[AC-WATCH] Failed to write health state: ${err.message}`);
  }
}

function refreshClientMap() {
  const script = path.join(__dirname, 'iw4m-client-map.py');
  execFile('python3', [script, config.databaseFile, config.clientMapFile], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      console.error(`[AC-WATCH] Failed to refresh IW4MAdmin client map: ${err.message}`);
      if (stderr) {
        console.error(`[AC-WATCH] client map stderr: ${stderr.trim()}`);
      }
    }
  });
}

if (require.main === module) {
  refreshClientMap();
  setInterval(refreshClientMap, Math.max(10000, config.clientMapRefreshMs));
}

function clean(value) {
  return String(value || '')
    .replace(/\^[0-9:;]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .trim();
}

function parseAcAlert(line) {
  const idx = line.indexOf('CUSTOM_AC_ALERT;');

  if (idx === -1) {
    return null;
  }

  const parts = line.slice(idx).trim().split(';');

  if (parts.length < 15 || parts[0] !== 'CUSTOM_AC_ALERT') {
    return null;
  }

  return {
    lineTime: parseLineTime(line),
    guid: clean(parts[1]),
    player: clean(parts[2]),
    clientNum: clean(parts[3]),
    victim: clean(parts[4]),
    weapon: clean(parts[5]),
    hitLoc: clean(parts[6]),
    distance: clean(parts[7]),
    angleMismatch: clean(parts[8]),
    hasLos: clean(parts[9]) === '1',
    visibleMs: clean(parts[10]),
    score: clean(parts[11]),
    reasons: clean(parts[12]),
    map: clean(parts[13]),
    hostname: clean(parts.slice(14).join(';')),
    timestamp: new Date().toISOString()
  };
}

function parseAcEvidence(line) {
  const idx = line.indexOf('CUSTOM_AC_EVIDENCE;');

  if (idx === -1) {
    return null;
  }

  const parts = line.slice(idx).trim().split(';');

  if (parts.length < 16 || parts[0] !== 'CUSTOM_AC_EVIDENCE') {
    return null;
  }

  return {
    lineTime: parseLineTime(line),
    seenAt: Date.now(),
    guid: clean(parts[1]),
    player: clean(parts[2]),
    clientNum: clean(parts[3]),
    victim: clean(parts[4]),
    weapon: clean(parts[5]),
    hitLoc: clean(parts[6]),
    distance: clean(parts[7]),
    angleMismatch: clean(parts[8]),
    hasLos: clean(parts[9]) === '1',
    visibleMs: clean(parts[10]),
    addedScore: clean(parts[11]),
    scoreAfter: clean(parts[12]),
    reasons: clean(parts[13]),
    map: clean(parts[14]),
    hostname: clean(parts.slice(15).join(';')),
    timestamp: new Date().toISOString()
  };
}

function parseAcReviewAlert(line) {
  const idx = line.indexOf('CUSTOM_AC_REVIEW;ALERT;');

  if (idx === -1) {
    return null;
  }

  const fields = {};
  const parts = line.slice(idx).trim().split(';').slice(2);

  parts.forEach(part => {
    const eq = part.indexOf('=');
    if (eq === -1) {
      return;
    }

    fields[part.slice(0, eq)] = clean(part.slice(eq + 1));
  });

  const details = fields.details || '';
  const distanceMatch = details.match(/([0-9]+)\s+units/i);
  const angleMatch = details.match(/aim angle\s+([0-9]+)\s+deg/i);
  const visibleMatch = details.match(/visible for\s+([0-9]+)ms/i);
  const hasLos = !/poor\/no clear view/i.test(details);

  return {
    lineTime: parseLineTime(line),
    guid: '',
    player: fields.player || 'Unknown',
    clientNum: fields.client || '',
    victim: fields.victim || 'Unknown',
    weapon: fields.weapon || 'Unknown',
    hitLoc: '',
    distance: distanceMatch ? distanceMatch[1] : '',
    angleMismatch: angleMatch ? angleMatch[1] : '',
    hasLos,
    visibleMs: visibleMatch ? visibleMatch[1] : '0',
    score: fields.score || '0',
    reasons: fields.summary || 'Alert threshold crossed',
    map: fields.map || 'Unknown',
    hostname: fields.server || '',
    timestamp: new Date().toISOString(),
    fromReviewAlert: true
  };
}

function appendAcOnlyLog(serverName, kind, event, rawLine) {
  const timestamp = new Date().toISOString();
  const raw = clean(rawLine);
  let summary = `[${timestamp}] [${serverName}] ${kind}\nRaw: ${raw}\n`;

  if (event) {
    const score = event.scoreAfter || event.score || '0';
    const los = event.hasLos ? 'clear' : 'poor/no clear';
    const distance = event.distance || '?';
    const angle = event.angleMismatch || '?';
    const victim = event.victim || 'Unknown';
    const weapon = prettyWeapon(event.weapon);
    const displayEvent = { ...event, score };
    const probability = probabilityLabel(displayEvent, [event]);
    const suspected = suspectedCheatType(displayEvent, [event]);
    const strongSignals = strongSignalCount(displayEvent, [event]);
    const weakSignals = weakSignalCount(displayEvent, [event]);
    const fpRisk = falsePositiveRisk(displayEvent, [event]);
    const reasons = reasonList(event.reasons);
    const reasonBlock = reasons.length
      ? reasons.map(reason => `  - ${reason}`).join('\n')
      : '  - No reason text was logged.';
    const scoreText = event.addedScore
      ? `+${event.addedScore} this event, ${score} total`
      : `${score} total`;
    const visibleText = event.visibleMs === '0'
      ? 'not recorded visible before kill'
      : `${event.visibleMs || '?'}ms`;

    summary = [
      '============================================================',
      `[${timestamp}] ${kind} | ${serverName}`,
      `Player: ${event.player || 'Unknown'} | GUID: ${event.guid || 'Unknown'} | Client: ${event.clientNum || '?'}`,
      `Server: ${event.hostname || serverName}`,
      `Map: ${event.map || 'Unknown'}`,
      `Suspicion: ${scoreText} | Probability: ${probability} | Type: ${suspected}`,
      `Evidence Quality: strong signals=${strongSignals} | weak signals=${weakSignals} | false-positive risk=${fpRisk}`,
      `Latest Target: ${victim}`,
      `Weapon: ${weapon} | Hit Location: ${event.hitLoc || 'Unknown'}`,
      `Metrics: distance=${distance} units | angle mismatch=${angle} deg | line of sight=${los} | visible time=${visibleText}`,
      'What looked suspicious:',
      reasonBlock,
      ''
    ].join('\n');
  }

  fs.appendFile(config.acLogFile, `${summary}\n`, err => {
    if (err) {
      console.error(`[AC-WATCH] Could not write AC-only log ${config.acLogFile}: ${err.message}`);
    }
  });
}

function parseLineTime(line) {
  const match = String(line || '').match(/^\s*([0-9]+:\s?[0-9]{2}(?::[0-9]{2})?)/);
  return match ? match[1].replace(/\s+/g, '') : '';
}

function cooldownKey(serverName, event) {
  return `${serverName}|${event.clientNum || event.guid || event.player}`;
}

function shouldSend(serverName, event) {
  const key = cooldownKey(serverName, event);
  const last = cooldowns.get(key) || 0;
  const now = Date.now();

  if (now - last < config.cooldownMs) {
    return false;
  }

  cooldowns.set(key, now);
  return true;
}

function prettyWeapon(weapon) {
  const value = clean(weapon);

  if (!value) {
    return 'Unknown';
  }

  return value.replace(/_mp$/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function historyKey(serverName, event) {
  return `${serverName}|${event.clientNum || event.guid || event.player}`;
}

function rememberEvidence(serverName, event) {
  const key = historyKey(serverName, event);
  const now = Date.now();
  const current = evidenceHistory.get(key) || [];
  current.push(event);

  const filtered = current
    .filter(item => now - Number(item.seenAt || now) <= HISTORY_WINDOW_MS)
    .slice(-20);

  evidenceHistory.set(key, filtered);
}

function evidenceForAlert(serverName, alert) {
  const key = historyKey(serverName, alert);
  const now = Date.now();
  let current = (evidenceHistory.get(key) || [])
    .filter(item => now - Number(item.seenAt || now) <= HISTORY_WINDOW_MS);

  if (current.length === 0) {
    current = matchingEvidence(serverName, alert, now);
  }

  if (current.length === 0) {
    return [{
      ...alert,
      seenAt: now,
      addedScore: alert.score,
      scoreAfter: alert.score
    }];
  }

  return current.slice(-MAX_TIMELINE_EVENTS);
}

function matchingEvidence(serverName, alert, now) {
  const matches = [];

  evidenceHistory.forEach((items, key) => {
    if (!key.startsWith(`${serverName}|`)) {
      return;
    }

    items.forEach(item => {
      const isRecent = now - Number(item.seenAt || now) <= HISTORY_WINDOW_MS;
      const sameClient = alert.clientNum && item.clientNum === alert.clientNum;
      const samePlayer = alert.player && item.player === alert.player;

      if (isRecent && (sameClient || samePlayer)) {
        matches.push(item);
      }
    });
  });

  return matches.slice(-MAX_TIMELINE_EVENTS);
}

function enrichEventFromEvidence(serverName, event) {
  const evidence = evidenceForAlert(serverName, event);
  const latest = evidence[evidence.length - 1];

  if (!latest) {
    return event;
  }

  return {
    ...event,
    guid: event.guid || latest.guid,
    hitLoc: event.hitLoc || latest.hitLoc,
    reasons: event.fromReviewAlert ? latest.reasons || event.reasons : event.reasons,
    distance: event.distance || latest.distance,
    angleMismatch: event.angleMismatch || latest.angleMismatch,
    visibleMs: event.visibleMs || latest.visibleMs,
    hasLos: typeof event.hasLos === 'boolean' ? event.hasLos : latest.hasLos
  };
}

function reasonList(reasonText) {
  return clean(reasonText)
    .split('|')
    .map(item => clean(item))
    .filter(Boolean);
}

function normalizedReason(reason) {
  return reason
    .replace(/\([^)]+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeReasons(alert, evidence) {
  const counts = new Map();
  const source = evidence.length ? evidence.map(item => item.reasons).join(' | ') : alert.reasons;

  reasonList(source).forEach(reason => {
    const key = normalizedReason(reason);
    const existing = counts.get(key) || { count: 0, example: reason };
    existing.count++;
    if (reason.length > existing.example.length) {
      existing.example = reason;
    }
    counts.set(key, existing);
  });

  const lines = Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map(item => `- ${item.example}${item.count > 1 ? ` (${item.count}x)` : ''}`);

  return limitField(lines.join('\n') || 'No reason text logged');
}

function buildEvidenceParagraph(alert, evidence) {
  const noLosCount = evidence.filter(item => !item.hasLos).length;
  const snapCount = evidence.filter(item => /snap|off-target|far from/i.test(item.reasons || '')).length;
  const lockCount = evidence.filter(item => /lock/i.test(item.reasons || '')).length;
  const killWindowCount = evidence.filter(item => /many kills/i.test(item.reasons || '')).length;
  const latest = evidence[evidence.length - 1] || alert;
  const totalEvents = evidence.length;
  const pieces = [];

  pieces.push(`${alert.player || 'The player'} crossed the suspicion threshold with a score of ${alert.score || '0'}.`);

  if (totalEvents > 1) {
    pieces.push(`The watcher saw ${totalEvents} recent suspicious kill event${totalEvents === 1 ? '' : 's'} for this player before the alert.`);
  }

  const signalParts = [];
  if (snapCount > 0) signalParts.push(`${snapCount} aim-angle/snap signal${snapCount === 1 ? '' : 's'}`);
  if (lockCount > 0) signalParts.push(`${lockCount} lock-on style signal${lockCount === 1 ? '' : 's'}`);
  if (noLosCount > 0) signalParts.push(`${noLosCount} poor line-of-sight trace${noLosCount === 1 ? '' : 's'}`);
  if (killWindowCount > 0) signalParts.push(`${killWindowCount} rapid-kill window signal${killWindowCount === 1 ? '' : 's'}`);

  if (signalParts.length) {
    pieces.push(`Main evidence: ${signalParts.join(', ')}.`);
  }

  pieces.push(`Latest event: killed ${latest.victim || 'unknown'} with ${prettyWeapon(latest.weapon)} at ${latest.distance || '?'} units, angle mismatch ${latest.angleMismatch || '?'} deg, line of sight ${latest.hasLos ? 'clear' : 'poor/no clear trace'}, visible for ${latest.visibleMs || '0'} ms.`);
  pieces.push('This is a review alert only; confirm in demos/logs before taking action.');

  return limitField(pieces.join(' '));
}

function buildTimeline(alert, evidence) {
  const alertSeenAt = Date.now();

  const lines = evidence.slice(-MAX_TIMELINE_EVENTS).map((item, index) => {
    const deltaMs = Math.max(0, alertSeenAt - Number(item.seenAt || alertSeenAt));
    const relative = deltaMs < 1500 ? 'now' : `T-${Math.round(deltaMs / 1000)}s`;
    const reasons = summarizeEventReasons(item.reasons);
    const lineTime = item.lineTime ? ` [${item.lineTime}]` : '';
    return `${index + 1}. ${relative}${lineTime}: ${item.victim || 'unknown'} via ${prettyWeapon(item.weapon)}, ${item.distance || '?'}u, angle ${item.angleMismatch || '?'} deg, LOS ${item.hasLos ? 'clear' : 'poor'}, +${item.addedScore || '?'} score. ${reasons}`;
  });

  return limitField(lines.join('\n') || 'No recent evidence lines were captured before this alert.');
}

function summarizeEventReasons(reasons) {
  const list = reasonList(reasons);

  if (!list.length) {
    return 'No reason text.';
  }

  return list.slice(0, 3).join('; ');
}

function limitField(value) {
  const text = String(value || '')
    .replace(/\^[0-9:;]/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
    .trim();

  if (text.length <= MAX_FIELD_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_FIELD_LENGTH - 20).trim()}... [truncated]`;
}

function plainReason(alert, evidence) {
  const events = evidence.length ? evidence : [alert];
  const noLosCount = events.filter(item => !item.hasLos).length;
  const wallPreAimCount = events.filter(item => /pre-aimed|wall|line-of-sight|visibly exposed/i.test(item.reasons || '')).length;
  const lockCount = events.filter(item => /lock|snap|far from|off-target/i.test(item.reasons || '')).length;
  const rapidCount = events.filter(item => /many kills|short window/i.test(item.reasons || '')).length;

  if (wallPreAimCount > 0 && lockCount > 0) {
    return 'The player appeared to aim at targets before they were clearly visible, then got suspicious kills through poor line-of-sight.';
  }

  if (wallPreAimCount > 0 || noLosCount >= 2) {
    return 'The player got multiple suspicious kills where the server did not see a clear line-of-sight to the target.';
  }

  if (lockCount > 0 && rapidCount > 0) {
    return 'The player had repeated fast aim/lock-on style kills in a short period.';
  }

  if (lockCount > 0) {
    return 'The player had aim movement or crosshair placement that looked unusually precise around kills.';
  }

  if (rapidCount > 0) {
    return 'The player built up suspicious kill activity in a short period.';
  }

  return 'The player crossed the suspicion score threshold from repeated suspicious kill evidence.';
}

function combinedReasonText(event, evidence) {
  return [event.reasons, ...evidence.map(item => item.reasons || '')].join(' | ');
}

function signalSummary(event, evidence) {
  const text = combinedReasonText(event, evidence);
  const events = evidence.length ? evidence : [event];
  const noLosCount = events.filter(item => !item.hasLos).length;
  const strongWall = /pre-aim|hidden target|moved directly toward|target was not visible|not visible before|no clear view was recorded/i.test(text);

  return {
    wall: strongWall,
    noisyLos: /line-of-sight|poor\/no|no clear view|visibly exposed/i.test(text) || noLosCount >= 2,
    aim: /aim was far away|aim snap|snap|off-target|lock|precise aim|bad aim angle|angle mismatch/i.test(text),
    recoil: /no recoil|recoil/i.test(text),
    rapid: /many kills|short window|rapid/i.test(text)
  };
}

function strongSignalCount(event, evidence) {
  const text = combinedReasonText(event, evidence);
  let count = 0;

  [
    /aimed at this target through a wall/i,
    /moved directly toward a hidden target/i,
    /target was not visible before the kill/i,
    /very large aim snap/i,
    /ADS aim snapped from off-target/i,
    /ADS aim stayed tightly locked/i,
    /ADS was locked almost perfectly/i,
    /repeated ADS kills on bots with near-perfect aim/i,
    /repeated ADS snap-lock kills on bots/i,
    /ADS snap-lock pattern on a bot/i,
    /killed bots repeatedly with very precise aim/i,
    /repeated sniper snap-kill pattern/i,
    /repeated quickscope sniper kills/i,
    /sniper head\/neck hit rate is unusually high/i,
    /killed the target less than 120ms/i
  ].forEach(pattern => {
    if (pattern.test(text)) {
      count++;
    }
  });

  return count;
}

function weakSignalCount(event, evidence) {
  const text = combinedReasonText(event, evidence);
  let count = 0;

  [
    /long-range kill had poor line-of-sight/i,
    /poor\/no clear view/i,
    /many kills in a short window/i,
    /aim was far away/i,
    /killed a bot with very precise aim/i,
    /killed a bot while ADS was locked/i,
    /ADS was almost perfectly lined up on a bot/i,
    /ADS snapped onto a bot with near-perfect aim/i,
    /ADS snap-lock pattern on a bot/i,
    /very high short-window accuracy/i,
    /many quickscope sniper kills/i,
    /clear long visibility could explain some sniper kills/i
  ].forEach(pattern => {
    if (pattern.test(text)) {
      count++;
    }
  });

  return count;
}

function falsePositiveRisk(event, evidence) {
  const score = Number(event.score || event.scoreAfter || 0);
  const strong = strongSignalCount(event, evidence);
  const signals = signalSummary(event, evidence);

  if (strong >= 2 || score >= 150) {
    return 'Low';
  }

  if (strong === 1 && signals.wall) {
    return 'Medium';
  }

  if (signals.noisyLos && !signals.wall) {
    return 'High';
  }

  return 'Medium';
}

function shouldSendDiscordAlert(event, evidence) {
  const score = Number(event.score || 0);
  const hasMetrics = hasCompleteReviewMetrics(event, evidence);
  const quality = discordEvidenceQuality(event, evidence);
  const reports = recentReportsForAlert(event);

  if (score < config.minDiscordScore) {
    return false;
  }

  if (!hasMetrics && !config.allowIncompleteMetricAlerts) {
    return false;
  }

  // A single exceptional mechanical detection may page staff, but ordinary
  // wall/LOS wording never qualifies by itself regardless of cumulative score.
  if (quality.falsePositiveRisk === 'High') {
    return false;
  }

  if (quality.exceptionalHardEvents >= 2 && quality.uniqueVictims >= 2 && score >= 150) {
    return true;
  }

  // Normal telemetry requires independent strong kills against distinct
  // victims. Multiple reason phrases from one kill do not count as repetition.
  if (quality.mechanicalEvents >= 3 &&
      quality.strongEvents >= Math.max(3, config.minDiscordStrongEvents) &&
      quality.evidenceEvents >= Math.max(4, config.minDiscordEvidenceEvents) &&
      quality.uniqueVictims >= Math.max(3, config.minDiscordUniqueVictims) &&
      score >= 150) {
    return true;
  }

  // A successful IW4MAdmin report corroborates telemetry, but a report alone
  // is never enough. There must still be strong and repeated game evidence.
  if (reports.count >= 1 && quality.mechanicalEvents >= 2 &&
      quality.strongEvents >= 2 && quality.meaningfulEvents >= 3 &&
      quality.uniqueVictims >= 2 && score >= 130) {
    return true;
  }

  if (reports.uniqueReporters >= 2 && quality.mechanicalEvents >= 1 &&
      quality.meaningfulEvents >= 3 && quality.uniqueVictims >= 2 && score >= 120) {
    return true;
  }

  // A larger telemetry-only pattern can qualify even if individual events are
  // not exceptional, provided it spans several victims and is not noisy LOS.
  if (score >= 170 && quality.mechanicalEvents >= 3 &&
      quality.meaningfulEvents >= 5 && quality.uniqueVictims >= 3) {
    return true;
  }

  return false;
}

function discordEvidenceQuality(event, evidence) {
  const events = evidence && evidence.length ? evidence : [event];
  const uniqueVictims = new Set();
  let strongEvents = 0;
  let exceptionalHardEvents = 0;
  let mechanicalEvents = 0;
  let meaningfulEvents = 0;

  events.forEach(item => {
    const victim = clean(item.victim).toLowerCase();
    if (victim && victim !== 'unknown' && victim !== '?') {
      uniqueVictims.add(victim);
    }

    if (isExceptionalHardEvent(item)) {
      exceptionalHardEvents++;
      mechanicalEvents++;
      strongEvents++;
      meaningfulEvents++;
      return;
    }

    if (isIndependentStrongEvent(item)) {
      if (isMechanicalAimEvent(item)) {
        mechanicalEvents++;
      }
      strongEvents++;
      meaningfulEvents++;
      return;
    }

    if (isMeaningfulReviewEvent(item)) {
      meaningfulEvents++;
    }
  });

  return {
    evidenceEvents: events.length,
    strongEvents,
    exceptionalHardEvents,
    mechanicalEvents,
    meaningfulEvents,
    uniqueVictims: uniqueVictims.size,
    falsePositiveRisk: exceptionalHardEvents >= 1 || (strongEvents >= 2 && uniqueVictims.size >= 2)
      ? 'Low'
      : (strongEvents >= 1 && meaningfulEvents >= 2 ? 'Medium' : 'High')
  };
}

function isMechanicalAimEvent(event) {
  const text = String(event.reasons || '');
  const reduced = /confidence reduced|could explain|recently fired an unsuppressed|single long-range sniper/i.test(text);
  if (reduced) {
    return false;
  }

  return /ADS aim stayed tightly locked|ADS aim snapped from off-target|repeated ADS snap-lock|very large aim snap|fast aim snap|repeated sniper snap-kill|killed the target less than 120ms|no recoil|recoil anomaly/i.test(text);
}

function isExceptionalHardEvent(event) {
  const text = String(event.reasons || '');
  const addedScore = Number(event.addedScore || 0);
  const hardPattern = /ADS aim stayed tightly locked|ADS aim snapped from off-target|repeated ADS snap-lock|no recoil|recoil anomaly/i.test(text);
  const reduced = /confidence reduced|could explain|single long-range sniper/i.test(text);
  return hardPattern && addedScore >= 55 && !reduced;
}

function isIndependentStrongEvent(event) {
  const text = String(event.reasons || '');
  const addedScore = Number(event.addedScore || 0);
  const reduced = /confidence reduced|could explain|recently fired an unsuppressed|single long-range sniper/i.test(text);

  if (reduced) {
    return false;
  }

  if (isMechanicalAimEvent(event) && addedScore >= 35) {
    return true;
  }

  if (/very large aim snap|repeated sniper snap-kill|sniper head\/neck hit rate is unusually high|killed the target less than 120ms/i.test(text)) {
    return true;
  }

  const hiddenDuration = longestReasonDuration(text, /through a wall|hidden target|held crosshair|moved directly toward/i);
  return hiddenDuration >= 800;
}

function isMeaningfulReviewEvent(event) {
  const text = String(event.reasons || '');
  const addedScore = Number(event.addedScore || 0);
  const onlyNoisyContext = /poor\/no clear|many kills|short-window accuracy/i.test(text) &&
    !/snap|lock|through a wall|hidden target|held crosshair|moved directly toward/i.test(text);

  if (onlyNoisyContext || /confidence reduced|could explain/i.test(text)) {
    return false;
  }

  return addedScore >= 25 && hasCompleteReviewMetrics(event, [event]);
}

function longestReasonDuration(text, contextPattern) {
  let longest = 0;
  reasonList(text).forEach(reason => {
    if (!contextPattern.test(reason)) {
      return;
    }

    const matches = reason.match(/([0-9]+)ms/ig) || [];
    matches.forEach(match => {
      longest = Math.max(longest, Number(match.replace(/ms/i, '')) || 0);
    });
  });
  return longest;
}

function recentReportsForAlert(event) {
  const empty = { count: 0, uniqueReporters: 0, reports: [] };
  const file = config.reportLogFile;

  if (!file) {
    return empty;
  }

  try {
    const stats = fs.statSync(file);
    const maxBytes = 2 * 1024 * 1024;
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);

    const now = Date.now();
    const reports = buffer.toString('utf8').split(/={20,}/).map(parsePlayerReportBlock).filter(report => {
      if (!report || now - report.timestamp > config.reportEvidenceWindowMs) {
        return false;
      }

      return reportMatchesAlert(report, event);
    });
    const reporters = new Set(reports.map(report => report.reporterGuid || report.reporterName.toLowerCase()).filter(Boolean));
    return { count: reports.length, uniqueReporters: reporters.size, reports };
  } catch (_) {
    return empty;
  }
}

function parsePlayerReportBlock(block) {
  if (!/PLAYER_REPORT/.test(block)) {
    return null;
  }

  const header = block.match(/^\s*\[([^\]]+)\]\s+PLAYER_REPORT/im);
  const player = block.match(/^Player:\s*(.*?)\s*\|\s*GUID:\s*(.*?)\s*\|\s*Client:/im);
  const server = block.match(/^Server:\s*(.*)$/im);
  const reporter = block.match(/^Reporter:\s*(.*?)\s*\|\s*GUID:\s*(.*)$/im);
  const timestamp = header ? Date.parse(header[1]) : NaN;

  if (!player || !Number.isFinite(timestamp)) {
    return null;
  }

  return {
    timestamp,
    playerName: clean(player[1]),
    playerGuid: clean(player[2]),
    serverName: clean(server ? server[1] : ''),
    reporterName: clean(reporter ? reporter[1] : ''),
    reporterGuid: clean(reporter ? reporter[2] : '')
  };
}

function reportMatchesAlert(report, event) {
  const eventGuid = clean(event.guid).toLowerCase();
  const reportGuid = clean(report.playerGuid).toLowerCase();
  const guidKnown = value => value && value !== 'unknown' && value !== '?';

  if (guidKnown(eventGuid) && guidKnown(reportGuid)) {
    return eventGuid === reportGuid;
  }

  const samePlayer = clean(report.playerName).toLowerCase() === clean(event.player).toLowerCase();
  const eventServer = clean(event.hostname).toLowerCase();
  const reportServer = clean(report.serverName).toLowerCase();
  return samePlayer && (!eventServer || !reportServer || eventServer === reportServer);
}

function hasCompleteReviewMetrics(event, evidence) {
  const events = evidence && evidence.length ? evidence : [event];

  return events.some(item => {
    const distance = Number(item.distance || 0);
    const angle = Number(item.angleMismatch || 0);
    const visible = Number(item.visibleMs || 0);
    const hasDistance = Number.isFinite(distance) && distance > 0;
    const hasAngle = Number.isFinite(angle) && angle >= 0;
    const hasVisible = Number.isFinite(visible) && visible >= 0 && String(item.visibleMs || '') !== '';

    return hasDistance && hasAngle && hasVisible;
  });
}

function probabilityLabel(event, evidence) {
  const score = Number(event.score || 0);
  const text = combinedReasonText(event, evidence);
  const signals = signalSummary(event, evidence);
  let level = 0;

  if (score >= 150) {
    level = 3;
  } else if (score >= 100) {
    level = 2;
  } else if (score >= 75) {
    level = 1;
  }

  if (signals.wall && signals.aim && level < 3) {
    level++;
  }

  if (signals.recoil && level < 3) {
    level++;
  }

  if (/ADS aim stayed tightly locked|ADS was locked almost perfectly|repeated ADS kills on bots with near-perfect aim/i.test(text) && level < 3) {
    level++;
  }

  return ['Low', 'Medium', 'High', 'Very High'][level];
}

function probabilityColor(probability) {
  switch (probability) {
    case 'Low':
      return 0xffd21f;
    case 'Medium':
      return 0xff8c1a;
    case 'High':
      return 0xfc0f03;
    case 'Very High':
      return 0x8b0000;
    default:
      return 0x808080;
  }
}

function allowedMentionsFor(content) {
  const text = String(content || '');
  const users = [];
  const userRegex = /<@!?([0-9]+)>/g;
  let match;

  while ((match = userRegex.exec(text)) !== null) {
    users.push(match[1]);
  }

  if (users.length) {
    return { users };
  }

  if (text.includes('@here') || text.includes('@everyone')) {
    return { parse: ['everyone'] };
  }

  return { parse: [] };
}

function suspectedCheatType(event, evidence) {
  const text = combinedReasonText(event, evidence);
  const signals = signalSummary(event, evidence);

  if (signals.recoil) {
    return 'No Recoil';
  }

  if (signals.wall && signals.aim) {
    return 'ESP / Wallhack + Aim Assist';
  }

  if (signals.wall) {
    return 'ESP / Wallhack';
  }

  if (signals.noisyLos && signals.aim) {
    return 'Suspicious Aim / Poor Visibility';
  }

  if (/ADS aim stayed tightly locked|ADS was locked almost perfectly|killed a bot while ADS was locked|ADS was almost perfectly lined up on a bot|ADS snapped onto a bot with near-perfect aim|ADS snap-lock pattern on a bot|repeated ADS kills on bots with near-perfect aim|repeated ADS snap-lock kills on bots/i.test(text)) {
    return 'Aim Lock / Aim Assist';
  }
  if (/sniper snap-kill pattern|quickscope sniper kills|sniper head\/neck hit rate/i.test(text)) {
    return 'Sniper Aim Abnormality';
  }

  if (/aim was far away|off-target|angle mismatch/i.test(text)) {
    return 'Silent Aim';
  }

  if (/snap|lock|precise aim/i.test(text)) {
    return 'Aim Lock / Aim Assist';
  }

  if (signals.rapid) {
    return 'Unusual Kill Pattern';
  }

  return 'Unknown / Needs Review';
}

function shortRecentActivity(evidence) {
  const events = evidence.slice(-3);

  if (!events.length) {
    return 'No recent event summary available.';
  }

  return events.map(item => {
    const los = item.hasLos ? 'clear view' : 'poor/no clear view';
    return `${item.victim || 'unknown'} with ${prettyWeapon(item.weapon)} (${los})`;
  }).join('\n');
}

function buildPayload(serverName, event) {
  const evidence = evidenceForAlert(serverName, event);
  const linkedReports = recentReportsForAlert(event);
  const reason = plainReason(event, evidence);
  const recentActivity = shortRecentActivity(evidence);
  const latestLos = event.hasLos ? 'clear view' : 'poor/no clear view';
  const probability = probabilityLabel(event, evidence);
  const cheatType = suspectedCheatType(event, evidence);
  const strongSignals = strongSignalCount(event, evidence);
  const weakSignals = weakSignalCount(event, evidence);
  const fpRisk = falsePositiveRisk(event, evidence);

  const fields = [
    { name: 'Suspect', value: event.player || 'Unknown', inline: true },
    { name: 'GUID / Client', value: `${event.guid || 'Unknown'} / ${event.clientNum || '?'}`, inline: true },
    { name: 'Probability', value: probability, inline: true },
    { name: 'Suspected Cheat', value: cheatType, inline: true },
    { name: 'Score', value: event.score || '0', inline: true },
    { name: 'False Positive Risk', value: fpRisk, inline: true },
    { name: 'Signals', value: `Strong: ${strongSignals} | Weak: ${weakSignals}`, inline: true },
    { name: 'Map', value: event.map || 'Unknown', inline: true },
    { name: 'Reason', value: reason, inline: false },
    { name: 'Latest Kill', value: `${event.victim || 'Unknown'} with ${prettyWeapon(event.weapon)} at ${event.distance || '?'} units (${latestLos})`, inline: false },
    { name: 'Recent Activity', value: recentActivity, inline: false },
    { name: 'Server', value: event.hostname || serverName, inline: false }
  ];

  if (linkedReports.count > 0) {
    fields.splice(fields.length - 1, 0, {
      name: 'Linked Player Reports',
      value: `${linkedReports.count} successful IW4MAdmin report${linkedReports.count === 1 ? '' : 's'} from ${linkedReports.uniqueReporters} unique reporter${linkedReports.uniqueReporters === 1 ? '' : 's'}`,
      inline: false
    });
  }

  return {
    username: 'IW4x Anti-Cheat',
    content: config.mention,
    allowed_mentions: allowedMentionsFor(config.mention),
    embeds: [{
      title: 'Possible Cheater Alert',
      description: 'This is only a warning. Please spectate or review before taking action.',
      color: probabilityColor(probability),
      fields,
      timestamp: event.timestamp
    }]
  };
}

function enqueue(payload) {
  queue.push(payload);
}

function sendNow(payload) {
  const body = JSON.stringify(payload);
  const url = new URL(config.webhookUrl);

  const req = https.request({
    method: 'POST',
    hostname: url.hostname,
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, res => {
    let responseBody = '';

    res.on('data', chunk => {
      responseBody += chunk;
    });

    res.on('end', () => {
      if (res.statusCode === 429) {
        let retryMs = 5000;

        try {
          const parsed = JSON.parse(responseBody);
          if (parsed.retry_after) {
            retryMs = Math.ceil(Number(parsed.retry_after) * 1000);
          }
        } catch (_) {
        }

        console.error(`[AC-WATCH] Discord rate limited, retrying in ${retryMs}ms`);
        setTimeout(() => queue.unshift(payload), retryMs);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const detail = responseBody ? `: ${responseBody.slice(0, 500)}` : '';
        console.error(`[AC-WATCH] Discord returned HTTP ${res.statusCode}${detail}`);
      }
    });
  });

  req.on('error', err => {
    console.error(`[AC-WATCH] Discord request failed: ${err.message}`);
  });

  req.write(body);
  req.end();
}

if (require.main === module) {
  setInterval(() => {
    if (queue.length === 0) {
      return;
    }

    sendNow(queue.shift());
  }, 1200);
}

function processLine(log, line) {
  if (line.includes('InitGame')) {
    const target = serverHealth(log);
    target.antiCheat = { lastSeenAt: null, lastActivityAt: null, state: 'waiting' };
    target.killstreakLogger = { lastSeenAt: null, lastActivityAt: null, state: 'waiting' };
    target.lifecycle = { state: 'loading', changedAt: new Date().toISOString() };
  }

  if (line.includes('ShutdownGame')) {
    serverHealth(log).lifecycle = { state: 'stopped', changedAt: new Date().toISOString() };
  }

  if (line.includes('CUSTOM_AC_STATUS;') || line.includes('CUSTOM_AC_HEALTH;')) {
    const marker = line.includes('CUSTOM_AC_STATUS;') ? 'CUSTOM_AC_STATUS;' : 'CUSTOM_AC_HEALTH;';
    markScriptHealth(log, 'antiCheat', line.slice(line.indexOf(marker)));
    return;
  }

  if (line.includes('CUSTOM_KILLSTREAK_STATUS;') || line.includes('CUSTOM_KILLSTREAK_HEALTH;')) {
    const marker = line.includes('CUSTOM_KILLSTREAK_STATUS;') ? 'CUSTOM_KILLSTREAK_STATUS;' : 'CUSTOM_KILLSTREAK_HEALTH;';
    markScriptHealth(log, 'killstreakLogger', line.slice(line.indexOf(marker)));
    return;
  }

  if (line.includes('CUSTOM_AC_')) {
    markScriptActivity(log, 'antiCheat');
  }

  if (line.includes('CUSTOM_KILLSTREAK_')) {
    markScriptActivity(log, 'killstreakLogger');
  }

  const parsedEvidence = parseAcEvidence(line);

  if (parsedEvidence) {
    rememberEvidence(log.name, parsedEvidence);
    appendAcOnlyLog(log.name, 'EVIDENCE', parsedEvidence, line);
    return;
  }

  const alert = parseAcAlert(line);
  const reviewAlert = !alert ? parseAcReviewAlert(line) : null;
  let event = alert || reviewAlert;

  if (!event) {
    if (line.includes('CUSTOM_AC_')) {
      appendAcOnlyLog(log.name, 'RAW', null, line);
    }
    return;
  }

  event = enrichEventFromEvidence(log.name, event);
  appendAcOnlyLog(log.name, alert ? 'ALERT' : 'REVIEW_ALERT', event, line);

  const evidence = evidenceForAlert(log.name, event);

  if (!shouldSendDiscordAlert(event, evidence)) {
    const quality = discordEvidenceQuality(event, evidence);
    const reports = recentReportsForAlert(event);
    appendAcOnlyLog(log.name, 'DISCORD_SUPPRESSED', {
      ...event,
      reasons: `Discord alert suppressed: score crossed threshold without enough independent corroboration. Mechanical events=${quality.mechanicalEvents}, strong events=${quality.strongEvents}, meaningful events=${quality.meaningfulEvents}, unique victims=${quality.uniqueVictims}, linked reports=${reports.count}, false-positive risk=${quality.falsePositiveRisk}`
    }, line);
    return;
  }

  if (!shouldSend(log.name, event)) {
    return;
  }

  console.log(`[AC-WATCH] ${log.name}: ${event.player} crossed suspicion threshold (${event.score})`);
  enqueue(buildPayload(log.name, event));
}

function readNew(log) {
  fs.stat(log.file, (err, stats) => {
    const targetHealth = serverHealth(log);
    targetHealth.lastLogCheckAt = new Date().toISOString();

    if (err) {
      targetHealth.logReadable = false;
      targetHealth.logError = err.message;
      console.error(`[AC-WATCH] Cannot stat ${log.file}: ${err.message}`);
      return;
    }

    targetHealth.logReadable = true;
    targetHealth.logError = '';
    targetHealth.lastLogModifiedAt = stats.mtime.toISOString();

    const current = state.get(log.file) || { position: stats.size };

    if (stats.size < current.position) {
      current.position = 0;
    }

    if (stats.size === current.position) {
      state.set(log.file, current);
      return;
    }

    const stream = fs.createReadStream(log.file, {
      start: current.position,
      end: stats.size - 1,
      encoding: 'utf8'
    });

    let buffer = '';

    stream.on('data', chunk => {
      buffer += chunk;
    });

    stream.on('end', () => {
      current.position = stats.size;
      state.set(log.file, current);
      buffer.split(/\r?\n/).forEach(line => processLine(log, line));
    });

    stream.on('error', streamErr => {
      console.error(`[AC-WATCH] Cannot read ${log.file}: ${streamErr.message}`);
    });
  });
}

if (require.main === module) {
  config.logs.forEach(log => {
    if (!log.name || !log.file) {
      return;
    }

    try {
      const stats = fs.statSync(log.file);
      const targetHealth = serverHealth(log);
      targetHealth.logReadable = true;
      targetHealth.lastLogCheckAt = new Date().toISOString();
      targetHealth.lastLogModifiedAt = stats.mtime.toISOString();
      state.set(log.file, { position: stats.size });
      console.log(`[AC-WATCH] Watching ${log.name}: ${log.file}`);
    } catch (err) {
      const targetHealth = serverHealth(log);
      targetHealth.logReadable = false;
      targetHealth.logError = err.message;
      targetHealth.lastLogCheckAt = new Date().toISOString();
      state.set(log.file, { position: 0 });
      console.error(`[AC-WATCH] ${log.file} is not readable yet: ${err.message}`);
    }
  });

  setInterval(() => {
    config.logs.forEach(readNew);
  }, 1000);

  writeHealthState();
  setInterval(writeHealthState, 15000);
}

module.exports = {
  discordEvidenceQuality,
  parsePlayerReportBlock,
  recentReportsForAlert,
  reportMatchesAlert,
  shouldSendDiscordAlert
};
