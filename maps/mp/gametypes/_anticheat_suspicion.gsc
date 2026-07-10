/*
    IW4x server-side anti-cheat suspicion logger.

    This does not ban, kick, or punish players. It only scores suspicious
    evidence and writes CUSTOM_AC_* lines to the game log. The companion
    Node.js helper reads those lines and sends Discord alerts.

    Install:
      Copy to: userraw/maps/mp/gametypes/_anticheat_suspicion.gsc
      Start from userraw/scripts/mp/custom.gsc:
        level thread maps\mp\gametypes\_anticheat_suspicion::init();

    Config dvars:
      set ac_suspicion_enabled "1"
      set ac_suspicion_threshold "75"
      set ac_suspicion_alert_cooldown_ms "90000"
      set ac_suspicion_admin_ids "GUID1,GUID2"

    Admin debug:
      Authorized admins can type !wh to toggle review markers. This is for
      private anti-cheat review only. Do not add normal players to the admin
      list. The tool auto-disables when the admin enters active gameplay.
*/

init()
{
    if (isDefined(level.acs_initialized) && level.acs_initialized)
        return;

    level.acs_initialized = true;
    level.acs_debug = getDvarInt("ac_suspicion_debug");
    level.acs_enabled = getDvarInt("ac_suspicion_enabled");
    level.acs_include_bots = getDvarInt("ac_suspicion_include_bots");

    if (!level.acs_enabled)
    {
        acs_debug("disabled by ac_suspicion_enabled");
        return;
    }

    level.acs_threshold = acs_getDvarIntDefault("ac_suspicion_threshold", 75);
    level.acs_alert_cooldown_ms = acs_getDvarIntDefault("ac_suspicion_alert_cooldown_ms", 90000);
    level.acs_decay_interval_ms = 15000;
    level.acs_decay_amount = 5;
    level.acs_visibility_sample_seconds = 0.10;
    level.acs_snap_sample_seconds = 0.05;

    acs_debug("loaded threshold=" + level.acs_threshold);

    level thread acs_hookPlayerKilledCallback();
    level thread acs_onPlayerConnect();
}

acs_onPlayerConnect()
{
    for (;;)
    {
        level waittill("connected", player);
        player acs_setupPlayer();
    }
}

acs_setupPlayer()
{
    if (isDefined(self.acs_ready) && self.acs_ready)
        return;

    self.acs_ready = true;
    self.acs_score = 0;
    self.acs_strong_score = 0;
    self.acs_weak_score = 0;
    self.acs_strong_events = 0;
    self.acs_weak_events = 0;
    self.acs_reasons = "";
    self.acs_recent_kills = 0;
    self.acs_recent_headshots = 0;
    self.acs_recent_lockon_kills = 0;
    self.acs_recent_ads_precise_bot_kills = 0;
    self.acs_recent_ads_snaplock_kills = 0;
    self.acs_recent_sniper_kills = 0;
    self.acs_recent_sniper_headshots = 0;
    self.acs_recent_sniper_snap_kills = 0;
    self.acs_recent_sniper_quickscope_kills = 0;
    self.acs_recent_sniper_suspicious_events = 0;
    self.acs_recent_shots = 0;
    self.acs_recent_hits = 0;
    self.acs_last_alert_time = 0;
    self.acs_last_decay_time = getTime();
    self.acs_last_weapon_fire_time = 0;
    self.acs_last_unsuppressed_fire_time = 0;
    self.acs_last_ads_start_time = 0;
    self.acs_last_visible_time = 0;
    self.acs_first_visible_time = 0;
    self.acs_wh_enabled = false;
    self.acs_last_yaw = 0;
    self.acs_last_pitch = 0;
    self.acs_last_snap_time = 0;
    self.acs_last_snap_delta = 0;
    self.acs_was_ads = false;
    self.acs_last_ads_lock_time = 0;
    self.acs_last_ads_lock_delta = 0;
    self.acs_last_ads_lock_target = -1;
    self.acs_ads_lock_samples = 0;
    self.acs_ads_lock_target = -1;
    self.acs_ads_lock_since = 0;
    self.acs_ads_lock_last_correction_time = 0;
    self.acs_ads_lock_last_correction = 0;
    self.acs_last_scripted_lock_time = 0;
    self.acs_last_scripted_lock_target = -1;
    self.acs_last_scripted_lock_duration = 0;
    self.acs_last_scripted_lock_correction = 0;
    self.acs_last_scripted_lock_mismatch = 181;
    self.acs_last_no_los_preaim_time = 0;
    self.acs_last_no_los_preaim_target = -1;
    self.acs_last_no_los_preaim_duration = 0;
    self.acs_last_no_los_preaim_mismatch = 181;
    self.acs_last_no_los_preaim_distance = 0;
    self.acs_last_hidden_crosshair_time = 0;
    self.acs_last_hidden_crosshair_target = -1;
    self.acs_last_hidden_crosshair_duration = 0;
    self.acs_last_hidden_crosshair_mismatch = 181;
    self.acs_last_hidden_crosshair_distance = 0;
    self.acs_recent_hidden_crosshair_kills = 0;
    self.acs_last_hidden_pursuit_time = 0;
    self.acs_last_hidden_pursuit_target = -1;
    self.acs_last_hidden_pursuit_duration = 0;
    self.acs_last_hidden_pursuit_mismatch = 181;
    self.acs_last_hidden_pursuit_distance = 0;

    self thread acs_watchShots();
    self thread acs_watchAimSnaps();
    self thread acs_watchSayCommands();
    self thread acs_watchVisibility();
    self thread acs_decayScore();
}

acs_hookPlayerKilledCallback()
{
    level waittill("prematch_over");
    wait 0.20;

    if (isDefined(level.acs_callback_hooked) && level.acs_callback_hooked)
        return;

    if (!isDefined(level.callbackplayerkilled))
    {
        acs_debug("callbackplayerkilled was not defined");
        return;
    }

    level.acs_prev_callback_player_killed = level.callbackplayerkilled;
    level.callbackplayerkilled = ::acs_onPlayerKilled;
    level.acs_callback_hooked = true;
    acs_debug("hooked player killed callback");
}

acs_onPlayerKilled(eInflictor, eAttacker, iDamage, sMeansOfDeath, sWeapon, vDir, sHitLoc, timeOffset, deathAnimDuration)
{
    if (isDefined(level.acs_prev_callback_player_killed))
        self [[ level.acs_prev_callback_player_killed ]](eInflictor, eAttacker, iDamage, sMeansOfDeath, sWeapon, vDir, sHitLoc, timeOffset, deathAnimDuration);

    if (!isDefined(eAttacker) || eAttacker == self || !isPlayer(eAttacker))
        return;

    eAttacker acs_setupPlayer();
    self acs_setupPlayer();
    eAttacker acs_processKill(self, sWeapon, sMeansOfDeath, sHitLoc);
}

