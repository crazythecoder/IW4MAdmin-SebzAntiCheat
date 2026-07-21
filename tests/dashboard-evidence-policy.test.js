#!/usr/bin/env node
'use strict';

const assert = require('assert');
const plugin = require('../iw4madmin/Plugins/AnticheatMetrics');

function event(overrides) {
    return Object.assign({
        caseId: 'guid:test-player',
        eventId: `evt-${Math.random()}`,
        playerName: 'Test Player',
        playerGuid: 'test-player',
        eventType: 'esp_suspicion',
        riskScore: 72,
        confidenceScore: 52,
        falsePositiveRisk: 'Medium',
        distance: '1400',
        angle: '32',
        lineOfSight: 'poor/no clear',
        visibleTime: '0ms',
        hitLocation: 'torso_upper',
        victimName: 'Victim A',
        timestamp: new Date().toISOString(),
        rawReasons: ['Held crosshair on this hidden target before killing them']
    }, overrides || {});
}

const weakLos = event({ riskScore: 90, confidenceScore: 70, angle: '8', rawReasons: ['Poor/no clear line-of-sight kill'] });
assert.strictEqual(plugin.isMeaningfulTimelineEvent(weakLos), false,
    'isolated LOS evidence must remain buffered even with a high raw score');

const structuredAim = event({
    eventType: 'aim_suspicion',
    riskScore: 82,
    confidenceScore: 72,
    rawReasons: ['ADS aim stayed tightly locked after a sudden correction']
});
assert.strictEqual(plugin.isMeaningfulTimelineEvent(structuredAim), true,
    'strong structured aim telemetry may be retained immediately');

const sameVictim = [0, 1, 2].map(index => event({
    eventId: `same-${index}`,
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
    victimName: 'Victim A',
    rawReasons: ['Held crosshair on this hidden target before killing them', 'Fast aim snap right before the kill']
}));
assert.strictEqual(plugin.aggregateCandidateWindow('guid:test-player', sameVictim, []), null,
    'repetition against one victim must not count as independent corroboration');

const multipleVictims = sameVictim.map((item, index) => Object.assign({}, item, {
    victimName: index === 0 ? 'Victim A' : 'Victim B'
}));
assert.ok(plugin.aggregateCandidateWindow('guid:test-player', multipleVictims, []),
    'structured repeated evidence across multiple victims may form a reviewable pattern');

const skilledRustPattern = [
    ['Victim A', 'Kill-time aim angle looked unusual (121 degrees) | Aimed at this target through a wall before killing them (900ms) | Many kills in a short window'],
    ['Victim B', 'Held crosshair on this hidden target before killing them (2000ms within 1 degrees) | Kill happened with poor/no clear view at long range'],
    ['Victim C', 'Fast aim snap right before the kill (61 degrees) | Long-range kill had poor line-of-sight and bad aim angle'],
    ['Victim D', 'Target was not visible before the kill | Many kills in a short window']
].map((entry, index) => event({
    eventId: `rust-${index}`,
    victimName: entry[0],
    rawScore: `${130 + index * 30} total`,
    riskScore: 100,
    confidenceScore: 56,
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
    rawReasons: entry[1].split(' | ')
}));
const rustAggregate = plugin.aggregateCandidateWindow('guid:test-player', skilledRustPattern, []);
assert.ok(rustAggregate, 'repeated multi-victim visibility telemetry may remain available as a monitoring pattern');
assert.ok(rustAggregate.riskScore <= 79 && rustAggregate.confidenceScore <= 54,
    'one custom snap mixed with LOS events must not become high-priority evidence');
assert.strictEqual(rustAggregate.falsePositiveRisk, 'High');
assert.strictEqual(rustAggregate.uniqueVictims, 4,
    'an aggregated pattern must preserve its source victim count for case classification');
assert.strictEqual(plugin.caseStatus({
    overallRisk: 100,
    confidence: 65,
    uniqueVictims: 4,
    eventsCount: 9,
    falsePositiveRisk: 'Medium',
    events: skilledRustPattern,
    latest: skilledRustPattern[skilledRustPattern.length - 1]
}), 'Monitoring', 'skilled multi-victim LOS telemetry without repeated mechanical aim must remain monitoring');

const metricCard = plugin.statCard('High Priority', 3, 'Strong signals.', 'red', 'high-priority');
assert.ok(metricCard.includes('data-ac-stat-filter="high-priority"'),
    'summary metrics must expose their queue filter');
assert.ok(metricCard.includes('type="button"'), 'summary metrics must be keyboard-accessible buttons');

const cumulativeEvent = plugin.scoreEvent(event({
    rawScore: '216 total',
    riskScore: undefined,
    confidenceScore: undefined,
    rawReasons: ['Kill happened with poor/no clear view', 'Many kills in a short window']
}));
assert.ok(cumulativeEvent.riskScore < 100,
    'a cumulative GSC score must not force one ordinary event to 100 risk');

assert.strictEqual(plugin.isNativeAnticheatDetectionReason('Snap-8.42@31'), true);
assert.strictEqual(plugin.isNativeAnticheatDetectionReason('Recoil-0@18'), true);
assert.strictEqual(plugin.isNativeAnticheatDetectionReason('Marked as "Watch" by Admin 12 @ now via Anticheat Panel.'), false,
    'panel Watch flags must not be re-imported as native detections');
assert.strictEqual(plugin.isHardDetection(event({ eventType: 'recoil_suspicion', rawReasons: ['Possible recoil anomaly'] })), false,
    'custom recoil wording alone must not be upgraded to a native hard detection');
assert.strictEqual(plugin.isHardDetection(event({ kind: 'IW4M_FLAG', rawReasons: ['Snap-8.42@31'] })), true,
    'an imported native IW4MAdmin flag must be treated as a hard detection');

console.log('Dashboard evidence policy tests passed.');
