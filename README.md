# IW4X / IW4MAdmin Anti-Cheat Review System

This is a **server-side suspicion and review system** for IW4X / Modern Warfare 2 dedicated servers.

It does **not** automatically ban players. It records suspicious evidence, sends review alerts, and adds an IW4MAdmin web dashboard so staff can decide what needs attention.

## What It Detects

The GSC script tracks patterns such as:

- Aim snaps shortly before a kill
- ADS lock-like aim behavior
- Hidden crosshair tracking before a kill
- Aiming at a target through poor/no line of sight
- Moving directly toward hidden targets
- Fast kills immediately after visibility
- Repeated suspicious events across one player
- Supporting context such as UAV, Counter-UAV, EMP, heartbeat sensor, Ninja, and unsuppressed weapon radar pings

This system treats ESP/wallhack signals as **suspicion**, not proof.

Radar context is handled carefully:

- A team UAV can reduce ESP-style suspicion while it is active.
- If the UAV is destroyed, the stock game script decrements `level.activeUAVs`, so the reduction stops.
- Counter-UAV or EMP blocks the UAV/radar explanation.
- Unsuppressed victim weapon fire can reduce suspicion only when the attacker's radar is not blocked.
- Heartbeat sensor only explains hidden-target reads if the victim does **not** have Ninja (`specialty_heartbreaker`).
- A single long-range sniper hidden-target read is reduced because common lanes,
  wallbangs, and normal pre-aiming can look suspicious server-side. Repeated
  sniper patterns still matter.

## Files

```text
maps/mp/gametypes/_anticheat_suspicion.gsc
maps/mp/gametypes/_killstreak_logger.gsc
anticheat-discord-watcher.js
anticheat-discord-config.example.json
iw4m-client-map.py
iw4madmin/Plugins/AnticheatMetrics.js
iw4madmin/Plugins/anticheat_iw4m_flag_worker.py
systemd/anticheat-iw4m-flag-worker.service
```

Python is only used by optional helper scripts:

- `iw4m-client-map.py` generates GUID/profile lookup data for links and victim resolution.
- `anticheat_iw4m_flag_worker.py` is only for optional IW4MAdmin Watch flag writes.

The core GSC anti-cheat and the IW4MAdmin dashboard plugin do not require Python.

## Install GSC Scripts

Copy these files into the server's `userraw/maps/mp/gametypes/` folder:

```text
_anticheat_suspicion.gsc
_killstreak_logger.gsc
```

Then call them from `userraw/scripts/mp/custom.gsc`:

```c
init()
{
    level thread maps\mp\gametypes\_anticheat_suspicion::init();
    level thread maps\mp\gametypes\_killstreak_logger::init();
}
```

If `custom.gsc` already exists, add only those two `level thread` lines inside its existing `init()`.

## Server Config Dvars

Add these to `server.cfg`:

```cfg
set ac_suspicion_enabled "1"
set ac_suspicion_threshold "75"
set ac_suspicion_alert_cooldown_ms "90000"
set ac_suspicion_include_bots "0"
set ac_suspicion_debug "0"
set ac_suspicion_admin_ids ""
```

For testing with bots, temporarily use:

```cfg
set ac_suspicion_include_bots "1"
```

Restart the server or rotate the map after changing GSC files.

Important: after replacing the GSC files, restart the IW4X game servers. After
replacing `AnticheatMetrics.js`, restart IW4MAdmin. If the old watcher or old
plugin stays running, Discord may still show noisy alerts from the previous
version.

## Discord Watcher

The GSC script writes `CUSTOM_AC_*` lines into the game logs. The Node helper watches the log and sends Discord alerts.

1. Copy:

```text
anticheat-discord-watcher.js
anticheat-discord-config.example.json
iw4m-client-map.py
```

2. Rename the config:

```bash
cp anticheat-discord-config.example.json anticheat-discord-config.json
```

3. Edit the webhook URL in `anticheat-discord-config.json`.

Recommended Discord noise controls:

```json
"minDiscordScore": 100,
"minDiscordStrongSignals": 1,
"minDiscordEvidenceEvents": 2,
"allowIncompleteMetricAlerts": false
```

This keeps weak/incomplete review lines in the local anti-cheat log without
pinging Discord. Alerts with missing distance/angle/visibility metrics should
not page staff unless you explicitly set `allowIncompleteMetricAlerts` to
`true`.

4. Start it:

```bash
node anticheat-discord-watcher.js
```

Use a systemd service or process manager if you want it always running.

Keep `iw4m-client-map.py` in the same folder as
`anticheat-discord-watcher.js`. The watcher uses it to generate
`iw4m-client-map.json`, which lets the dashboard resolve GUIDs/profile links
and make victim names clickable when they uniquely match an IW4MAdmin client.