acs_watchShots()
{
    self endon("disconnect");

    for (;;)
    {
        self waittill("weapon_fired");
        self.acs_recent_shots++;
        self.acs_last_weapon_fire_time = getTime();

        currentWeapon = self getCurrentWeapon();

        if (isDefined(currentWeapon) && !acs_weaponHasSuppressor(currentWeapon))
            self.acs_last_unsuppressed_fire_time = getTime();

        if (self.acs_recent_shots > 80)
        {
            self.acs_recent_shots = self.acs_recent_shots / 2;
            self.acs_recent_hits = self.acs_recent_hits / 2;
        }
    }
}

acs_watchVisibility()
{
    self endon("disconnect");

    for (;;)
    {
        players = level.players;
        now = getTime();

        for (i = 0; i < players.size; i++)
        {
            target = players[i];

            if (!isDefined(target) || target == self || !isPlayer(target))
                continue;

            if (!isAlive(self) || !isAlive(target))
                continue;

            hasTrace = self acs_hasClearTraceTo(target);
            key = "acs_visible_" + target getEntityNumber();

            if (hasTrace)
            {
                if (!isDefined(self.acs_visible_since))
                    self.acs_visible_since = [];

                if (!isDefined(self.acs_visible_since[key]))
                    self.acs_visible_since[key] = now;

                if (isDefined(self.acs_no_los_preaim_since))
                    self.acs_no_los_preaim_since[key] = undefined;

                self acs_clearHiddenCrosshair(key);
                self acs_clearHiddenPursuit(key);
            }
            else
            {
                if (isDefined(self.acs_visible_since))
                    self.acs_visible_since[key] = undefined;

                self acs_trackNoLosPreaim(target, key, now);
                self acs_trackHiddenCrosshair(target, key, now);
                self acs_trackHiddenPursuit(target, key, now);
            }
        }

        wait level.acs_visibility_sample_seconds;
    }
}

acs_clearHiddenPursuit(key)
{
    if (isDefined(self.acs_hidden_pursuit_since))
        self.acs_hidden_pursuit_since[key] = undefined;

    if (isDefined(self.acs_hidden_pursuit_prev_dist))
        self.acs_hidden_pursuit_prev_dist[key] = undefined;

    if (isDefined(self.acs_hidden_pursuit_prev_origin))
        self.acs_hidden_pursuit_prev_origin[key] = undefined;
}

acs_clearHiddenCrosshair(key)
{
    if (isDefined(self.acs_hidden_crosshair_since))
        self.acs_hidden_crosshair_since[key] = undefined;

    if (isDefined(self.acs_hidden_crosshair_last_mismatch))
        self.acs_hidden_crosshair_last_mismatch[key] = undefined;
}

acs_trackHiddenCrosshair(target, key, now)
{
    if (!self acs_isEnemyTarget(target))
        return;

    if (self acs_isUsingHeartbeatSensor())
    {
        self acs_clearHiddenCrosshair(key);
        return;
    }

    dist = int(distance(self.origin, target.origin));

    if (dist < 300 || dist > 5500)
    {
        self acs_clearHiddenCrosshair(key);
        return;
    }

    mismatch = self acs_yawMismatchTo(target);

    // This is the non-ADS ESP-style signal: holding the crosshair very close
    // to a hidden enemy before the kill. It is only scored later if the same
    // hidden target is killed shortly afterward.
    if (mismatch > 9)
    {
        self acs_clearHiddenCrosshair(key);
        return;
    }

    if (!isDefined(self.acs_hidden_crosshair_since))
        self.acs_hidden_crosshair_since = [];

    if (!isDefined(self.acs_hidden_crosshair_last_mismatch))
        self.acs_hidden_crosshair_last_mismatch = [];

    if (!isDefined(self.acs_hidden_crosshair_since[key]))
        self.acs_hidden_crosshair_since[key] = now;

    self.acs_hidden_crosshair_last_mismatch[key] = mismatch;
    duration = now - self.acs_hidden_crosshair_since[key];

    if (duration >= 650)
    {
        self.acs_last_hidden_crosshair_time = now;
        self.acs_last_hidden_crosshair_target = target getEntityNumber();
        self.acs_last_hidden_crosshair_duration = duration;
        self.acs_last_hidden_crosshair_mismatch = mismatch;
        self.acs_last_hidden_crosshair_distance = dist;
    }
}

acs_trackHiddenPursuit(target, key, now)
{
    if (!self acs_isEnemyTarget(target))
        return;

    if (self acs_isUsingHeartbeatSensor())
    {
        self acs_clearHiddenPursuit(key);
        return;
    }

    dist = int(distance(self.origin, target.origin));

    if (dist < 350 || dist > 6000)
    {
        self acs_clearHiddenPursuit(key);
        return;
    }

    mismatch = self acs_yawMismatchTo(target);

    if (mismatch > 35)
    {
        self acs_clearHiddenPursuit(key);
        return;
    }

    if (!isDefined(self.acs_hidden_pursuit_since))
        self.acs_hidden_pursuit_since = [];

    if (!isDefined(self.acs_hidden_pursuit_prev_dist))
        self.acs_hidden_pursuit_prev_dist = [];

    if (!isDefined(self.acs_hidden_pursuit_prev_origin))
        self.acs_hidden_pursuit_prev_origin = [];

    if (!isDefined(self.acs_hidden_pursuit_prev_dist[key]) || !isDefined(self.acs_hidden_pursuit_prev_origin[key]))
    {
        self.acs_hidden_pursuit_prev_dist[key] = dist;
        self.acs_hidden_pursuit_prev_origin[key] = self.origin;
        return;
    }

    moved = int(distance(self.origin, self.acs_hidden_pursuit_prev_origin[key]));
    approached = self.acs_hidden_pursuit_prev_dist[key] - dist;

    self.acs_hidden_pursuit_prev_dist[key] = dist;
    self.acs_hidden_pursuit_prev_origin[key] = self.origin;

    if (moved < 6 || approached < 6)
    {
        self.acs_hidden_pursuit_since[key] = undefined;
        return;
    }

    if (!isDefined(self.acs_hidden_pursuit_since[key]))
        self.acs_hidden_pursuit_since[key] = now;

    duration = now - self.acs_hidden_pursuit_since[key];

    if (duration >= 800)
    {
        self.acs_last_hidden_pursuit_time = now;
        self.acs_last_hidden_pursuit_target = target getEntityNumber();
        self.acs_last_hidden_pursuit_duration = duration;
        self.acs_last_hidden_pursuit_mismatch = mismatch;
        self.acs_last_hidden_pursuit_distance = dist;
    }
}

