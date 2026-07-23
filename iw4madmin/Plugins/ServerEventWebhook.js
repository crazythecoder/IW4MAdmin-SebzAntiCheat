const CONNECTION_WEBHOOK = 'ClientConnection';
const CHAT_WEBHOOK = 'ClientMessage';
const UNKNOWN_COUNTRY = '🌐 Unknown';
const WEBHOOK_FOOTER = "Xenon’s IW4X Servers";
const CONNECTION_COLORS = {
    join: 0x2ecc71,
    leave: 0xe74c3c
};
const MODERATION_COLORS = {
    ban: 0xfc4343,
    tempban: 0xff6c4d,
    kick: 0xffc94d
};
const COUNTRY_FALLBACK_NAMES = {
    US: 'United States', CA: 'Canada', MX: 'Mexico', BR: 'Brazil', AR: 'Argentina',
    GB: 'United Kingdom', IE: 'Ireland', FR: 'France', DE: 'Germany', ES: 'Spain',
    PT: 'Portugal', IT: 'Italy', NL: 'Netherlands', BE: 'Belgium', CH: 'Switzerland',
    AT: 'Austria', PL: 'Poland', SE: 'Sweden', NO: 'Norway', FI: 'Finland',
    DK: 'Denmark', CZ: 'Czechia', RO: 'Romania', UA: 'Ukraine', RU: 'Russia',
    TR: 'Turkey', GR: 'Greece', AU: 'Australia', NZ: 'New Zealand', JP: 'Japan',
    KR: 'South Korea', CN: 'China', IN: 'India', ID: 'Indonesia', PH: 'Philippines',
    ZA: 'South Africa', EG: 'Egypt', SA: 'Saudi Arabia', AE: 'United Arab Emirates'
};

const init = (registerNotify, serviceResolver, configWrapper, scriptHelper) => {
    registerNotify('IManagementEventSubscriptions.ClientStateAuthorized', (event, _) => plugin.onJoin(event));
    registerNotify('IManagementEventSubscriptions.ClientStateDisposed', (event, _) => plugin.onLeave(event));
    registerNotify('IManagementEventSubscriptions.ClientPenaltyAdministered', (event, _) => plugin.onPenalty(event));
    registerNotify('IGameEventSubscriptions.ClientMessaged', (event, _) => plugin.onChat(event));

    plugin.onLoad(serviceResolver, configWrapper, scriptHelper);
    return plugin;
};

