# IW4X Anti-Cheat Review System

Server-side suspicion telemetry and an IW4MAdmin review dashboard for IW4X.
It groups repeated evidence, links successful `!report` events, and can send
high-quality cases to Discord. It does **not** automatically ban players.

## Included

- GSC aim, visibility, radar-context, and repeated-pattern telemetry
- IW4MAdmin review queue with risk and confidence scored separately
- Native IW4MAdmin Snap, Strain, Recoil, Bone, Button, and Offset evidence
- Watch, Clear, Purge/Recover, and Discord review workflows
- Optional IW4MAdmin Watch flag worker
- Performance-aware sampling for populated servers
- Signed release updater with backups, validation, health checks, and rollback

## Install

1. Copy these files to every IW4X server:

```text
maps/mp/gametypes/_anticheat_suspicion.gsc
maps/mp/gametypes/_killstreak_logger.gsc
```

2. Add both hooks to the existing `userraw/scripts/mp/custom.gsc` `init()`:

```c
level thread maps\mp\gametypes\_anticheat_suspicion::init();
level thread maps\mp\gametypes\_killstreak_logger::init();
```

3. Add the recommended server DVARs:

```cfg
set ac_suspicion_enabled "1"
set ac_suspicion_threshold "75"
set ac_suspicion_alert_cooldown_ms "90000"
set ac_suspicion_include_bots "0"
set ac_suspicion_debug "0"
set ac_suspicion_visibility_sample_ms "200"
set ac_suspicion_aim_sample_ms "100"
```

4. Copy `iw4madmin/Plugins/AnticheatMetrics.js` into IW4MAdmin's `Plugins`
folder.

5. Configure `anticheat-discord-config.json` from the included example, then
run `anticheat-discord-watcher.js` as a service. The watcher writes normalized
evidence and health data used by the dashboard.

6. Restart each IW4X server and IW4MAdmin. Confirm the **Anti-cheat > System
Status** section reports the dashboard, watcher, storage, and server scripts as
healthy.

Keep `ac_suspicion_include_bots "0"` in production. Enable it only for deliberate
bot testing.

## Optional Watch Integration

`iw4madmin/Plugins/anticheat_iw4m_flag_worker.py` lets the dashboard Watch action
also flag the player in IW4MAdmin. Install the included systemd unit after
adjusting its paths:

```bash
sudo cp systemd/anticheat-iw4m-flag-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now anticheat-iw4m-flag-worker
```

Without this worker, Watch still updates the local case.

## Automatic Updates

Releases include a SHA-256 checksum. The updater verifies it, backs up replaced
files, validates the installation, and can roll back failed updates.

```bash
sudo ./updater/install-updater.sh
sudo nano /etc/iw4x-anticheat-updater.json
sudo /opt/iw4x-anticheat-updater/anticheat-updater.py --check
sudo systemctl enable --now iw4x-anticheat-updater.timer
```

Replace every `/path/to/...` value before enabling the timer. Dashboard and
helper updates may be automatic. GSC updates default to staged because applying
them requires a map rotation or IW4X restart. Updater activity appears in the
dashboard System Status update log when `dashboardHistoryFile` is configured.

Useful commands:

```bash
sudo /opt/iw4x-anticheat-updater/anticheat-updater.py --apply-all
sudo /opt/iw4x-anticheat-updater/anticheat-updater.py --rollback
journalctl -u iw4x-anticheat-updater.service -n 100 --no-pager
```

## Validation

Run the included checks before deployment:

```bash
node --test tests/*.test.js
python3 -m unittest updater/test_updater.py
node --check iw4madmin/Plugins/AnticheatMetrics.js
node --check anticheat-discord-watcher.js
```

After deployment, verify:

- both GSC scripts load without compile errors;
- `Logs/anti-cheat-combined.log` receives meaningful telemetry;
- successful IW4MAdmin `!report` events attach to the reported player's case;
- weak or incomplete events stay buffered instead of filling the review queue;
- Discord only pages staff for repeated, corroborated, or hard evidence.

## Evidence Safety

Risk describes how suspicious behavior looks. Confidence describes evidence
reliability. One poor line-of-sight event, one report, or a high-risk event with
low confidence is not proof. Review repeated events, unique victims, native
IW4MAdmin detections, reports, weapon context, and false-positive risk together.

Native snapshot fields such as `CapturedViewAngles`, `CurrentStrain`, and
`RecoilOffset` show `Not recorded` unless IW4MAdmin Stats anti-cheat produced a
snapshot. The custom telemetry still works without those fields.

This project is an admin review aid. Automatic permanent bans are intentionally
not enabled.