acs_trackNoLosPreaim(target, key, now)
{
    if (!self AdsButtonPressed())
    {
        if (isDefined(self.acs_no_los_preaim_since))
            self.acs_no_los_preaim_since[key] = undefined;

        return;
    }

    if (!self acs_isEnemyTarget(target))
        return;

    dist = int(distance(self.origin, target.origin));

    if (dist < 220 || dist > 7000)
        return;

    mismatch = self acs_yawMismatchTo(target);

    if (mismatch > 12)
    {
        if (isDefined(self.acs_no_los_preaim_since))
            self.acs_no_los_preaim_since[key] = undefined;

        return;
    }

    if (!isDefined(self.acs_no_los_preaim_since))
        self.acs_no_los_preaim_since = [];

    if (!isDefined(self.acs_no_los_preaim_since[key]))
        self.acs_no_los_preaim_since[key] = now;

    duration = now - self.acs_no_los_preaim_since[key];

    if (duration >= 250)
    {
        self.acs_last_no_los_preaim_time = now;
        self.acs_last_no_los_preaim_target = target getEntityNumber();
        self.acs_last_no_los_preaim_duration = duration;
        self.acs_last_no_los_preaim_mismatch = mismatch;
        self.acs_last_no_los_preaim_distance = dist;
    }
}

acs_watchAimSnaps()
{
    self endon("disconnect");

    angles = self getPlayerAngles();
    self.acs_last_pitch = angles[0];
    self.acs_last_yaw = angles[1];

    for (;;)
    {
        wait level.acs_snap_sample_seconds;

        if (!isAlive(self))
            continue;

        angles = self getPlayerAngles();
        yawDelta = acs_angleDelta(angles[1], self.acs_last_yaw);
        pitchDelta = acs_angleDelta(angles[0], self.acs_last_pitch);
        totalDelta = int(yawDelta + pitchDelta);
        isAds = self AdsButtonPressed();

        // Human flicks can be fast, so this is only evidence when paired with
        // a kill shortly after the snap and repeated suspicious events.
        if (totalDelta >= 22)
        {
            self.acs_last_snap_time = getTime();
            self.acs_last_snap_delta = totalDelta;
        }

        if (isAds && !self.acs_was_ads)
        {
            self.acs_last_ads_start_time = getTime();
            self acs_checkAdsLockTransition(self.acs_last_yaw, angles[1]);
        }

        if (isAds && totalDelta >= 12)
            self acs_checkAdsLockTransition(self.acs_last_yaw, angles[1]);

        self acs_trackScriptedAimLock(isAds, self.acs_last_yaw, angles[1], totalDelta);

        self.acs_was_ads = isAds;

        self.acs_last_pitch = angles[0];
        self.acs_last_yaw = angles[1];
    }
}

acs_trackScriptedAimLock(isAds, previousYaw, currentYaw, totalDelta)
{
    if (!isAds)
    {
        self.acs_ads_lock_samples = 0;
        self.acs_ads_lock_target = -1;
        self.acs_ads_lock_since = 0;
        return;
    }

    now = getTime();
    before = self acs_bestVisibleTargetMismatchForYaw(previousYaw);
    after = self acs_bestVisibleTargetMismatchForYaw(currentYaw);

    if (!isDefined(after))
    {
        self.acs_ads_lock_samples = 0;
        self.acs_ads_lock_target = -1;
        self.acs_ads_lock_since = 0;
        return;
    }

    targetId = after["target"];
    finalMismatch = after["mismatch"];

    // The host aim-assist test repeatedly sets player angles straight to the
    // target while ADS is held. That leaves a pattern of near-perfect alignment
    // on the same visible target after a fast correction.
    if (isDefined(before))
    {
        correction = totalDelta;

        if (before["target"] == targetId)
            correction = before["mismatch"] - finalMismatch;

        if ((correction >= 7 || totalDelta >= 7) && finalMismatch <= 5)
        {
            self.acs_ads_lock_last_correction_time = now;
            self.acs_ads_lock_last_correction = int(correction);

            if (self.acs_ads_lock_last_correction < totalDelta)
                self.acs_ads_lock_last_correction = totalDelta;
        }
    }

    if (finalMismatch > 3)
    {
        self.acs_ads_lock_samples = 0;
        self.acs_ads_lock_target = -1;
        self.acs_ads_lock_since = 0;
        return;
    }

    if (self.acs_ads_lock_target != targetId)
    {
        self.acs_ads_lock_target = targetId;
        self.acs_ads_lock_samples = 1;
        self.acs_ads_lock_since = now;
    }
    else
    {
        self.acs_ads_lock_samples++;
    }

    duration = now - self.acs_ads_lock_since;

    if (self.acs_ads_lock_samples >= 3 && duration >= 100 && now - self.acs_ads_lock_last_correction_time <= 900)
    {
        self.acs_last_scripted_lock_time = now;
        self.acs_last_scripted_lock_target = targetId;
        self.acs_last_scripted_lock_duration = duration;
        self.acs_last_scripted_lock_correction = self.acs_ads_lock_last_correction;
        self.acs_last_scripted_lock_mismatch = finalMismatch;
    }
}