const plugin = {
    name: 'Server Event Webhook',
    author: 'Xenon Servers',
    version: '1.1.2',
    logger: null,
    scriptHelper: null,
    geoLocationService: null,
    configWrapper: null,
    recent: {},
    countryCache: {},
    config: {
        enabled: true,
        webhookConfigPath: 'Configuration/BetterIW4ToDiscord.json',
        webfrontBaseUrl: 'https://xenonservers.codewithstephen.com',
        reportMention: '@here',
        notifyJoins: true,
        notifyLeaves: true,
        notifyReports: true,
        notifyChat: true,
        notifyKicks: true,
        notifyTempBans: true,
        notifyBans: true,
        duplicateWindowSeconds: 10,
        clientMapPath: '/app/Logs/iw4m-client-map.json'
    },

    // Plugin lifecycle and event handlers
    onLoad: function (serviceResolver, configWrapper, scriptHelper) {
        this.logger = serviceResolver.resolveService('ILogger', ['ScriptPluginV2']);
        this.scriptHelper = scriptHelper;
        this.configWrapper = configWrapper;
        try {
            this.geoLocationService = serviceResolver.resolveService('IGeoLocationService');
        } catch (ex) {
            this.logger.logWarning('{Name} could not resolve IW4MAdmin geolocation service: {Message}', this.name, ex.message || ex);
        }

        const stored = this.configWrapper.getValue('config', updated => {
            if (updated) plugin.config = updated;
        });
        if (stored) this.config = Object.assign({}, this.config, stored);
        else this.configWrapper.setValue('config', this.config);

        this.logger.logInformation('{Name} {Version} loaded. Enabled={Enabled}', this.name, this.version, this.config.enabled);
    },

    onJoin: function (event) {
        if (!this.config.enabled || !this.config.notifyJoins) return;
        const client = this.value(event, 'client', 'Client');
        if (!client || this.isBot(client)) return;

        const server = this.server(client, event);
        this.publishConnection('join', client, server);
    },

    onLeave: function (event) {
        if (!this.config.enabled || !this.config.notifyLeaves) return;
        const client = this.value(event, 'client', 'Client');
        if (!client || this.isBot(client)) return;

        const server = this.server(client, event);
        this.publishConnection('leave', client, server);
    },

    onChat: function (event) {
        if (!this.config.enabled || !this.config.notifyChat) return;
        const client = this.value(event, 'client', 'Client', 'origin', 'Origin');
        const message = this.cleanChatMessage(this.value(event, 'message', 'Message', 'data', 'Data'));
        if (!client || this.isBot(client) || !message) return;

        const server = this.server(client, event);
        this.publishChat(client, server, message);
    },

    onPenalty: function (event) {
        if (!this.config.enabled) return;
        const penalty = this.value(event, 'penalty', 'Penalty');
        if (!penalty) return;

        const type = this.clean(this.value(penalty, 'type', 'Type', 'Penalty'));
        const normalized = type.toLowerCase().replace(/[ _-]/g, '');
        const isReport = normalized === 'report';
        const isKick = normalized === 'kick';
        const isTempBan = normalized === 'tempban' || normalized === 'temporaryban';
        const isBan = normalized === 'ban';
        if ((isReport && !this.config.notifyReports) ||
            (isKick && !this.config.notifyKicks) ||
            (isTempBan && !this.config.notifyTempBans) ||
            (isBan && !this.config.notifyBans) ||
            (!isReport && !isKick && !isTempBan && !isBan)) return;

        // Penalty offenders can be sparse database records after an automated kick.
        // Prefer the event's live target/client, then recover missing identity from the profile map.
        const eventClient = this.value(event, 'client', 'Client', 'target', 'Target');
        const client = this.hydrateClient(eventClient || this.value(penalty, 'offender', 'Offender'));
        if (!client || this.isBot(client)) return;
        const reason = this.clean(this.value(penalty, 'offense', 'Offense', 'automatedOffense', 'AutomatedOffense', 'No reason provided.'));
        const server = this.server(client, event);
        if (!isReport) {
            this.publishModeration(normalized, client, server, penalty, reason);
            return;
        }

        const actor = this.value(penalty, 'punisher', 'Punisher', 'admin', 'Admin') || this.value(event, 'origin', 'Origin');
        this.publish('ClientReport', 'New player report', 0xf1c40f, client, server, [
            this.field('Reporter', this.playerName(actor), true),
            this.field('Reason', reason, false),
            this.field('Server', this.serverName(server), false),
            this.field('Client ID', this.value(client, 'clientId', 'ClientId', 'N/A'), true)
        ], this.config.reportMention, normalized);
    },

    // Discord publishing
    publish: function (category, title, color, client, server, fields, mention, eventType) {
        const webhook = this.webhook(category);
        if (!webhook) {
            this.logger.logWarning('{Name}: no {Category} webhook is configured', this.name, category);
            return;
        }

        const signature = [eventType, this.value(client, 'clientId', 'ClientId', this.playerName(client)), this.serverName(server), fields.map(x => x.value).join('|')].join(':');
        if (this.isDuplicate(signature)) return;

        const body = {
            username: 'Xenon Server Events',
            content: mention || '',
            allowed_mentions: { parse: mention ? ['everyone'] : [] },
            embeds: [{
                title: title,
                description: `**${this.escape(this.playerName(client))}**`,
                color: color,
                fields: fields,
                timestamp: new Date().toISOString()
            }]
        };
        this.send(webhook, body, category);
    },

    publishConnection: function (eventType, client, server) {
        const webhook = this.webhook(CONNECTION_WEBHOOK);
        if (!webhook) {
            this.logger.logWarning('{Name}: no {Category} webhook is configured', this.name, CONNECTION_WEBHOOK);
            return;
        }

        const signature = [
            eventType,
            this.guid(client) || this.profileId(client) || this.playerName(client),
            this.serverName(server)
        ].join(':');
        if (this.isDuplicate(signature)) return;

        this.resolveCountry(client, country => {
            const body = plugin.buildConnectionWebhook(eventType, client, server, undefined, country);
            plugin.send(webhook, body, CONNECTION_WEBHOOK);
        });
    },

    publishModeration: function (actionType, client, server, penalty, reason) {
        const webhook = this.webhook('ClientPenalty');
        if (!webhook) {
            this.logger.logWarning('{Name}: no ClientPenalty webhook is configured', this.name);
            return;
        }
        const signature = [
            actionType,
            this.guid(client) || this.profileId(client) || this.playerName(client),
            this.serverName(server)
        ].join(':');
        if (this.isDuplicate(signature, actionType === 'kick' ? 60 : undefined)) return;

        this.resolveCountry(client, country => {
            const body = plugin.buildModerationWebhook(actionType, client, server, penalty, reason, undefined, country);
            plugin.send(webhook, body, 'ClientPenalty');
        });
    },

    publishChat: function (client, server, message) {
        const webhook = this.webhook(CHAT_WEBHOOK);
        if (!webhook) {
            this.logger.logWarning('{Name}: no {Category} webhook is configured', this.name, CHAT_WEBHOOK);
            return;
        }
        const signature = [
            'chat',
            this.guid(client) || this.profileId(client) || this.playerName(client),
            this.serverName(server),
            message
        ].join(':');
        if (this.isDuplicate(signature)) return;
        this.send(webhook, this.buildChatWebhook(client, server, message), CHAT_WEBHOOK);
    },

    resolveCountry: async function (client, callback) {
        const knownCountry = this.country(client);
        if (knownCountry) {
            callback(knownCountry);
            return;
        }

        const ip = this.clean(this.value(client, 'ipAddressString', 'IPAddressString'));
        if (ip && this.countryCache[ip]) {
            callback(this.countryCache[ip]);
            return;
        }
        if (!ip || !this.scriptHelper || typeof this.scriptHelper.getUrl !== 'function') {
            callback(UNKNOWN_COUNTRY);
            return;
        }

        // Match IW4MAdmin's profile country by using its local GeoLite service.
        // The external country-code lookup remains a fallback only.
        if (this.geoLocationService) {
            try {
                const locate = this.geoLocationService.locate || this.geoLocationService.Locate;
                const result = await locate.call(this.geoLocationService, ip);
                const country = this.countryFromResult(result);
                if (country) {
                    this.countryCache[ip] = country;
                    callback(country);
                    return;
                }
            } catch (ex) {
                this.logger.logWarning('{Name} local country lookup failed: {Message}', this.name, ex.message || ex);
            }
        }

        try {
            this.scriptHelper.getUrl(`https://ipinfo.io/${encodeURIComponent(ip)}/country`, result => {
                const country = plugin.countryFromCode(result) || UNKNOWN_COUNTRY;
                plugin.countryCache[ip] = country;
                callback(country);
            });
        } catch (ex) {
            this.logger.logWarning('{Name} could not resolve player country: {Message}', this.name, ex.message || ex);
            callback(UNKNOWN_COUNTRY);
        }
    },

    buildConnectionWebhook: function (eventType, client, server, timestamp, countryOverride) {
        const leaving = eventType === 'leave';
        const serverName = this.serverName(server);
        const playerMarkdown = this.playerMarkdown(client);
        const fields = [];

        this.addField(fields, 'Client ID', this.displayClientId(client), true);
        this.addField(fields, 'Country', countryOverride || this.country(client) || UNKNOWN_COUNTRY, true);

        if (leaving) {
            this.addField(fields, 'Session Time', this.sessionTime(client), true);
            this.addField(fields, 'Kills / Deaths / KD', this.combatStats(client), true);
        }

        return {
            username: 'Xenon Server Events',
            content: '',
            allowed_mentions: { parse: [] },
            embeds: [{
                title: leaving ? 'Player Left' : 'Player Joined',
                description: `${playerMarkdown} has ${leaving ? 'left' : 'joined'} **${this.escape(serverName)}**`,
                color: leaving ? CONNECTION_COLORS.leave : CONNECTION_COLORS.join,
                fields: fields,
                timestamp: timestamp || new Date().toISOString(),
                footer: { text: WEBHOOK_FOOTER }
            }]
        };
    },

    buildModerationWebhook: function (actionType, client, server, penalty, reason, timestamp, countryOverride) {
        const type = actionType === 'temporaryban' ? 'tempban' : actionType;
        const player = this.playerMarkdown(client);
        const serverName = this.serverName(server);
        const fields = [];
        const expiresAt = this.expirationTimestamp(penalty);
        const duration = this.penaltyDuration(penalty, timestamp);

        this.addField(fields, 'Client ID', this.displayClientId(client), true);
        this.addField(fields, 'Country', countryOverride || this.country(client) || UNKNOWN_COUNTRY, true);
        this.addField(fields, 'Server', serverName, false);

        if (type === 'tempban') {
            this.addField(fields, 'Duration', duration, false);
            this.addField(fields, 'Reason', reason || 'No reason provided.', false);
            if (expiresAt) this.addField(fields, 'Expires', `<t:${expiresAt}:F>`, false);
        } else if (type === 'kick') {
            this.addField(fields, 'Reason', reason || 'No reason provided.', false);
        }
        this.addField(fields, 'GUID', this.guid(client), false);

        const titles = { ban: 'Player Banned', tempban: 'Player Temp Banned', kick: 'Player Kicked' };
        const descriptions = {
            ban: `${player} permanently banned ${player}`,
            tempban: `${player} temporarily banned ${player}`,
            kick: `${player} was kicked from **${this.escape(serverName)}**`
        };
        return {
            username: 'Xenon Server Events',
            content: '',
            allowed_mentions: { parse: [] },
            embeds: [{
                title: titles[type],
                description: descriptions[type],
                color: MODERATION_COLORS[type],
                fields: fields,
                timestamp: timestamp || new Date().toISOString()
            }]
        };
    },

    buildChatWebhook: function (client, server, message, timestamp) {
        const profileUrl = this.profileUrl(client);
        const guid = this.guid(client);
        const label = `${this.playerName(client)}${guid ? ` (${guid})` : ''}`;
        const escapedLabel = this.escapePlayerLabel(label);
        const player = profileUrl ? `**[${escapedLabel}](${profileUrl})**` : `**${escapedLabel}**`;
        return {
            username: 'Xenon Server Events',
            content: '',
            allowed_mentions: { parse: [] },
            embeds: [{
                title: 'Chat Logs',
                description: `${player} chatted:\n\`${this.cleanChatMessage(message)}\``,
                color: 0xfafafa,
                fields: [{ name: 'Server', value: this.serverName(server), inline: false }],
                timestamp: timestamp || new Date().toISOString()
            }]
        };
    },

    webhook: function (category) {
        try {
            const raw = System.IO.File.ReadAllText(this.config.webhookConfigPath);
            const parsed = JSON.parse(raw);
            const hook = parsed && parsed.WebHooks ? parsed.WebHooks[category] : '';
            return typeof hook === 'string' && hook.indexOf('/api/webhooks/') >= 0 ? hook : '';
        } catch (ex) {
            this.logger.logError(ex, '{Name} failed to read webhook configuration', this.name);
            return '';
        }
    },

    send: function (webhook, body, category) {
        const script = importNamespace('IW4MAdmin.Application.Plugin.Script');
        const Headers = System.Collections.Generic.Dictionary(System.String, System.String);
        const request = new script.ScriptPluginWebRequest(webhook, JSON.stringify(body), 'POST', 'application/json', new Headers());
        try {
            this.scriptHelper.requestUrl(request, response => {
                const text = response === undefined || response === null ? '' : response.toString();
                if (text.indexOf('"code"') >= 0 || text.indexOf('Invalid Webhook') >= 0) {
                    plugin.logger.logWarning('{Name} {Category} webhook returned an error: {Response}', plugin.name, category, text);
                }
            });
        } catch (ex) {
            this.logger.logError(ex, '{Name} failed to send {Category} webhook', this.name, category);
        }
    },

    isDuplicate: function (signature, windowSeconds) {
        const now = Date.now();
        const windowMs = Math.max(1, Number(windowSeconds || this.config.duplicateWindowSeconds || 10)) * 1000;
        const duplicate = this.recent[signature] && now - this.recent[signature] < windowMs;
        this.recent[signature] = now;
        Object.keys(this.recent).forEach(key => {
            if (now - this.recent[key] > windowMs * 3) delete this.recent[key];
        });
        return duplicate;
    },

    // IW4MAdmin model extraction and formatting
    server: function (client, event) {
        return this.value(event, 'server', 'Server', 'owner', 'Owner') ||
            this.value(client, 'currentServer', 'CurrentServer');
    },

    hydrateClient: function (client) {
        if (!client) return client;
        const profileId = this.profileId(client);
        const currentName = this.playerName(client);
        let mappedGuid = '';
        let mappedClient = null;

        try {
            if (typeof System !== 'undefined' && profileId && System.IO.File.Exists(this.config.clientMapPath)) {
                const map = JSON.parse(String(System.IO.File.ReadAllText(this.config.clientMapPath)));
                const clients = map.clients || {};
                Object.keys(clients).some(guid => {
                    const candidate = clients[guid] || {};
                    if (String(candidate.clientId || '') !== String(profileId)) return false;
                    mappedGuid = guid;
                    mappedClient = candidate;
                    return true;
                });
            }
        } catch (ex) {
            if (this.logger) this.logger.logWarning('{Name} could not hydrate moderation client: {Message}', this.name, ex.message || ex);
        }

        if (!mappedClient) return client;
        const mappedName = this.clean(mappedClient.name || mappedClient.cleanedName || '');
        const usefulName = currentName && currentName.toLowerCase() !== 'unknown' ? currentName : mappedName;
        return {
            CleanedName: usefulName || 'Unknown',
            ClientId: profileId,
            NetworkId: mappedGuid || this.guid(client),
            ClientNumber: this.value(client, 'clientNumber', 'ClientNumber', 'slot', 'Slot'),
            IPAddressString: this.value(client, 'ipAddressString', 'IPAddressString'),
            Country: this.value(client, 'country', 'Country'),
            CountryCode: this.value(client, 'countryCode', 'CountryCode'),
            CurrentServer: this.value(client, 'currentServer', 'CurrentServer'),
            IsBot: this.value(client, 'isBot', 'IsBot', false)
        };
    },

    serverName: function (server) {
        return this.clean(this.value(server, 'hostname', 'Hostname', 'serverName', 'ServerName', 'id', 'Id', 'Unknown server'));
    },

    guid: function (client) {
        return this.clean(this.first(
            this.value(client, 'guid', 'Guid', 'networkId', 'NetworkId'),
            this.nestedValue(client, 'networkId.value'),
            this.nestedValue(client, 'NetworkId.Value')
        ));
    },

    profileId: function (client) {
        return this.clean(this.value(client, 'clientId', 'ClientId'));
    },

    displayClientId: function (client) {
        return this.clean(this.first(
            this.profileId(client),
            this.value(client, 'clientNumber', 'ClientNumber', 'slot', 'Slot')
        ));
    },

    profileUrl: function (client) {
        const profileId = this.profileId(client);
        const base = this.clean(this.config.webfrontBaseUrl).replace(/\/$/, '');
        return profileId && base ? `${base}/client/${encodeURIComponent(profileId)}` : '';
    },

    playerMarkdown: function (client) {
        const guid = this.guid(client);
        const label = `${this.playerName(client)}${guid ? ` (${guid})` : ''}`;
        const escaped = this.escapePlayerLabel(label);
        const url = this.profileUrl(client);
        return url ? `[**${escaped}**](${url})` : `**${escaped}**`;
    },

    country: function (client) {
        const code = this.clean(this.first(
            this.value(client, 'countryCode', 'CountryCode'),
            this.nestedValue(client, 'ipAddress.countryCode'),
            this.nestedValue(client, 'IPAddress.CountryCode'),
            this.nestedValue(client, 'location.countryCode'),
            this.nestedValue(client, 'Location.CountryCode')
        )).toUpperCase();
        const name = this.clean(this.first(
            this.value(client, 'country', 'Country'),
            this.nestedValue(client, 'ipAddress.country'),
            this.nestedValue(client, 'IPAddress.Country'),
            this.nestedValue(client, 'location.country'),
            this.nestedValue(client, 'Location.Country')
        ));
        const flag = /^[A-Z]{2}$/.test(code)
            ? String.fromCodePoint(code.charCodeAt(0) + 127397, code.charCodeAt(1) + 127397)
            : '';
        return [name || code, flag].filter(Boolean).join(' ');
    },

    countryFromResult: function (result) {
        if (!result) return '';
        const code = this.clean(this.value(result, 'countryCode', 'CountryCode')).toUpperCase();
        const name = this.clean(this.value(result, 'country', 'Country'));
        if (!name && code) return this.countryFromCode(code);
        const flag = /^[A-Z]{2}$/.test(code)
            ? String.fromCodePoint(code.charCodeAt(0) + 127397, code.charCodeAt(1) + 127397)
            : '';
        return [name, flag].filter(Boolean).join(' ');
    },

    countryFromCode: function (value) {
        const code = this.clean(value).toUpperCase();
        if (!/^[A-Z]{2}$/.test(code)) return '';
        const flag = String.fromCodePoint(code.charCodeAt(0) + 127397, code.charCodeAt(1) + 127397);
        let name = '';
        try {
            if (typeof System !== 'undefined' && System.Globalization && System.Globalization.RegionInfo) {
                const RegionInfo = System.Globalization.RegionInfo;
                name = this.clean(new RegionInfo(code).EnglishName);
            }
        } catch (_) {
            name = '';
        }
        return `${name || COUNTRY_FALLBACK_NAMES[code] || code} ${flag}`;
    },

    expirationTimestamp: function (penalty) {
        const expires = this.value(penalty, 'expires', 'Expires', 'expiration', 'Expiration');
        if (!this.present(expires)) return null;
        const milliseconds = new Date(expires.toString()).getTime();
        return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
    },

    penaltyDuration: function (penalty, fallbackStart) {
        const expiresAt = this.expirationTimestamp(penalty);
        if (!expiresAt) return '';
        const issued = this.value(penalty, 'when', 'When', 'issuedAt', 'IssuedAt');
        const issuedAt = new Date((issued || fallbackStart || new Date()).toString()).getTime();
        if (!Number.isFinite(issuedAt)) return '';
        return this.formatLongDuration(expiresAt - Math.floor(issuedAt / 1000));
    },

    formatLongDuration: function (seconds) {
        let remaining = Math.max(0, Math.round(Number(seconds) || 0));
        const units = [
            ['year', 365 * 24 * 60 * 60],
            ['week', 7 * 24 * 60 * 60],
            ['day', 24 * 60 * 60],
            ['hour', 60 * 60],
            ['minute', 60]
        ];
        const parts = [];
        for (let i = 0; i < units.length && parts.length < 2; i++) {
            const count = Math.floor(remaining / units[i][1]);
            if (!count) continue;
            parts.push(`${count} ${units[i][0]}${count === 1 ? '' : 's'}`);
            remaining -= count * units[i][1];
        }
        return parts.join(' ') || 'Less than 1 minute';
    },

    sessionTime: function (client) {
        const direct = this.first(
            this.value(client, 'sessionTime', 'SessionTime', 'timeConnected', 'TimeConnected'),
            this.nestedValue(client, 'stats.sessionTime'),
            this.nestedValue(client, 'Stats.SessionTime')
        );
        if (direct !== undefined && direct !== null && direct !== '') {
            if (typeof direct === 'number') return this.formatDuration(direct > 86400 ? direct / 1000 : direct);
            const text = this.clean(direct);
            if (text) return text;
        }
        const connectedAt = this.first(
            this.value(client, 'connectionTime', 'ConnectionTime', 'connectedAt', 'ConnectedAt'),
            this.nestedValue(client, 'currentSession.startTime'),
            this.nestedValue(client, 'CurrentSession.StartTime')
        );
        const started = connectedAt ? new Date(connectedAt).getTime() : NaN;
        return Number.isFinite(started) ? this.formatDuration((Date.now() - started) / 1000) : '';
    },

    combatStats: function (client) {
        const kills = this.first(
            this.value(client, 'kills', 'Kills'), this.nestedValue(client, 'stats.kills'), this.nestedValue(client, 'Stats.Kills'));
        const deaths = this.first(
            this.value(client, 'deaths', 'Deaths'), this.nestedValue(client, 'stats.deaths'), this.nestedValue(client, 'Stats.Deaths'));
        if (!this.present(kills) || !this.present(deaths)) return '';
        const k = Number(kills);
        const d = Number(deaths);
        if (!Number.isFinite(k) || !Number.isFinite(d)) return '';
        return `${k} / ${d} / ${(d > 0 ? k / d : k).toFixed(2)}`;
    },

    formatDuration: function (seconds) {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const secs = total % 60;
        if (hours) return `${hours}h ${minutes}m`;
        if (minutes) return `${minutes}m ${secs}s`;
        return `${secs}s`;
    },

    playerName: function (client) {
        return this.clean(this.value(client, 'cleanedName', 'CleanedName', 'name', 'Name', 'Unknown'));
    },

    isBot: function (client) {
        return Boolean(this.value(client, 'isBot', 'IsBot', false));
    },

    // Generic value and Discord formatting helpers
    field: function (name, value, inline) {
        return { name: name, value: this.clean(value) || 'N/A', inline: inline };
    },

    addField: function (fields, name, value, inline) {
        const cleaned = this.clean(value);
        if (cleaned) fields.push({ name: name, value: cleaned, inline: inline });
    },

    present: function (value) {
        return value !== undefined && value !== null && value !== '';
    },

    first: function () {
        for (let i = 0; i < arguments.length; i++) {
            if (this.present(arguments[i])) return arguments[i];
        }
        return undefined;
    },

    nestedValue: function (object, path) {
        if (!object) return undefined;
        const parts = String(path).split('.');
        let value = object;
        for (let i = 0; i < parts.length; i++) {
            if (value === undefined || value === null) return undefined;
            value = value[parts[i]];
        }
        return value;
    },

    value: function (object) {
        if (!object) return arguments.length % 2 === 0 ? arguments[arguments.length - 1] : undefined;
        const keys = Array.prototype.slice.call(arguments, 1);
        const hasFallback = keys.length % 2 === 1;
        const limit = hasFallback ? keys.length - 1 : keys.length;
        for (let i = 0; i < limit; i++) {
            if (object[keys[i]] !== undefined && object[keys[i]] !== null) return object[keys[i]];
        }
        return hasFallback ? keys[keys.length - 1] : undefined;
    },

    clean: function (value) {
        return value === undefined || value === null ? '' : value.toString()
            .replace(/\^[0-9:;]/g, '')
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
            .trim()
            .slice(0, 1000);
    },

    escape: function (value) {
        return this.clean(value).replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, '\\$1');
    },

    escapePlayerLabel: function (value) {
        // Discord link labels do not need ordinary username punctuation escaped.
        // Replace structural brackets instead of emitting visible backslashes.
        return this.clean(value)
            .replace(/\\/g, '/')
            .replace(/\[/g, '(')
            .replace(/\]/g, ')');
    },

    cleanChatMessage: function (value) {
        return this.clean(value)
            .replace(/`/g, "'")
            .replace(/\s+/g, ' ')
            .slice(0, 900);
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = plugin;
