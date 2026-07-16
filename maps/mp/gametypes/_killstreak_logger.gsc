init()
{
    level.kslog_debug = false;
    printconsole("[KSLOG] killstreak logger loaded\n");
    level thread kslog_onPlayerConnect();
    level thread kslog_watchNukeCalls();
    level thread kslog_watchCarePackageRewards();
}

kslog_onPlayerConnect()
{
    for (;;)
    {
        level waittill("connected", player);
        player thread kslog_watchKillstreakEarns();
        player thread kslog_watchKillstreakSwitches();
    }
}

kslog_watchKillstreakEarns()
{
    self endon("disconnect");
    self.kslog_last_earned_streak = "";
    self.kslog_last_earned_time = 0;

    for (;;)
    {
        if (isDefined(self.pers) && isDefined(self.pers["lastEarnedStreak"]))
        {
            streak = self.pers["lastEarnedStreak"];
            now = getTime();

            if (isDefined(streak) && streak != "" && (streak != self.kslog_last_earned_streak || now - self.kslog_last_earned_time > 10000))
            {
                self.kslog_last_earned_streak = streak;
                self.kslog_last_earned_time = now;
                self kslog_logEarn(streak);
            }
        }

        wait 0.50;
    }
}

kslog_watchKillstreakSwitches()
{
    self endon("disconnect");
    self.kslog_last_called_streak = "";
    self.kslog_last_called_time = 0;

    for (;;)
    {
        self waittill("weapon_change", newWeapon);

        streak = kslog_streakFromWeapon(newWeapon);

        if (streak == "")
            continue;

        if (kslog_requiresActiveWeaponEvidence(streak))
        {
            wait 3.5;

            currentWeapon = self getCurrentWeapon();

            if (!kslog_isValidActiveWeapon(streak, newWeapon, currentWeapon))
                continue;

            self kslog_logCallIfAllowed(streak, currentWeapon);
            continue;
        }

        wait 0.75;

        self kslog_logCallIfAllowed(streak, newWeapon);
    }
}

kslog_requiresActiveWeaponEvidence(streak)
{
    switch (streak)
    {
        case "ac130":
        case "chopper_gunner":
        case "predator_missile":
            return true;
    }

    return false;
}

kslog_recentlyLoggedCall(streak)
{
    now = getTime();

    if (isDefined(self.kslog_last_called_streak) && self.kslog_last_called_streak == streak && isDefined(self.kslog_last_called_time) && now - self.kslog_last_called_time < 10000)
        return true;

    self.kslog_last_called_streak = streak;
    self.kslog_last_called_time = now;
    return false;
}

kslog_isPlayerAlive()
{
    if (!isAlive(self))
        return false;

    if (isDefined(self.sessionstate) && self.sessionstate != "playing")
        return false;

    return true;
}

kslog_isCallAllowed(streak)
{
    alive = self kslog_isPlayerAlive();

    if (!alive)
        return false;

    if (self kslog_recentlyLoggedCall(streak))
        return false;

    return true;
}

kslog_logCallIfAllowed(streak, weapon)
{
    allowed = self kslog_isCallAllowed(streak);

    if (!allowed)
        return;

    self kslog_logCall(streak, weapon);
}

kslog_watchNukeCalls()
{
    lastNukePlayer = undefined;
    lastNukeTime = 0;

    for (;;)
    {
        if ((isDefined(level.nukeincoming) || isDefined(level.moabincoming)) && isDefined(level.nukeinfo) && isDefined(level.nukeinfo.player))
        {
            player = level.nukeinfo.player;
            now = getTime();

            if (isPlayer(player) && (!isDefined(lastNukePlayer) || lastNukePlayer != player || now - lastNukeTime > 10000))
            {
                lastNukePlayer = player;
                lastNukeTime = now;
                player kslog_logCall("nuke", "nuke");
            }
        }

        wait 0.50;
    }
}

kslog_watchCarePackageRewards()
{
    for (;;)
    {
        crates = getentarray("care_package", "targetname");

        for (i = 0; i < crates.size; i++)
        {
            crate = crates[i];

            if (!isDefined(crate))
                continue;

            if (isDefined(crate.kslog_tracking_reward) && crate.kslog_tracking_reward)
                continue;

            crate.kslog_tracking_reward = true;
            crate thread kslog_watchCarePackageReward();
        }

        wait 0.75;
    }
}

kslog_watchCarePackageReward()
{
    self endon("death");
    self waittill("captured", player);

    if (!isPlayer(player))
        return;

    if (!isDefined(self.cratetype))
        return;

    streak = kslog_streakFromCrateType(self.cratetype);

    if (streak == "")
        return;

    player kslog_logPackageReward(streak);
}

kslog_streakFromCrateType(crateType)
{
    if (!isDefined(crateType))
        return "";

    if (crateType == "helicopter_flares")
        return "pavelow";

    if (crateType == "helicopter_minigun")
        return "chopper_gunner";

    if (crateType == "sentry")
        return "sentry_gun";

    return crateType;
}