acs_processKill(victim, weapon, meansOfDeath, hitLoc)
{
    if (!isDefined(victim) || !isPlayer(victim))
        return;

    // Never score bot attackers. During testing ac_suspicion_include_bots "1"
    // only allows real players killing bots to produce evidence.
    if (acs_isBot(self))
        return;

    if (!level.acs_include_bots && acs_isBot(victim))
        return;

    if (acs_ignoreKillType(weapon, meansOfDeath))
        return;

    now = getTime();
    self.acs_recent_kills++;
    self.acs_recent_hits++;

    if (hitLoc == "head" || hitLoc == "helmet")
        self.acs_recent_headshots++;

    distance = int(distance(self.origin, victim.origin));
    angleMismatch = self acs_yawMismatchTo(victim);
    hasLos = self acs_hasClearTraceTo(victim);
    visibleMs = self acs_visibleDurationMs(victim, now);

    score = 0;
    strongScore = 0;
    weakScore = 0;
    reasons = "";
    aimSignal = 0;
    angleContextSignal = 0;
    adsLockSignal = 0;
    preAimSignal = 0;
    hiddenCrosshairSignal = 0;
    hiddenPursuitSignal = 0;
    scriptedLockSignal = 0;
    adsBotPrecisionSignal = 0;
    uavContextSignal = 0;
    radarPingContextSignal = 0;
    sniperSignal = 0;
    isSniperKill = acs_isSniperWeapon(weapon);
    sniperAdsMs = 9999;

    if (isDefined(self.acs_last_ads_start_time) && self.acs_last_ads_start_time > 0)
        sniperAdsMs = now - self.acs_last_ads_start_time;

    if (isSniperKill)
    {
        self.acs_recent_sniper_kills++;

        if (hitLoc == "head" || hitLoc == "helmet" || hitLoc == "neck")
            self.acs_recent_sniper_headshots++;
    }

    if (distance > 350 && angleMismatch >= 75)
    {
        weakScore += 3;
        angleContextSignal = 1;
        reasons = acs_addReason(reasons, "Kill-time aim angle looked unusual (" + angleMismatch + " degrees)");
    }

    if (isDefined(self.acs_last_snap_time) && now - self.acs_last_snap_time <= 450 && distance > 250)
    {
        if (self.acs_last_snap_delta >= 70)
        {
            aimSignal = 1;

            if (hasLos && visibleMs > 1500)
            {
                weakScore += 5;
                reasons = acs_addReason(reasons, "Large aim flick before a clear-view kill (" + self.acs_last_snap_delta + " degrees)");
            }
            else
            {
                strongScore += 25;
                reasons = acs_addReason(reasons, "Very large aim snap right before the kill (" + self.acs_last_snap_delta + " degrees)");
            }
        }
        else if (self.acs_last_snap_delta >= 45)
        {
            aimSignal = 1;

            if (hasLos && visibleMs > 1500)
            {
                weakScore += 3;
                reasons = acs_addReason(reasons, "Fast aim flick before a clear-view kill (" + self.acs_last_snap_delta + " degrees)");
            }
            else
            {
                weakScore += 15;
                reasons = acs_addReason(reasons, "Fast aim snap right before the kill (" + self.acs_last_snap_delta + " degrees)");
            }
        }
    }

    if (isDefined(self.acs_last_ads_lock_time) && now - self.acs_last_ads_lock_time <= 1500 && distance > 250)
    {
        if (self.acs_last_ads_lock_target == victim getEntityNumber())
        {
            strongScore += 45;
            adsLockSignal = 1;
            aimSignal = 1;
            reasons = acs_addReason(reasons, "ADS aim snapped from off-target to the victim before the kill (" + self.acs_last_ads_lock_delta + " degree correction)");
        }
    }

    if (isDefined(self.acs_last_scripted_lock_time) && now - self.acs_last_scripted_lock_time <= 1200 && distance > 250)
    {
        if (self.acs_last_scripted_lock_target == victim getEntityNumber())
        {
            strongScore += 65;
            scriptedLockSignal = 1;
            adsLockSignal = 1;
            aimSignal = 1;
            reasons = acs_addReason(reasons, "ADS aim stayed tightly locked on the victim after a sudden correction (" + self.acs_last_scripted_lock_duration + "ms lock, " + self.acs_last_scripted_lock_correction + " degree correction, " + self.acs_last_scripted_lock_mismatch + " degree final aim)");
        }
    }

    if (!hasLos && isDefined(self.acs_last_no_los_preaim_time) && now - self.acs_last_no_los_preaim_time <= 1800)
    {
        if (self.acs_last_no_los_preaim_target == victim getEntityNumber())
        {
            strongScore += 45;
            preAimSignal = 1;
            aimSignal = 1;
            reasons = acs_addReason(reasons, "Aimed at this target through a wall before killing them (" + self.acs_last_no_los_preaim_duration + "ms)");
        }
    }

    if (!hasLos && isDefined(self.acs_last_hidden_crosshair_time) && now - self.acs_last_hidden_crosshair_time <= 2200)
    {
        if (self.acs_last_hidden_crosshair_target == victim getEntityNumber() && !self acs_isUsingHeartbeatSensor())
        {
            self.acs_recent_hidden_crosshair_kills++;
            hiddenCrosshairSignal = 1;
            aimSignal = 1;

            if (self.acs_recent_hidden_crosshair_kills >= 2)
            {
                strongScore += 38;
                reasons = acs_addReason(reasons, "Repeatedly held crosshair on hidden targets before killing them (" + self.acs_recent_hidden_crosshair_kills + " kills, latest " + self.acs_last_hidden_crosshair_duration + "ms within " + self.acs_last_hidden_crosshair_mismatch + " degrees)");
            }
            else
            {
                strongScore += 24;
                reasons = acs_addReason(reasons, "Held crosshair on this hidden target before killing them (" + self.acs_last_hidden_crosshair_duration + "ms within " + self.acs_last_hidden_crosshair_mismatch + " degrees)");
            }
        }
    }

    if (!hasLos && isDefined(self.acs_last_hidden_pursuit_time) && now - self.acs_last_hidden_pursuit_time <= 2500)
    {
        if (self.acs_last_hidden_pursuit_target == victim getEntityNumber() && !self acs_isUsingHeartbeatSensor())
        {
            strongScore += 22;
            hiddenPursuitSignal = 1;
            reasons = acs_addReason(reasons, "Moved directly toward a hidden target before killing them (" + self.acs_last_hidden_pursuit_duration + "ms, aim within " + self.acs_last_hidden_pursuit_mismatch + " degrees)");
        }
    }

    if ((preAimSignal || hiddenCrosshairSignal || hiddenPursuitSignal) && self acs_recentTeamUavActive())
    {
        uavContextSignal = 1;
        strongScore = int(strongScore * 0.45);
        weakScore = int(weakScore * 0.60);
        reasons = acs_addReason(reasons, "Recent team UAV could explain the hidden-target push; confidence reduced");
    }

    if ((preAimSignal || hiddenCrosshairSignal || hiddenPursuitSignal) && self acs_victimRecentRadarPingVisible(victim))
    {
        radarPingContextSignal = 1;
        strongScore = int(strongScore * 0.55);
        weakScore = int(weakScore * 0.70);
        reasons = acs_addReason(reasons, "Victim recently fired an unsuppressed weapon and radar was not blocked; confidence reduced");
    }

    if (!hasLos && distance > 300)
    {
        if (preAimSignal || hiddenCrosshairSignal || hiddenPursuitSignal)
        {
            if (distance > 1200)
            {
                weakScore += 18;
                reasons = acs_addReason(reasons, "Kill happened with poor/no clear view at long range");
            }
            else
            {
                weakScore += 12;
                reasons = acs_addReason(reasons, "Kill happened with poor/no clear view");
            }
        }
        else if (visibleMs == 0 && (preAimSignal || hiddenCrosshairSignal || hiddenPursuitSignal))
        {
            weakScore += 10;
            reasons = acs_addReason(reasons, "No clear view was recorded before the kill");
        }
        else if (distance > 1200 && angleMismatch >= 90 && (aimSignal || preAimSignal || hiddenCrosshairSignal || hiddenPursuitSignal))
        {
            weakScore += 3;
            reasons = acs_addReason(reasons, "Long-range kill had poor line-of-sight and bad aim angle");
        }
    }

    if (!hasLos && visibleMs == 0 && distance > 300 && (preAimSignal || hiddenCrosshairSignal || hiddenPursuitSignal))
    {
        strongScore += 8;

        reasons = acs_addReason(reasons, "Target was not visible before the kill");
    }

    if ((hitLoc == "head" || hitLoc == "helmet") && self.acs_recent_headshots >= 3 && self.acs_recent_kills >= 4)
    {
        weakScore += 12;
        reasons = acs_addReason(reasons, "Several headshot kills in a short window");
    }

    if (isSniperKill && distance > 300)
    {
        sniperMechanicalSignal = 0;

        if (isDefined(self.acs_last_snap_time) && now - self.acs_last_snap_time <= 550 && self.acs_last_snap_delta >= 45)
        {
            self.acs_recent_sniper_snap_kills++;
            sniperMechanicalSignal = 1;
        }

        if (sniperAdsMs <= 450 && self AdsButtonPressed())
        {
            self.acs_recent_sniper_quickscope_kills++;

            if (isDefined(self.acs_last_snap_time) && now - self.acs_last_snap_time <= 650 && self.acs_last_snap_delta >= 35)
                sniperMechanicalSignal = 1;
        }

        sniperHeadRatio = 0;
        if (self.acs_recent_sniper_kills >= 1)
            sniperHeadRatio = int((self.acs_recent_sniper_headshots * 100) / self.acs_recent_sniper_kills);

        if (sniperMechanicalSignal && self.acs_recent_sniper_kills >= 4)
        {
            if (self.acs_recent_sniper_snap_kills >= 3)
            {
                self.acs_recent_sniper_suspicious_events++;
                sniperSignal = 1;
                aimSignal = 1;
                strongScore += 28;
                reasons = acs_addReason(reasons, "Repeated sniper snap-kill pattern (" + self.acs_recent_sniper_snap_kills + " recent sniper kills had fast aim snaps)");
            }

            if (self.acs_recent_sniper_quickscope_kills >= 4 && sniperHeadRatio >= 55)
            {
                self.acs_recent_sniper_suspicious_events++;
                sniperSignal = 1;
                aimSignal = 1;
                strongScore += 24;
                reasons = acs_addReason(reasons, "Repeated quickscope sniper kills with unusually high head/neck rate (" + sniperHeadRatio + "% over " + self.acs_recent_sniper_kills + " sniper kills)");
            }
            else if (self.acs_recent_sniper_quickscope_kills >= 5)
            {
                sniperSignal = 1;
                weakScore += 10;
                reasons = acs_addReason(reasons, "Many quickscope sniper kills in the recent sample");
            }
        }

        if (self.acs_recent_sniper_kills >= 6 && sniperHeadRatio >= 70)
        {
            self.acs_recent_sniper_suspicious_events++;
            sniperSignal = 1;
            aimSignal = 1;
            strongScore += 22;
            reasons = acs_addReason(reasons, "Sniper head/neck hit rate is unusually high in the recent sample (" + sniperHeadRatio + "% over " + self.acs_recent_sniper_kills + " sniper kills)");
        }

        if (sniperSignal && hasLos && visibleMs > 2200 && !scriptedLockSignal && !adsLockSignal)
        {
            strongScore = int(strongScore * 0.65);
            weakScore = int(weakScore * 0.80);
            reasons = acs_addReason(reasons, "Clear long visibility could explain some sniper kills; confidence reduced");
        }
    }

    if (level.acs_include_bots && acs_isBot(victim) && distance > 250 && angleMismatch <= 8 && (aimSignal || preAimSignal || hiddenCrosshairSignal || hiddenPursuitSignal || scriptedLockSignal))
    {
        self.acs_recent_lockon_kills++;

        if (scriptedLockSignal && angleMismatch <= 4)
        {
            strongScore += 35;
            reasons = acs_addReason(reasons, "Killed a bot while ADS was locked almost perfectly onto them");
        }

        if (self.acs_recent_lockon_kills >= 3)
        {
            strongScore += 30;
            aimSignal = 1;
            reasons = acs_addReason(reasons, "Killed bots repeatedly with very precise aim");
        }
    }

    if (level.acs_include_bots && acs_isBot(victim) && distance > 250 && angleMismatch <= 15 && self AdsButtonPressed())
    {
        botSnapSignal = false;

        if (scriptedLockSignal || adsLockSignal)
            botSnapSignal = true;

        if (isDefined(self.acs_last_snap_time) && now - self.acs_last_snap_time <= 550 && self.acs_last_snap_delta >= 45)
            botSnapSignal = true;

        // Tight ADS aim on bots is common during normal sniper/rifle play.
        // Only treat it as anti-cheat evidence when it is paired with a
        // recent snap/lock signal that looks like automated aim correction.
        if (botSnapSignal)
        {
            self.acs_recent_ads_snaplock_kills++;
            adsBotPrecisionSignal = 1;
            aimSignal = 1;

            if (angleMismatch <= 4 && isDefined(self.acs_last_snap_time) && now - self.acs_last_snap_time <= 550 && self.acs_last_snap_delta >= 45)
            {
                self.acs_recent_ads_precise_bot_kills++;
                strongScore += 85;
                reasons = acs_addReason(reasons, "ADS snapped onto a bot with near-perfect aim before the kill (" + self.acs_last_snap_delta + " degree snap, " + angleMismatch + " degree final aim)");
            }
            else if (self.acs_recent_ads_snaplock_kills >= 2)
            {
                strongScore += 65;
                reasons = acs_addReason(reasons, "Repeated ADS snap-lock kills on bots with tight aim alignment (" + self.acs_recent_ads_snaplock_kills + " bot kills, latest " + angleMismatch + " degrees, snap " + self.acs_last_snap_delta + " degrees)");
            }
            else
            {
                strongScore += 34;
                reasons = acs_addReason(reasons, "ADS snap-lock pattern on a bot before the kill (" + self.acs_last_snap_delta + " degree snap, " + angleMismatch + " degree final aim)");
            }

            if (hitLoc == "head" || hitLoc == "helmet")
            {
                weakScore += 10;
                reasons = acs_addReason(reasons, "ADS snap-lock kill landed as a headshot");
            }
        }
    }

    if (self.acs_recent_kills >= 5 && (strongScore + weakScore) > 0)
    {
        weakScore += 6;
        reasons = acs_addReason(reasons, "Many kills in a short window");
    }

    if (visibleMs > 0 && visibleMs < 120 && distance > 300)
    {
        strongScore += 15;
        reasons = acs_addReason(reasons, "Killed the target less than 120ms after the server first saw clear visibility");
    }

    if (self.acs_recent_shots >= 6 && (strongScore + weakScore) > 0)
    {
        accuracy = int((self.acs_recent_hits * 100) / self.acs_recent_shots);

        if (accuracy >= 80 && self.acs_recent_hits >= 6)
        {
            weakScore += 8;
            reasons = acs_addReason(reasons, "Very high short-window accuracy (" + accuracy + "%)");
        }
    }

    if (strongScore <= 0 && weakScore > 18)
        weakScore = 18;

    // A single noisy angle/LOS mismatch is useful context, but by itself it is
    // too weak to log as suspicious gameplay. Require a behavioral signal.
    if (strongScore <= 0 && !aimSignal && !preAimSignal && !hiddenCrosshairSignal && !hiddenPursuitSignal && !scriptedLockSignal && !adsBotPrecisionSignal && !sniperSignal)
        weakScore = 0;

    if (hasLos && visibleMs > 2500 && !adsLockSignal && !preAimSignal && !hiddenCrosshairSignal && !hiddenPursuitSignal && !scriptedLockSignal && !adsBotPrecisionSignal && !sniperSignal && strongScore <= 0 && weakScore < 12)
        weakScore = 0;

    score = strongScore + weakScore;

    if (score > 0 && strongScore <= 0 && visibleMs > 2500)
        score = int(score * 0.50);

    score = self acs_applyReductions(score, victim, distance, visibleMs);

    if (uavContextSignal && score > 0)
        score = int(score * 0.75);

    if (radarPingContextSignal && score > 0)
        score = int(score * 0.80);

    if (acs_isBot(victim) && hasLos && !scriptedLockSignal && !adsBotPrecisionSignal)
        score = int(score * 0.85);

    if (score <= 0)
        return;

    self.acs_score += score;
    self.acs_strong_score += strongScore;
    self.acs_weak_score += weakScore;

    if (strongScore > 0)
        self.acs_strong_events++;
    else
        self.acs_weak_events++;

    self.acs_reasons = acs_mergeReasons(self.acs_reasons, reasons);

    self acs_logEvidence(victim, weapon, hitLoc, distance, angleMismatch, hasLos, visibleMs, score, reasons);

    if (self acs_shouldAlert(now))
    {
        self.acs_last_alert_time = now;
        self acs_logAlert(victim, weapon, hitLoc, distance, angleMismatch, hasLos, visibleMs, reasons);
    }
}

