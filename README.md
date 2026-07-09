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
- Supporting context such as UAV, Counter-UAV, EMP, heartbeat sensor, and unsuppressed weapon radar pings

This system treats ESP/wallhack signals as **suspicion**, not proof.

## Files

```text
maps/mp/gametypes/_anticheat_suspicion.gsc
maps/mp/gametypes/_killstreak_logger.gsc
anticheat-discord-watcher.js
anticheat-discord-config.example.json
iw4madmin/Plugins/AnticheatMetrics.js
iw4madmin/Plugins/anticheat_iw4m_flag_worker.py
systemd/anticheat-iw4m-flag-worker.service
```

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

## Discord Watcher

The GSC script writes `CUSTOM_AC_*` lines into the game logs. The Node helper watches the log and sends Discord alerts.

1. Copy:

```text
anticheat-discord-watcher.js
anticheat-discord-config.example.json
```

2. Rename the config:

```bash
cp anticheat-discord-config.example.json anticheat-discord-config.json
```

3. Edit the webhook URL in `anticheat-discord-config.json`.

4. Start it:

```bash
node anticheat-discord-watcher.js
```

Use a systemd service or process manager if you want it always running.

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
- Reports: linked reports if report events are present in the anti-cheat log
- Actions: Watch, Clear, Send Review

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