kslog_streakFromWeapon(weapon)
{
    if (!isDefined(weapon))
        return "";

    if (weapon == "killstreak_ac130_mp")
        return "ac130";

    if (weapon == "killstreak_helicopter_minigun_mp")
        return "chopper_gunner";

    if (isSubStr(weapon, "predator"))
        return "predator_missile";

    if (isSubStr(weapon, "stealth_airstrike"))
        return "stealth_airstrike";

    if (isSubStr(weapon, "harrier_airstrike"))
        return "harrier_airstrike";

    if (isSubStr(weapon, "airstrike"))
        return "airstrike";

    if (isSubStr(weapon, "emp"))
        return "emp";

    if (isSubStr(weapon, "counter_uav"))
        return "counter_uav";

    if (isSubStr(weapon, "uav"))
        return "uav";

    if (isSubStr(weapon, "helicopter_flares"))
        return "pavelow";

    if (isSubStr(weapon, "helicopter"))
        return "helicopter";

    if (isSubStr(weapon, "airdrop_mega"))
        return "emergency_airdrop";

    if (isSubStr(weapon, "airdrop"))
        return "care_package";

    if (isSubStr(weapon, "sentry"))
        return "sentry_gun";

    return "";
}

kslog_isValidActiveWeapon(streak, originalWeapon, currentWeapon)
{
    if (!isDefined(currentWeapon))
        return false;

    if (currentWeapon == originalWeapon)
        return true;

    switch (streak)
    {
        case "ac130":
            return currentWeapon == "ac130_105mm_mp" || currentWeapon == "ac130_40mm_mp" || currentWeapon == "ac130_25mm_mp";

        case "chopper_gunner":
            return currentWeapon == "heli_remote_mp";

        case "predator_missile":
            return isSubStr(currentWeapon, "remotemissile");
    }

    return false;
}

kslog_logCall(streak, weapon)
{
    guid = "";

    if (isDefined(self.guid))
        guid = self.guid;

    if (streak == "uav")
        self kslog_markTeamUavActive();

    if (streak == "counter_uav")
        self kslog_markTeamCounterUavActive();

    if (streak == "emp")
        self kslog_markTeamEmpActive();

    logPrint("CUSTOM_KILLSTREAK_CALL;" + guid + ";" + self.name + ";" + streak + ";" + weapon + ";" + self kslog_currentKillstreak() + "\n");

    if (isDefined(level.kslog_debug) && level.kslog_debug)
        printconsole("[KSLOG] " + self.name + " called " + streak + " with " + weapon + "\n");
}

kslog_markTeamUavActive()
{
    team = "unknown";

    if (isDefined(self.pers) && isDefined(self.pers["team"]))
        team = self.pers["team"];

    if (!isDefined(level.acs_last_team_uav_time))
        level.acs_last_team_uav_time = [];

    level.acs_last_team_uav_time[team] = getTime();

    if (isDefined(level.kslog_debug) && level.kslog_debug)
        printconsole("[KSLOG] UAV active for team " + team + "\n");
}

kslog_markTeamCounterUavActive()
{
    team = self kslog_team();

    if (!isDefined(level.acs_last_team_counter_uav_time))
        level.acs_last_team_counter_uav_time = [];

    level.acs_last_team_counter_uav_time[team] = getTime();

    if (isDefined(level.kslog_debug) && level.kslog_debug)
        printconsole("[KSLOG] Counter-UAV active for team " + team + "\n");
}

kslog_markTeamEmpActive()
{
    team = self kslog_team();

    if (!isDefined(level.acs_last_team_emp_time))
        level.acs_last_team_emp_time = [];

    level.acs_last_team_emp_time[team] = getTime();

    if (isDefined(level.kslog_debug) && level.kslog_debug)
        printconsole("[KSLOG] EMP active for team " + team + "\n");
}

kslog_team()
{
    if (isDefined(self.pers) && isDefined(self.pers["team"]))
        return self.pers["team"];

    return "unknown";
}

kslog_logEarn(streak)
{
    guid = "";

    if (isDefined(self.guid))
        guid = self.guid;

    logPrint("CUSTOM_KILLSTREAK_EARN;" + guid + ";" + self.name + ";" + streak + ";" + self kslog_currentKillstreak() + "\n");

    if (isDefined(level.kslog_debug) && level.kslog_debug)
        printconsole("[KSLOG] " + self.name + " earned " + streak + "\n");
}

kslog_logPackageReward(streak)
{
    guid = "";

    if (isDefined(self.guid))
        guid = self.guid;

    logPrint("CUSTOM_KILLSTREAK_PACKAGE_REWARD;" + guid + ";" + self.name + ";" + streak + ";" + self kslog_currentKillstreak() + "\n");

    if (isDefined(level.kslog_debug) && level.kslog_debug)
        printconsole("[KSLOG] " + self.name + " received " + streak + " from care package\n");
}

kslog_prettyStreak(streak)
{
    switch (streak)
    {
        case "ac130":
            return "AC-130";

        case "chopper_gunner":
        case "helicopter_minigun":
            return "Chopper Gunner";

        case "nuke":
            return "Tactical Nuke";

        case "predator_missile":
            return "Predator Missile";

        case "counter_uav":
            return "Counter-UAV";

        case "uav":
            return "UAV";

        case "harrier_airstrike":
            return "Harrier Strike";

        case "stealth_airstrike":
            return "Stealth Airstrike";

        case "airstrike":
            return "Airstrike";

        case "emp":
            return "EMP";

        case "pavelow":
            return "Pavelow";

        case "helicopter":
            return "Attack Helicopter";

        case "emergency_airdrop":
            return "Emergency Airdrop";

        case "care_package":
            return "Care Package";

        case "sentry_gun":
            return "Sentry Gun";
    }

    return streak;
}

kslog_currentKillstreak()
{
    if (isDefined(self.pers) && isDefined(self.pers["cur_kill_streak"]))
        return self.pers["cur_kill_streak"];

    return 0;
}