acs_checkAdsLockTransition(previousYaw, currentYaw)
{
    if (!isAlive(self))
        return;

    before = self acs_bestTargetMismatchForYaw(previousYaw);
    after = self acs_bestTargetMismatchForYaw(currentYaw);

    if (!isDefined(before) || !isDefined(after))
        return;

    if (before["target"] != after["target"] && before["mismatch"] < 45)
        return;

    correction = before["mismatch"] - after["mismatch"];

    if (before["mismatch"] >= 25 && after["mismatch"] <= 18 && correction >= 12)
    {
        self.acs_last_ads_lock_time = getTime();
        self.acs_last_ads_lock_delta = int(correction);
        self.acs_last_ads_lock_target = after["target"];
    }
}

acs_applyReductions(score, victim, distance, visibleMs)
{
    adjusted = score;

    if (distance < 180)
        adjusted -= 15;

    if (visibleMs > 900)
        adjusted -= 10;

    if (isDefined(victim.acs_last_weapon_fire_time) && getTime() - victim.acs_last_weapon_fire_time < 2500)
        adjusted -= 10;

    // UAV state is not exposed consistently across IW4x GSC builds. If your
    // build exposes a reliable UAV/team radar variable, add that reduction here.

    if (adjusted < 0)
        adjusted = 0;

    return adjusted;
}