This should run as a background service/process. It should not require an active
SSH shell after setup.

## IW4MAdmin Dashboard

Copy this plugin into IW4MAdmin's `Plugins` folder:

```text
iw4madmin/Plugins/AnticheatMetrics.js
```

Restart IW4MAdmin after copying it.

The dashboard reads:

```text
Logs/anti-cheat-combined.log
```

It groups events into player cases and separates:

- Risk: how suspicious the behavior looks
- Confidence: how reliable the evidence is
- Reports: successful IW4MAdmin `!report` commands linked to the reported player
- Actions: Watch/Undo Watch, Clear, Purge/Recover, Send Review

Purging starts a five-day recovery window. Purged cases remain available under
the `Purged` filter with a `Recover` action until permanent cleanup is due; the
evidence is not immediately destroyed.

The dashboard is a review queue, not a raw event dump. Weak evidence stays in
the combined anti-cheat log so it can build a pattern later, but it does not
appear in the panel by itself. Uncertain but meaningful evidence can appear as
`Watching`; stronger repeated/corroborated evidence becomes `Needs Review`.

Visible dashboard cases generally require at least one of:

- IW4MAdmin hard anti-cheat detection
- player report support
- moderation/action history
- Discord review eligibility
- risk `>= 60` and confidence `>= 45`
- repeated suspicious telemetry with medium confidence across multiple events,
  victims, or signal types

This is intentional. It keeps the panel from filling with low-confidence trace
quirks, lucky wallbangs, normal pre-aims, and other weak signals.

Buffered patterns do not become review cases from repeated reason text alone.
They need structured gameplay context (such as distance, angle, line of sight,
visibility time, or hit location), multiple independent targets, or report
support. Aggregated patterns receive their repetition bonus once; case scoring
does not add the same source events a second time. Patterns with incomplete
structured telemetry are capped below normal review confidence and remain in
the evidence log for future correlation instead of filling the queue.

The IW4MAdmin plugin listens for `ClientPenaltyAdministered` events whose
penalty type is `Report`. IW4MAdmin emits this canonical event after
`!report <player> <reason>` succeeds, with the reported player as the offender,
the reporting player as the punisher, and the accepted report reason as the
offense. The plugin writes that data as a normalized `PLAYER_REPORT` event in
`Logs/anti-cheat-combined.log`. Failed or invalid report attempts do not create
penalty events and therefore do not become anti-cheat evidence. Identical
target/reporter/reason events are deduplicated for 30 seconds.

Legacy report records whose GUID is `Unknown` are merged into a matching
resolved-GUID case when player/server/client or profile aliases identify one
unambiguous player. If an alias could refer to multiple GUIDs, it is left
separate rather than risking an incorrect merge.
Server aliases are color-code insensitive, allowing a report recorded under a
plain IW4MAdmin hostname to join telemetry recorded under the colored hostname.

If duplicate cases appear where one says `GUID Unknown` and another has a real
GUID, restart IW4MAdmin and make sure the client map helper/watcher is running.
The plugin will merge fallback player/server/client cases into the real GUID
case once the GUID is known.

Fields like `CapturedViewAngles`, `CurrentStrain`, `RecoilOffset`, and
`SessionAverageSnapValue` are IW4MAdmin Stats anti-cheat snapshot fields. They
will show `Not recorded` unless IW4MAdmin's own Stats anti-cheat is enabled and
writing AC snapshots. The custom GSC review system still works without those
fields, but those hard IW4MAdmin metrics will not appear.

The visible case row and Discord review embed show the GUID only. IW4MAdmin
already exposes client/profile details when you click the player profile link.

## Optional IW4MAdmin Watch Flag Worker

The Watch button can mark the player locally and attempt to flag them in IW4MAdmin.

Copy:

```text
iw4madmin/Plugins/anticheat_iw4m_flag_worker.py
systemd/anticheat-iw4m-flag-worker.service
```

You must edit paths in the service/script if your IW4MAdmin data folder is different.

Install example:

```bash
sudo cp systemd/anticheat-iw4m-flag-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now anticheat-iw4m-flag-worker
```

If the worker is not installed, Watch still works locally, but IW4MAdmin flagging may not be available.

## Automatic Updates

Stable updates are distributed through GitHub Releases. The updater checks the
latest release every two hours through a `systemd` timer, verifies the release
SHA-256 checksum, backs up every replaced file, and uses atomic file
replacement. It does not require an active SSH session.

The default example configuration automatically applies updater, dashboard,
and helper updates. GSC updates are left pending by default because activating
them needs an IW4X map rotation or server restart and may disconnect players.

### Install the updater

From a downloaded release or repository checkout:

```bash
sudo ./updater/install-updater.sh
sudo nano /etc/iw4x-anticheat-updater.json
```

