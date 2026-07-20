const init = (registerNotify, serviceResolver, configWrapper, scriptHelper) => {
    registerNotify('IManagementEventSubscriptions.ClientStateAuthorized', (event, _) => plugin.onJoin(event));
    registerNotify('IManagementEventSubscriptions.ClientStateDisposed', (event, _) => plugin.onLeave(event));
    registerNotify('IManagementEventSubscriptions.ClientPenaltyAdministered', (event, _) => plugin.onPenalty(event));

    plugin.onLoad(serviceResolver, configWrapper, scriptHelper);
    return plugin;
};

const plugin = {
    name: 'Server Event Webhook',
    author: 'Xenon Servers',
    version: '1.0.0',
    logger: null,
    scriptHelper: null,
    configWrapper: null,
    recent: {},
    config: {
        enabled: true,
        webhookConfigPath: 'Configuration/BetterIW4ToDiscord.json',
        reportMention: '@here',
        notifyJoins: true,
        notifyLeaves: true,
        notifyReports: true,
        notifyKicks: true,
        notifyTempBans: true,
        notifyBans: true,
        duplicateWindowSeconds: 10
    },

    onLoad: function (serviceResolver, configWrapper, scriptHelper) {
        this.logger = serviceResolver.resolveService('ILogger', ['ScriptPluginV2']);
        this.scriptHelper = scriptHelper;
        this.configWrapper = configWrapper;

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
        this.publish('ClientConnection', 'Player joined', 0x2ecc71, client, server, [
            this.field('Server', this.serverName(server), false),
            this.field('Client ID', this.value(client, 'clientId', 'ClientId', 'N/A'), true),
            this.field('Ping', this.value(client, 'ping', 'Ping', 'N/A'), true)
        ], '', 'join');
    },

    onLeave: function (event) {
        if (!this.config.enabled || !this.config.notifyLeaves) return;
        const client = this.value(event, 'client', 'Client');
        if (!client || this.isBot(client)) return;

        const server = this.server(client, event);
        this.publish('ClientConnection', 'Player left', 0x95a5a6, client, server, [
            this.field('Server', this.serverName(server), false),
            this.field('Client ID', this.value(client, 'clientId', 'ClientId', 'N/A'), true)
        ], '', 'leave');
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

        const client = this.value(penalty, 'offender', 'Offender') || this.value(event, 'client', 'Client', 'target', 'Target');
        if (!client || this.isBot(client)) return;
        const actor = this.value(penalty, 'punisher', 'Punisher', 'admin', 'Admin') || this.value(event, 'origin', 'Origin');
        const reason = this.clean(this.value(penalty, 'offense', 'Offense', 'automatedOffense', 'AutomatedOffense', 'No reason provided'));
        const server = this.server(client, event);
        const category = isReport ? 'ClientReport' : 'ClientPenalty';
        const title = isReport ? 'New player report' : (isTempBan ? 'Player temporarily banned' : (isBan ? 'Player banned' : 'Player kicked'));
        const color = isReport ? 0xf1c40f : (isKick ? 0xe67e22 : 0xe74c3c);
        const mention = isReport ? this.config.reportMention : '';

        this.publish(category, title, color, client, server, [
            this.field(isReport ? 'Reporter' : 'Admin', this.playerName(actor), true),
            this.field('Reason', reason, false),
            this.field('Server', this.serverName(server), false),
            this.field('Client ID', this.value(client, 'clientId', 'ClientId', 'N/A'), true)
        ], mention, normalized);
    },

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

    isDuplicate: function (signature) {
        const now = Date.now();
        const windowMs = Math.max(1, Number(this.config.duplicateWindowSeconds || 10)) * 1000;
        const duplicate = this.recent[signature] && now - this.recent[signature] < windowMs;
        this.recent[signature] = now;
        Object.keys(this.recent).forEach(key => {
            if (now - this.recent[key] > windowMs * 3) delete this.recent[key];
        });
        return duplicate;
    },

    server: function (client, event) {
        return this.value(client, 'currentServer', 'CurrentServer') || this.value(event, 'server', 'Server');
    },

    serverName: function (server) {
        return this.clean(this.value(server, 'hostname', 'Hostname', 'serverName', 'ServerName', 'id', 'Id', 'Unknown server'));
    },

    playerName: function (client) {
        return this.clean(this.value(client, 'cleanedName', 'CleanedName', 'name', 'Name', 'Unknown'));
    },

    isBot: function (client) {
        return Boolean(this.value(client, 'isBot', 'IsBot', false));
    },

    field: function (name, value, inline) {
        return { name: name, value: this.clean(value) || 'N/A', inline: inline };
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
    }
};