acs_shouldAlert(now)
{
    if (self.acs_score < level.acs_threshold)
        return false;

    if (self.acs_last_alert_time != 0 && now - self.acs_last_alert_time < level.acs_alert_cooldown_ms)
        return false;

    // Weak evidence is useful context, but it should not be enough by itself
    // unless the total score is very high. This keeps normal good play from
    // becoming a cheat alert just because several noisy traces stacked up.
    if (self.acs_strong_events > 0 && self.acs_strong_score >= 15)
        return true;

    if (self.acs_score >= 150 && self.acs_weak_events >= 6)
        return true;

    return false;
}

acs_logEvidence(victim, weapon, hitLoc, distance, angleMismatch, hasLos, visibleMs, addedScore, reasons)
{
    logPrint("CUSTOM_AC_EVIDENCE;"
        + acs_escape(self acs_guid()) + ";"
        + acs_escape(self.name) + ";"
        + self getEntityNumber() + ";"
        + acs_escape(victim.name) + ";"
        + acs_escape(weapon) + ";"
        + acs_escape(hitLoc) + ";"
        + distance + ";"
        + angleMismatch + ";"
        + acs_boolInt(hasLos) + ";"
        + visibleMs + ";"
        + addedScore + ";"
        + self.acs_score + ";"
        + acs_escape(reasons) + ";"
        + acs_escape(getDvar("mapname")) + ";"
        + acs_escape(getDvar("sv_hostname")) + "\n");

    self acs_logReadableReview("EVIDENCE", victim, weapon, distance, angleMismatch, hasLos, visibleMs, addedScore, reasons);
}

acs_logAlert(victim, weapon, hitLoc, distance, angleMismatch, hasLos, visibleMs, alertReasons)
{
    if (!isDefined(alertReasons) || alertReasons == "")
        alertReasons = self.acs_reasons;

    // Keep the machine-readable Discord trigger short. IW4x can silently drop
    // very long logPrint lines, and the watcher already keeps recent evidence
    // lines to explain the full pattern.
    logPrint("CUSTOM_AC_ALERT;"
        + acs_escape(self acs_guid()) + ";"
        + acs_escape(self.name) + ";"
        + self getEntityNumber() + ";"
        + acs_escape(victim.name) + ";"
        + acs_escape(weapon) + ";"
        + acs_escape(hitLoc) + ";"
        + distance + ";"
        + angleMismatch + ";"
        + acs_boolInt(hasLos) + ";"
        + visibleMs + ";"
        + self.acs_score + ";"
        + acs_escape(alertReasons) + ";"
        + acs_escape(getDvar("mapname")) + ";"
        + acs_escape(getDvar("sv_hostname")) + "\n");

    self acs_logReadableReview("ALERT", victim, weapon, distance, angleMismatch, hasLos, visibleMs, self.acs_score, self.acs_reasons);
}

acs_logReadableReview(kind, victim, weapon, distance, angleMismatch, hasLos, visibleMs, scoreValue, reasons)
{
    viewText = "clear view";
    if (!hasLos)
        viewText = "poor/no clear view";

    visibleText = "visible for " + visibleMs + "ms";
    if (visibleMs == 0)
        visibleText = "not recorded visible before kill";

    logPrint("CUSTOM_AC_REVIEW;"
        + kind + ";"
        + "player=" + acs_escape(self.name) + ";"
        + "client=" + self getEntityNumber() + ";"
        + "score=" + scoreValue + ";"
        + "victim=" + acs_escape(victim.name) + ";"
        + "weapon=" + acs_escape(weapon) + ";"
        + "summary=" + acs_escape(self acs_plainSuspicionSummary(reasons, hasLos)) + ";"
        + "details=" + distance + " units, " + viewText + ", " + visibleText + ", aim angle " + angleMismatch + " deg;"
        + "map=" + acs_escape(getDvar("mapname")) + ";"
        + "server=" + acs_escape(getDvar("sv_hostname")) + "\n");
}

acs_plainSuspicionSummary(reasons, hasLos)
{
    if (isSubStr(reasons, "ADS aim stayed tightly locked") || isSubStr(reasons, "ADS was locked almost perfectly"))
        return "Player's ADS aim looked like aim assist or aimbot lock-on before the kill.";

    if (isSubStr(reasons, "Aimed at this target through a wall"))
        return "Player appeared to aim at a target through cover before killing them.";

    if (isSubStr(reasons, "Held crosshair") || isSubStr(reasons, "hidden targets"))
        return "Player appeared to keep their crosshair on hidden targets before killing them.";

    if (isSubStr(reasons, "No clear view") || isSubStr(reasons, "poor/no clear view") || !hasLos)
        return "Kill had poor line-of-sight and supporting suspicious behavior.";

    if (isSubStr(reasons, "aim snap") || isSubStr(reasons, "off-target") || isSubStr(reasons, "Aim was far away"))
        return "Aim movement around the kill looked suspicious.";

    if (isSubStr(reasons, "Many kills"))
        return "Player had several suspicious kills in a short period.";

    if (isSubStr(reasons, "precise aim"))
        return "Killed a bot with unusually precise aim.";

    return "Player gained anti-cheat suspicion from this kill.";
}