Set every `destination` to the corresponding file on the host. Add one pair of
GSC destinations for each IW4X server. Configure restart commands as JSON
argument arrays, without shell syntax. Examples:

```json
"restartCommands": {
  "dashboard": [["docker", "restart", "iw4madmin"]],
  "helpers": [["systemctl", "restart", "anticheat-discord-watcher"]],
  "gsc": [["systemctl", "restart", "iw4x-server"]]
}
```

Test the configuration before enabling automatic checks:

```bash
sudo /opt/iw4x-anticheat-updater/anticheat-updater.py --check
sudo systemctl enable --now iw4x-anticheat-updater.timer
systemctl list-timers iw4x-anticheat-updater.timer
```

Useful commands:

```bash
# Install components enabled under autoApply
sudo systemctl start iw4x-anticheat-updater.service

# Install every component, including staged GSC updates
sudo /opt/iw4x-anticheat-updater/anticheat-updater.py --apply-all

# Restore the most recent pre-update backup
sudo /opt/iw4x-anticheat-updater/anticheat-updater.py --rollback

# Inspect the last updater run
journalctl -u iw4x-anticheat-updater.service -n 100 --no-pager
```

Local webhook configuration, databases, logs, and server configuration are not
release targets and are never overwritten. For a private GitHub repository,
provide a read-only `GITHUB_TOKEN` through a systemd environment file. A token
is not needed while the repository is public.

### Publish an update

Update `VERSION`, commit the tested files, and push a matching version tag:

```bash
version="$(tr -d '[:space:]' < VERSION)"
git tag "v${version}"
git push origin main "v${version}"
```

The GitHub Actions release workflow builds
`iw4x-anticheat-release.zip`, generates its checksum, and publishes both files
to the matching GitHub Release. Installed updaters then discover it on their
next scheduled check.

## System Status diagnostics

The bottom of the IW4MAdmin **Anticheat** page shows operational status for the
dashboard plugin, Discord/log watcher, evidence storage, client profile map,
and each configured server's anti-cheat and killstreak GSC scripts.
The System Status header and Dashboard Plugin check display the version loaded
by IW4MAdmin, which may differ from GitHub's latest release until an update is
installed and IW4MAdmin restarts.

The existing Node watcher verifies each configured GSC file, its `custom.gsc`
hook, the current IW4X console state, and later gameplay activity. It writes the result to
`Logs/anticheat-health.json` every 15 seconds. No webhook URL or other secret is
written to that file. A green check means the script is installed and its hook
was present in a successfully loaded `custom.gsc`; the killstreak logger also
has an explicit runtime load marker. Compile failures and missing hooks are
reported separately.

After installing this update, rotate/restart each IW4X server so the updated GSC
scripts load, then restart `anticheat-discord-watcher` and IW4MAdmin. Configure
the `consoleFile`, `serverConfig`, `customScript`, `antiCheatScript`, and `killstreakScript`
paths for every server in `anticheat-discord-config.json`.

## Testing

For bot testing:

1. Set `ac_suspicion_include_bots "1"`.
2. Restart or reload the map.
3. Join the server.
4. Use suspicious behavior intentionally:
   - Hold crosshair on a hidden bot for about 1 second
   - Kill that same bot shortly afterward
   - Repeat several times
5. Check Discord, the anti-cheat log, and the IW4MAdmin Anti-cheat page.

Useful reasons to look for:

```text
Held crosshair on this hidden target before killing them
Repeatedly held crosshair on hidden targets before killing them
Aimed at this target through a wall before killing them
ADS aim stayed tightly locked on the victim after a sudden correction
Victim had Ninja, so heartbeat sensor did not explain the hidden-target push
Single long-range sniper hidden-target read; confidence reduced until repeated
```

## Interpreting Evidence

Do not act on one event by itself unless it is very high confidence.

Good review rule:

```text
High risk + medium/high confidence + repeated events = worth staff review.
High risk + low confidence = watch only.
Reports only = not proof.
One poor line-of-sight event = supporting evidence, not proof.
```

Example:

```text
RiskScore: 74
ConfidenceScore: 35
FalsePositiveRisk: High
Probability: Low
Reports: 0
```

That is **not a ban-worthy record by itself**. It means the event looked suspicious, but the system thinks the reliability is weak. Use it as a reason to keep watching for repeated patterns.

## Notes

- IW4MAdmin native anti-cheat snapshot fields are displayed in raw/debug details if present.
- If the IW4MAdmin database has no `EFACSnapshot` rows, fields like `CapturedViewAngles`, `CurrentStrain`, `RecoilOffset`, and `SessionAverageSnapValue` will show as `Not recorded`.
- This system should support human review, not replace it.