acs_hasClearTraceTo(target)
{
    start = self getEye();
    end = target getEye();

    // bulletTracePassed exists on IW4x/CoD GSC builds commonly used for
    // visibility checks. If your specific build lacks it, replace this with
    // your engine's line-of-sight helper and keep the return contract boolean.
    return bullettracepassed(start, end, false, self);
}

acs_visibleDurationMs(target, now)
{
    if (!isDefined(self.acs_visible_since))
        return 0;

    key = "acs_visible_" + target getEntityNumber();

    if (!isDefined(self.acs_visible_since[key]))
        return 0;

    return now - self.acs_visible_since[key];
}

acs_yawMismatchTo(target)
{
    delta = target.origin - self.origin;
    targetAngles = vectortoangles(delta);
    myAngles = self getPlayerAngles();
    return int(acs_angleDelta(myAngles[1], targetAngles[1]));
}

acs_bestTargetMismatchForYaw(yaw)
{
    players = level.players;
    best = undefined;
    bestMismatch = 181;
    bestTarget = -1;

    for (i = 0; i < players.size; i++)
    {
        target = players[i];

        if (!isDefined(target) || target == self || !isPlayer(target))
            continue;

        if (!isAlive(target))
            continue;

        if (acs_isBot(target) && !level.acs_include_bots)
            continue;

        if (!self acs_isEnemyTarget(target))
            continue;

        dist = distance(self.origin, target.origin);

        if (dist < 250 || dist > 7000)
            continue;

        mismatch = self acs_yawMismatchToWithYaw(target, yaw);

        if (mismatch < bestMismatch)
        {
            bestMismatch = mismatch;
            bestTarget = target getEntityNumber();
        }
    }

    if (bestTarget < 0)
        return undefined;

    best = [];
    best["target"] = bestTarget;
    best["mismatch"] = bestMismatch;
    return best;
}

acs_bestVisibleTargetMismatchForYaw(yaw)
{
    players = level.players;
    best = undefined;
    bestMismatch = 181;
    bestTarget = -1;
    bestDistance = 0;

    for (i = 0; i < players.size; i++)
    {
        target = players[i];

        if (!isDefined(target) || target == self || !isPlayer(target))
            continue;

        if (!isAlive(target))
            continue;

        if (acs_isBot(target) && !level.acs_include_bots)
            continue;

        if (!self acs_isEnemyTarget(target))
            continue;

        dist = int(distance(self.origin, target.origin));

        if (dist < 250 || dist > 4000)
            continue;

        if (!self acs_hasClearTraceTo(target))
            continue;

        mismatch = self acs_yawMismatchToWithYaw(target, yaw);

        if (mismatch < bestMismatch)
        {
            bestMismatch = mismatch;
            bestTarget = target getEntityNumber();
            bestDistance = dist;
        }
    }

    if (bestTarget < 0)
        return undefined;

    best = [];
    best["target"] = bestTarget;
    best["mismatch"] = bestMismatch;
    best["distance"] = bestDistance;
    return best;
}

acs_yawMismatchToWithYaw(target, yaw)
{
    delta = target.origin - self.origin;
    targetAngles = vectortoangles(delta);
    return int(acs_angleDelta(yaw, targetAngles[1]));
}

acs_isEnemyTarget(target)
{
    if (!isDefined(self.pers) || !isDefined(target.pers))
        return true;

    if (!isDefined(self.pers["team"]) || !isDefined(target.pers["team"]))
        return true;

    if (self.pers["team"] == "spectator" || target.pers["team"] == "spectator")
        return false;

    if (self.pers["team"] == target.pers["team"])
        return false;

    return true;
}

acs_angleDelta(a, b)
{
    diff = a - b;

    while (diff > 180)
        diff -= 360;

    while (diff < -180)
        diff += 360;

    if (diff < 0)
        diff = 0 - diff;

    return diff;
}

acs_ignoreKillType(weapon, meansOfDeath)
{
    if (isDefined(meansOfDeath))
    {
        if (isSubStr(meansOfDeath, "GRENADE") || isSubStr(meansOfDeath, "EXPLOSIVE") || isSubStr(meansOfDeath, "PROJECTILE"))
            return true;
    }

    if (!isDefined(weapon))
        return false;

    if (isSubStr(weapon, "ac130") || isSubStr(weapon, "helicopter") || isSubStr(weapon, "harrier") || isSubStr(weapon, "airstrike") || isSubStr(weapon, "predator") || isSubStr(weapon, "nuke"))
        return true;

    return false;
}

acs_isSniperWeapon(weapon)
{
    if (!isDefined(weapon))
        return false;

    if (isSubStr(weapon, "barrett") || isSubStr(weapon, "wa2000") || isSubStr(weapon, "m21") || isSubStr(weapon, "cheytac") || isSubStr(weapon, "intervention"))
        return true;

    if (isSubStr(weapon, "l96") || isSubStr(weapon, "dragunov") || isSubStr(weapon, "m40a3") || isSubStr(weapon, "remington700"))
        return true;

    return false;
}

acs_isUsingHeartbeatSensor()
{
    weapon = self getCurrentWeapon();

    if (!isDefined(weapon))
        return false;

    return isSubStr(weapon, "heartbeat");
}

acs_weaponHasSuppressor(weapon)
{
    if (!isDefined(weapon))
        return false;

    if (isSubStr(weapon, "silencer"))
        return true;

    if (isSubStr(weapon, "_silenced"))
        return true;

    if (isSubStr(weapon, "suppressed"))
        return true;

    return false;
}

acs_recentTeamUavActive()
{
    if (!isDefined(level.acs_last_team_uav_time))
        return false;

    if (!isDefined(self.pers) || !isDefined(self.pers["team"]))
        return false;

    team = self.pers["team"];

    if (!isDefined(level.acs_last_team_uav_time[team]))
        return false;

    return getTime() - level.acs_last_team_uav_time[team] <= 30000;
}

acs_victimRecentRadarPingVisible(victim)
{
    if (!isDefined(victim) || !isDefined(victim.acs_last_unsuppressed_fire_time))
        return false;

    if (getTime() - victim.acs_last_unsuppressed_fire_time > 5000)
        return false;

    if (self acs_radarBlockedByTargetTeam(victim))
        return false;

    return true;
}

acs_radarBlockedByTargetTeam(victim)
{
    if (!isDefined(victim) || !isDefined(victim.pers) || !isDefined(victim.pers["team"]))
        return false;

    team = victim.pers["team"];
    now = getTime();

    if (isDefined(level.acs_last_team_counter_uav_time) && isDefined(level.acs_last_team_counter_uav_time[team]))
    {
        if (now - level.acs_last_team_counter_uav_time[team] <= 30000)
            return true;
    }

    if (isDefined(level.acs_last_team_emp_time) && isDefined(level.acs_last_team_emp_time[team]))
    {
        if (now - level.acs_last_team_emp_time[team] <= 60000)
            return true;
    }

    return false;
}

acs_decayScore()
{
    self endon("disconnect");

    for (;;)
    {
        wait (level.acs_decay_interval_ms / 1000);

        if (self.acs_score > 0)
        {
            self.acs_score -= level.acs_decay_amount;

            if (self.acs_score < 0)
                self.acs_score = 0;
        }

        if (self.acs_strong_score > 0)
        {
            self.acs_strong_score -= 3;

            if (self.acs_strong_score < 0)
                self.acs_strong_score = 0;
        }

        if (self.acs_weak_score > 0)
        {
            self.acs_weak_score -= level.acs_decay_amount;

            if (self.acs_weak_score < 0)
                self.acs_weak_score = 0;
        }

        if (self.acs_strong_score <= 0)
            self.acs_strong_events = 0;

        if (self.acs_weak_score <= 0)
            self.acs_weak_events = 0;

        if (self.acs_recent_kills > 0)
            self.acs_recent_kills--;

        if (self.acs_recent_headshots > 0)
            self.acs_recent_headshots--;

        if (self.acs_recent_lockon_kills > 0)
            self.acs_recent_lockon_kills--;

        if (self.acs_recent_ads_precise_bot_kills > 0)
            self.acs_recent_ads_precise_bot_kills--;

        if (self.acs_recent_hidden_crosshair_kills > 0)
            self.acs_recent_hidden_crosshair_kills--;

        if (self.acs_recent_sniper_kills > 0)
            self.acs_recent_sniper_kills--;

        if (self.acs_recent_sniper_headshots > 0)
            self.acs_recent_sniper_headshots--;

        if (self.acs_recent_sniper_snap_kills > 0)
            self.acs_recent_sniper_snap_kills--;

        if (self.acs_recent_sniper_quickscope_kills > 0)
            self.acs_recent_sniper_quickscope_kills--;

        if (self.acs_recent_sniper_suspicious_events > 0)
            self.acs_recent_sniper_suspicious_events--;
    }
}

acs_watchSayCommands()
{
    self endon("disconnect");

    for (;;)
    {
        // IW4x emits "say" to player scripts on common builds. If your build
        // does not, bind !wh through an admin menu/dvar and call acs_toggleWh().
        self waittill("say", message);

        if (message == "!wh")
            self acs_toggleWh();
    }
}

acs_toggleWh()
{
    if (!self acs_isAuthorizedAdmin())
    {
        self iPrintLn("^1Anti-cheat debug is admin-only.");
        logPrint("CUSTOM_AC_DEBUG_DENIED;" + acs_escape(self acs_guid()) + ";" + acs_escape(self.name) + ";" + self getEntityNumber() + "\n");
        return;
    }

    if (!self acs_canUseDebug())
    {
        self iPrintLn("^3Join spectator before using anti-cheat debug.");
        return;
    }

    if (isDefined(self.acs_wh_enabled) && self.acs_wh_enabled)
    {
        self.acs_wh_enabled = false;
        self notify("acs_wh_stop");
        self iPrintLn("^2Anti-cheat debug off.");
        return;
    }

    self.acs_wh_enabled = true;
    self iPrintLn("^2Anti-cheat debug on.");
    self thread acs_debugOverlay();
}

acs_debugOverlay()
{
    self endon("disconnect");
    self endon("acs_wh_stop");

    while (isDefined(self.acs_wh_enabled) && self.acs_wh_enabled)
    {
        if (!self acs_canUseDebug())
            break;

        players = level.players;
        lines = "^1AC REVIEW^7\n";

        for (i = 0; i < players.size; i++)
        {
            target = players[i];

            if (!isDefined(target) || target == self || !isPlayer(target) || !isAlive(target))
                continue;

            if (isDefined(self.pers["team"]) && isDefined(target.pers["team"]) && self.pers["team"] == target.pers["team"] && self.pers["team"] != "spectator")
                continue;

            dist = int(distance(self.origin, target.origin));
            los = self acs_hasClearTraceTo(target);
            lines += "^1" + target.name + "^7 " + dist + "u LOS=" + acs_boolInt(los) + "\n";
        }

        self iPrintLn(lines);
        wait 1.0;
    }

    self.acs_wh_enabled = false;
}

acs_canUseDebug()
{
    if (isDefined(self.sessionstate) && self.sessionstate != "spectator")
        return false;

    if (isDefined(self.pers["team"]) && self.pers["team"] != "spectator")
        return false;

    return true;
}

acs_isAuthorizedAdmin()
{
    ids = getDvar("ac_suspicion_admin_ids");

    if (!isDefined(ids) || ids == "")
        return false;

    guid = self acs_guid();
    slot = "" + self getEntityNumber();

    if (isSubStr("," + ids + ",", "," + guid + ","))
        return true;

    if (isSubStr("," + ids + ",", "," + slot + ","))
        return true;

    return false;
}

acs_guid()
{
    if (isDefined(self.guid))
        return self.guid;

    return "";
}

acs_isBot(player)
{
    if (!isDefined(player))
        return true;

    if (isDefined(player.pers) && isDefined(player.pers["isBot"]) && player.pers["isBot"])
        return true;

    guid = player acs_guid();

    if (isSubStr(guid, "bot"))
        return true;

    return false;
}

acs_addReason(reasons, reason)
{
    if (!isDefined(reasons) || reasons == "")
        return reason;

    return reasons + " | " + reason;
}

acs_mergeReasons(existing, incoming)
{
    if (!isDefined(existing) || existing == "")
        return incoming;

    if (!isDefined(incoming) || incoming == "")
        return existing;

    if (isSubStr(existing, incoming))
        return existing;

    return existing + " | " + incoming;
}

acs_escape(value)
{
    if (!isDefined(value))
        return "";

    // Keep log parsing simple. Avoid semicolons in player names/reasons.
    text = "" + value;
    parts = strtok(text, ";");

    if (parts.size <= 1)
        return text;

    cleaned = parts[0];

    for (i = 1; i < parts.size; i++)
        cleaned += "," + parts[i];

    return cleaned;
}

acs_boolInt(value)
{
    if (value)
        return 1;

    return 0;
}

acs_getDvarIntDefault(name, fallback)
{
    value = getDvarInt(name);

    if (value == 0 && getDvar(name) == "")
        return fallback;

    return value;
}

acs_debug(message)
{
    if (!isDefined(level.acs_debug) || !level.acs_debug)
        return;

    printconsole("[ACS] " + message + "\n");
}
