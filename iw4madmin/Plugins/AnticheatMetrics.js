const anticheatNavKey = 'Webfront::Nav::Admin::Anticheat';

const init = (registerNotify, serviceResolver, configWrapper, pluginHelper) => {
    registerNotify('IManagementEventSubscriptions.ClientPenaltyAdministered', (penaltyEvent, token) => plugin.onPenalty(penaltyEvent, token));

    plugin.onLoad(serviceResolver, configWrapper, pluginHelper);
    return plugin;
};

const plugin = {
    author: 'Local',
    version: '1.0.0',
    name: 'Anticheat Metrics',
    logger: null,
    config: null,
    helper: null,
    manager: null,
    settings: {
        logPath: '/app/Logs/anti-cheat-combined.log',
        maxItems: 75,
        sendDiscordForAutomatedBans: true,
        webhookUrl: '',
        cwsSettingsPath: '/app/Configuration/cws/Settings.json',
        clientMapPath: '/app/Logs/iw4m-client-map.json',
        watchStatePath: '/app/Logs/anticheat-watch-actions.json',
        iw4mDatabasePath: '/app/Database/Database.db',
        iw4mFlagRequestPath: '/app/Logs/anticheat-iw4m-flag-requests.jsonl',
        iw4mFlagPenaltyType: 2,
        iw4mFlagPunisherId: 1,
        dashboardBaseUrl: '',
        mention: '@here'
    },

    commands: [{
        name: 'acwatch',
        description: 'marks an anti-cheat case as watched and flags the player in IW4MAdmin',
        alias: 'acw',
        permission: 'Moderator',
        targetRequired: false,
        arguments: [{
            name: 'caseId',
            required: true
        }],
        execute: gameEvent => plugin.handleWatchCommand(gameEvent)
    }],

    interactions: [{
        name: anticheatNavKey,
        action: (_, __, ___) => plugin.buildInteraction()
    }],

    onLoad: function (serviceResolver, configWrapper, pluginHelper) {
        this.config = configWrapper;
        this.helper = pluginHelper;
        this.logger = serviceResolver.resolveService('ILogger', ['ScriptPluginV2']);
        this.manager = serviceResolver.resolveService('IManager');
        this.config.setName(this.name);

        const configured = this.config.getValue('Settings');
        if (configured !== undefined && configured !== null) {
            this.settings = Object.assign({}, this.settings, this.toPlainObject(configured));
        }
        this.config.setValue('Settings', this.settings);

        const interactionRegistration = serviceResolver.resolveService('IInteractionRegistration');
        interactionRegistration.unregisterInteraction(anticheatNavKey);

        this.logger.logInformation('{Name} loaded. LogPath={LogPath}', this.name, this.settings.logPath);
    },

    onPenalty: function (penaltyEvent, _) {
        const penalty = penaltyEvent && penaltyEvent.penalty;
        const client = penaltyEvent && (penaltyEvent.client || penaltyEvent.target || penaltyEvent.Target || (penalty && penalty.offender));

        if (!penalty || !client) {
            return;
        }

        const type = this.clean(penalty.type || penalty.Type || '');
        if (type !== 'Ban' && type !== 'TempBan') {
            return;
        }

        const automatedReason = this.automatedBanReason(penalty, penaltyEvent);
        if (!this.isAutomatedBan(penalty, penaltyEvent, automatedReason)) {
            return;
        }

        const event = this.buildAutomatedBanEvent(type, penalty, penaltyEvent, client, automatedReason);
        this.appendAutomatedBanLog(event);

        if (this.settings.sendDiscordForAutomatedBans) {
            this.sendAutomatedBanDiscord(event);
        }
    },

    buildInteraction: function () {
        const helpers = importNamespace('SharedLibraryCore.Helpers');
        const interactionData = new helpers.InteractionData();

        interactionData.name = 'Anticheat';
        interactionData.description = 'Recent anti-cheat suspicion alerts';
        interactionData.displayMeta = 'ph-shield-warning';
        interactionData.interactionId = anticheatNavKey;
        interactionData.minimumPermission = 2;
        interactionData.interactionType = 2;
        interactionData.source = this.name;

        const render = (sourceId, targetId, game, meta, token) => plugin.renderPage(meta, sourceId);
        interactionData.ScriptAction = render;
        interactionData.scriptAction = render;

        return interactionData;
    },

    renderPage: function (meta, originId) {
        const actionResult = this.handleDashboardAction(meta, originId);
        const items = this.readEvents();
        const cases = this.buildCases(items);
        const stats = this.dashboardStats(cases, items);
        const openCaseId = this.clean(this.metaValue(meta, 'acCase'), '');

        if (openCaseId) {
            return this.renderCaseProfile(openCaseId, cases, actionResult);
        }

        let html = `
            <div id="anticheat-metrics-panel" class="ac-dashboard">
                ${this.dashboardStyles()}
                ${actionResult ? this.actionNotice(actionResult) : ''}
                <header class="ac-page-header">
                    <div>
                        <h1 class="ac-title">Anti-cheat Review</h1>
                        <p class="ac-subtitle">Suspicion queue from IW4X telemetry and IW4MAdmin actions.</p>
                    </div>
                    <div class="ac-header-meta">
                        <div class="ac-health ${stats.staleTelemetry > 0 ? 'is-warning' : 'is-good'}">
                            <span class="ac-health-dot"></span>
                            <span>${stats.staleTelemetry > 0 ? `${this.escape(stats.staleTelemetry)} stale telemetry ${stats.staleTelemetry === 1 ? 'case' : 'cases'}` : 'Telemetry healthy'}</span>
                        </div>
                        <span id="ac-last-updated">Last updated: just now</span>
                        <span id="ac-auto-status">Auto-refresh: On</span>
                    </div>
                </header>
                <section class="ac-metrics-strip">
                    ${this.statCard('Needs Review', stats.needsReview, 'Check soon.', 'orange')}
                    ${this.statCard('High Priority', stats.highPriority, 'Strong signals.', 'red')}
                    ${this.statCard('Watching', stats.watching, 'Low priority.', 'blue')}
                    ${this.statCard('Reports Today', stats.reportsToday, stats.reportsToday > 0 ? 'Linked today.' : 'No reports linked today.', 'slate')}
                    ${this.statCard('Stale Telemetry', stats.staleTelemetry, stats.staleTelemetry > 0 ? 'Needs attention.' : 'Healthy.', stats.staleTelemetry > 0 ? 'orange' : 'green')}
                    ${this.statCard('Actions Taken', stats.actionsTaken, 'Already logged.', 'green')}
                </section>
                <section class="ac-queue">
                    <div class="ac-toolbar">
                        <div>
                            <h2 class="ac-section-title">Review Queue</h2>
                            <p class="ac-section-subtitle">${cases.length} ${cases.length === 1 ? 'case' : 'cases'} grouped by player, server, and GUID.</p>
                        </div>
                        <div class="ac-controls">
                            <label class="ac-control">
                                <span>Filter</span>
                                <select id="ac-filter">
                                        <option value="all">All</option>
                                        <option value="needs-review">Needs Review</option>
                                        <option value="high-priority">High Priority</option>
                                        <option value="watching">Watching</option>
                                        <option value="hard">Hard Detections</option>
                                        <option value="soft">Soft Suspicion</option>
                                        <option value="reports">Reports</option>
                                </select>
                            </label>
                            <label class="ac-control">
                                <span>Sort</span>
                                <select id="ac-sort">
                                        <option value="risk">Highest Risk</option>
                                        <option value="confidence">Highest Confidence</option>
                                        <option value="reports">Most Reports</option>
                                        <option value="recent">Most Recent</option>
                                </select>
                            </label>
                            <div class="ac-toolbar-actions">
                                <button id="ac-refresh-now" type="button">Refresh now</button>
                                <button id="ac-auto-toggle" type="button" aria-pressed="true">Pause auto-refresh</button>
                            </div>
                        </div>
                    </div>`;

        if (cases.length === 0) {
            html += `
                <div class="ac-empty">
                    <i class="ph ph-shield-check"></i>
                    <div>No anti-cheat review cases were found.</div>
                    <p>New suspicion, reports, or IW4MAdmin actions will appear here automatically.</p>
                </div>`;
        } else {
            html += '<div id="ac-case-list" class="ac-case-list">';
            cases.forEach(item => {
                html += this.caseCard(item);
            });
            html += '</div>';
        }

        html += `
                </section>
            </div>
            <script>
                (() => {
                    const key = 'xenon-anticheat-refresh-timer';
                    const stateKey = 'xenon-anticheat-dashboard-state';
                    const nowKey = 'xenon-anticheat-last-updated';

                    const defaultState = {
                        filter: 'all',
                        sort: 'risk',
                        autoRefresh: true,
                        expanded: {},
                        scrollY: 0
                    };

                    const loadState = () => {
                        try {
                            return Object.assign({}, defaultState, JSON.parse(localStorage.getItem(stateKey) || '{}'));
                        } catch (_) {
                            return Object.assign({}, defaultState);
                        }
                    };

                    const saveState = next => {
                        const state = Object.assign(loadState(), next || {});
                        try {
                            localStorage.setItem(stateKey, JSON.stringify(state));
                        } catch (_) {}
                        return state;
                    };

                    const captureState = () => {
                        const filter = document.getElementById('ac-filter');
                        const sort = document.getElementById('ac-sort');
                        const expanded = {};
                        document.querySelectorAll('#anticheat-metrics-panel details[data-ac-expand]').forEach(detail => {
                            const id = detail.getAttribute('data-ac-expand');
                            if (id) {
                                expanded[id] = detail.open;
                            }
                        });

                        return saveState({
                            filter: filter ? filter.value : loadState().filter,
                            sort: sort ? sort.value : loadState().sort,
                            expanded: expanded,
                            scrollY: window.scrollY
                        });
                    };

                    const formatLocalTimes = () => {
                        const formatter = new Intl.DateTimeFormat(undefined, {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            fractionalSecondDigits: 3,
                            timeZoneName: 'short'
                        });

                        document.querySelectorAll('#anticheat-metrics-panel .js-local-time').forEach(element => {
                            const value = element.getAttribute('datetime');
                            const date = new Date(value);
                            if (!Number.isNaN(date.getTime())) {
                                element.textContent = formatter.format(date);
                                element.title = value;
                            }
                        });
                    };

                    const updateLastUpdated = () => {
                        const label = document.getElementById('ac-last-updated');
                        const last = Number(localStorage.getItem(nowKey) || Date.now());
                        const seconds = Math.max(0, Math.round((Date.now() - last) / 1000));
                        if (label) {
                            label.textContent = seconds <= 1 ? 'Last updated: just now' : 'Last updated: ' + seconds + 's ago';
                        }
                    };

                    const applyControls = () => {
                        const state = loadState();
                        const filter = document.getElementById('ac-filter');
                        const sort = document.getElementById('ac-sort');
                        const list = document.getElementById('ac-case-list');
                        if (!filter || !sort || !list) {
                            return;
                        }

                        filter.value = state.filter || 'all';
                        sort.value = state.sort || 'risk';

                        const cards = Array.from(list.querySelectorAll('[data-ac-case]'));
                        let visibleCount = 0;
                        cards.forEach(card => {
                            const status = card.getAttribute('data-status') || '';
                            const kind = card.getAttribute('data-kind') || '';
                            const reports = Number(card.getAttribute('data-reports') || '0');
                            const hard = card.getAttribute('data-hard') === 'true';
                            let visible = true;

                            if (filter.value === 'needs-review') visible = status === 'Needs Review';
                            else if (filter.value === 'high-priority') visible = status === 'High Priority';
                            else if (filter.value === 'watching') visible = status === 'Watching';
                            else if (filter.value === 'hard') visible = hard;
                            else if (filter.value === 'soft') visible = !hard && kind !== 'AUTO_BAN' && kind !== 'AUTO_TEMPBAN';
                            else if (filter.value === 'reports') visible = reports > 0;

                            card.style.display = visible ? '' : 'none';
                            if (visible) {
                                visibleCount++;
                            }
                        });

                        const field = sort.value;
                        cards.sort((a, b) => {
                            const numberAttr = name => Number((field === name ? b : a).getAttribute('data-' + name) || '0');
                            if (field === 'confidence') return Number(b.getAttribute('data-confidence') || '0') - Number(a.getAttribute('data-confidence') || '0');
                            if (field === 'reports') return Number(b.getAttribute('data-reports') || '0') - Number(a.getAttribute('data-reports') || '0');
                            if (field === 'recent') return Number(b.getAttribute('data-time') || '0') - Number(a.getAttribute('data-time') || '0');
                            return Number(b.getAttribute('data-risk') || '0') - Number(a.getAttribute('data-risk') || '0');
                        });

                        cards.forEach(card => list.appendChild(card));

                        document.querySelectorAll('#anticheat-metrics-panel details[data-ac-expand]').forEach(detail => {
                            const id = detail.getAttribute('data-ac-expand');
                            if (id && Object.prototype.hasOwnProperty.call(state.expanded || {}, id)) {
                                detail.open = !!state.expanded[id];
                            }
                        });

                        let empty = document.getElementById('ac-filter-empty');
                        if (!empty) {
                            empty = document.createElement('div');
                            empty.id = 'ac-filter-empty';
                            empty.className = 'ac-empty ac-filter-empty';
                            empty.innerHTML = '<i class="ph ph-funnel"></i><div>No cases match this filter.</div><p>Try a different filter or sorting option.</p>';
                            list.parentNode.insertBefore(empty, list.nextSibling);
                        }
                        empty.style.display = visibleCount === 0 ? '' : 'none';

                        const autoStatus = document.getElementById('ac-auto-status');
                        const autoToggle = document.getElementById('ac-auto-toggle');
                        if (autoStatus) {
                            autoStatus.textContent = 'Auto-refresh: ' + (state.autoRefresh ? 'On' : 'Off');
                        }
                        if (autoToggle) {
                            autoToggle.textContent = state.autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh';
                            autoToggle.setAttribute('aria-pressed', state.autoRefresh ? 'true' : 'false');
                        }

                        formatLocalTimes();
                        updateLastUpdated();
                    };

                    const bindControls = () => {
                        const filter = document.getElementById('ac-filter');
                        const sort = document.getElementById('ac-sort');
                        const refresh = document.getElementById('ac-refresh-now');
                        const auto = document.getElementById('ac-auto-toggle');

                        filter?.addEventListener('change', () => {
                            saveState({ filter: filter.value });
                            applyControls();
                        });

                        sort?.addEventListener('change', () => {
                            saveState({ sort: sort.value });
                            applyControls();
                        });

                        document.querySelectorAll('#anticheat-metrics-panel details[data-ac-expand]').forEach(detail => {
                            detail.addEventListener('toggle', () => captureState());
                        });

                        refresh?.addEventListener('click', () => refreshPanel(true));
                        auto?.addEventListener('click', () => {
                            const state = loadState();
                            saveState({ autoRefresh: !state.autoRefresh });
                            applyControls();
                        });

                        document.querySelectorAll('#anticheat-metrics-panel button[data-ac-watch-action]').forEach(button => {
                            button.addEventListener('click', () => runCaseAction(button, button.getAttribute('data-ac-watch-action') || 'watch'));
                        });
                        document.querySelectorAll('#anticheat-metrics-panel button[data-ac-clear]').forEach(button => {
                            button.addEventListener('click', () => runCaseAction(button, 'clear'));
                        });
                        document.querySelectorAll('#anticheat-metrics-panel button[data-ac-review]').forEach(button => {
                            button.addEventListener('click', () => runCaseAction(button, 'send-review'));
                        });
                        document.querySelectorAll('#anticheat-metrics-panel button[data-ac-open]').forEach(button => {
                            button.addEventListener('click', () => {
                                const caseId = button.getAttribute('data-case-id') || '';
                                if (caseId) {
                                    window.location.href = actionUrl({ acCase: caseId });
                                }
                            });
                        });
                    };

                    const actionUrl = params => {
                        const url = new URL(window.location.href);
                        Object.keys(params || {}).forEach(key => url.searchParams.set(key, params[key]));
                        url.searchParams.set('_', Date.now().toString());
                        return url.toString();
                    };

                    const runCaseAction = (button, action) => {
                        if (!button || button.disabled) {
                            return;
                        }

                        const caseId = button.getAttribute('data-case-id') || '';
                        if (!caseId) {
                            return;
                        }

                        if (action === 'clear' && !window.confirm('Mark this anti-cheat case as cleared? Evidence will be kept.')) {
                            return;
                        }
                        if (action === 'send-review' && !window.confirm('Send this case to the Discord staff review webhook?')) {
                            return;
                        }

                        const previous = button.textContent;
                        button.disabled = true;
                        button.textContent = action === 'watch' ? 'Watching...' : (action === 'unwatch' ? 'Removing...' : (action === 'clear' ? 'Clearing...' : 'Sending...'));

                        const stateBefore = captureState();
                        fetch(actionUrl({ acAction: action, caseId: caseId }), { cache: 'no-store', credentials: 'same-origin' })
                            .then(response => response.text())
                            .then(html => {
                                const doc = new DOMParser().parseFromString(html, 'text/html');
                                const nextPanel = doc.getElementById('anticheat-metrics-panel');
                                const currentPanel = document.getElementById('anticheat-metrics-panel');
                                if (nextPanel && currentPanel) {
                                    currentPanel.replaceWith(nextPanel);
                                    localStorage.setItem(nowKey, String(Date.now()));
                                    bindControls();
                                    applyControls();
                                    window.scrollTo({ top: stateBefore.scrollY || window.scrollY, behavior: 'auto' });
                                } else {
                                    button.disabled = false;
                                    button.textContent = previous;
                                }
                            })
                            .catch(() => {
                                button.disabled = false;
                                button.textContent = previous;
                            });
                    };

                    const refreshPanel = manual => {
                        const panel = document.getElementById('anticheat-metrics-panel');
                        if (!panel) {
                            return;
                        }

                        const stateBefore = captureState();
                        fetch(window.location.href, { cache: 'no-store', credentials: 'same-origin' })
                            .then(response => response.text())
                            .then(html => {
                                const doc = new DOMParser().parseFromString(html, 'text/html');
                                const nextPanel = doc.getElementById('anticheat-metrics-panel');
                                const currentPanel = document.getElementById('anticheat-metrics-panel');
                                if (nextPanel && currentPanel) {
                                    currentPanel.replaceWith(nextPanel);
                                    localStorage.setItem(nowKey, String(Date.now()));
                                    bindControls();
                                    applyControls();
                                    window.scrollTo({ top: stateBefore.scrollY || window.scrollY, behavior: 'auto' });
                                }
                            })
                            .catch(() => {});
                    };

                    if (!localStorage.getItem(nowKey)) {
                        localStorage.setItem(nowKey, String(Date.now()));
                    }

                    bindControls();
                    applyControls();
                    setInterval(updateLastUpdated, 1000);

                    if (window[key]) {
                        clearInterval(window[key]);
                    }

                    window[key] = setInterval(() => {
                        const panel = document.getElementById('anticheat-metrics-panel');
                        if (!panel) {
                            clearInterval(window[key]);
                            window[key] = null;
                            return;
                        }

                        if (loadState().autoRefresh) {
                            refreshPanel(false);
                        }
                    }, 10000);
                })();
            </script>`;

        return html;
    },

    actionNotice: function (result) {
        if (!result) {
            return '';
        }

        const success = !!result.success;
        const message = result.message || (success ? 'Player marked as Watch.' : 'Unable to update Watch status.');
        const detail = result.detail || '';

        return `
            <div class="ac-action-notice ${success ? 'is-success' : 'is-warning'}" role="status">
                <div>${this.escape(message)}</div>
                ${detail ? `<p>${this.escape(detail)}</p>` : ''}
            </div>`;
    },

    statCard: function (label, value, subtitle, tone) {
        const toneClass = tone || 'muted';
        return `
            <div class="ac-stat ac-tone-${this.escape(toneClass)}">
                <div class="ac-stat-label">${this.escape(label)}</div>
                <div class="ac-stat-value">${this.escape(value)}</div>
                <div class="ac-stat-desc">${this.escape(subtitle || '')}</div>
            </div>`;
    },

    caseCard: function (item) {
        const status = this.caseStatus(item);
        const risk = this.riskInfo(item);
        const confidence = this.confidenceInfo(item);
        const reason = this.plainReason(item);
        const action = this.recommendedAction(item, status, confidence);
        const discord = this.discordStatus(item);
        const discordNote = this.discordEvidenceNote(discord);
        const hard = (item.hardDetectionCount || 0) > 0 || this.isHardDetection(item.latest);
        const actionLabel = this.shortActionLabel(action, status, hard);
        const accent = this.caseAccent(status);
        const evidenceType = hard
            ? (item.kind === 'AUTO_BAN' || item.kind === 'AUTO_TEMPBAN' ? 'IW4MAdmin action' : 'Hard detection')
            : (item.reports > 0 ? 'Reports linked' : 'Soft suspicion');
        const rawReasons = item.reasons.length
            ? item.reasons.slice(0, 8).map(reason => `<li>${this.escape(reason)}</li>`).join('')
            : '<li>No raw reason text was logged.</li>';
        const reports = Number(item.reports || 0);
        const timeValue = Date.parse(item.time || '') || 0;
        const caseKey = this.caseKey(item);
        const watchLabel = status === 'Watching' ? 'Undo Watch' : 'Watch';
        const watchAction = status === 'Watching' ? 'unwatch' : 'watch';
        const reviewSent = item.review && (item.review.sentAt || item.review.lastAttemptAt);
        const reviewLabel = reviewSent ? 'Review Sent' : 'Send Review';

        return `
            <div data-ac-case="true"
                 data-case-key="${this.escape(caseKey)}"
                 data-status="${this.escape(status)}"
                 data-kind="${this.escape(item.kind || '')}"
                 data-hard="${hard ? 'true' : 'false'}"
                 data-risk="${this.escape(risk.score)}"
                 data-confidence="${this.escape(confidence.score)}"
                 data-reports="${this.escape(reports)}"
                 data-time="${this.escape(timeValue)}"
                 class="ac-case ac-accent-${this.escape(accent)}">
                <div class="ac-case-summary">
                    <div class="ac-case-person">
                        <div class="ac-person-title">
                            ${this.playerLink(item)}
                            <span class="${this.badgeClass(status)}">${this.escape(status)}</span>
                        </div>
                        <div class="ac-muted-line">GUID ${this.escape(item.guid || 'Unknown')}</div>
                        <div class="ac-muted-line">${this.escape(item.server || item.serverKey || 'Unknown server')} · ${this.escape(item.map || 'Unknown map')} · ${this.localTimeElement(item.time, item.displayTime)}</div>
                    </div>
                    <div class="ac-case-main">
                        <div class="ac-badges">
                            <span class="${this.badgeClass('Risk ' + risk.label)}">Risk ${this.escape(risk.label)}</span>
                            <span class="${this.badgeClass('Confidence ' + confidence.label)}">Confidence ${this.escape(confidence.label)}</span>
                        </div>
                        <p>${this.escape(reason)}</p>
                        <div class="ac-status-row">
                            <span>${this.escape(evidenceType)}</span>
                            <span>${this.escape(actionLabel)}</span>
                        </div>
                    </div>
                    <div class="ac-case-aside">
                        <div class="ac-mini-metrics">
                            ${this.miniMetric('Risk', risk.score + '/100', risk.tone)}
                            ${this.miniMetric('Confidence', confidence.label, confidence.tone)}
                            ${this.miniMetric('Reports', reports, 'slate')}
                            ${this.miniMetric('Events', item.events.length, 'slate')}
                        </div>
                    </div>
                </div>
                <div class="ac-case-footer">
                    <div class="ac-actions">
                        <button type="button"
                                data-ac-open="true"
                                data-case-id="${this.escape(item.caseId || caseKey)}">Open Case</button>
                        <button type="button"
                                data-ac-watch-action="${this.escape(watchAction)}"
                                data-case-id="${this.escape(item.caseId || caseKey)}"
                                data-player="${this.escape(item.player || 'Unknown')}"
                                data-guid="${this.escape(item.guid || '')}"
                                data-profile-id="${this.escape(item.profileId || this.profileIdFor(item) || '')}">${this.escape(watchLabel)}</button>
                        <button type="button"
                                data-ac-clear="true"
                                data-case-id="${this.escape(item.caseId || caseKey)}"
                                ${status === 'Cleared' ? 'disabled' : ''}>Clear</button>
                        <button type="button"
                                data-ac-review="true"
                                data-case-id="${this.escape(item.caseId || caseKey)}"
                                ${reviewSent ? 'disabled' : ''}>${this.escape(reviewLabel)}</button>
                    </div>
                    <details class="ac-evidence-details" data-ac-expand="${this.escape(caseKey)}">
                        <summary>Show evidence</summary>
                        <div class="ac-evidence">
                            <section class="ac-evidence-group">
                                <div class="ac-section-label">Gameplay Evidence</div>
                                <div class="ac-evidence-grid">
                                ${this.evidenceItem('Suspected cheat', item.cheatType || 'Unknown')}
                                ${this.evidenceItem('Evidence Type', evidenceType)}
                                ${this.evidenceItem('Map', item.map || 'Unknown')}
                                ${this.evidenceItem('Weapon', item.weapon || 'Not recorded')}
                                ${this.evidenceHtmlItem('Victim', this.victimLink(item.victimName || item.victim || 'Not available'))}
                                ${this.evidenceItem('Hit', item.hitLocation || 'Not recorded')}
                                ${this.evidenceItem('Distance', item.distance || 'Unknown')}
                                ${this.evidenceItem('Angle', item.angle || 'Unknown')}
                                ${this.evidenceItem('Line of Sight', item.lineOfSight || 'Unknown')}
                                </div>
                            </section>
                            <section class="ac-evidence-group">
                                <div class="ac-section-label">Discord / Review Status</div>
                                <div class="ac-evidence-grid">
                                ${this.evidenceItem('Discord Status', discord.shortLabel)}
                                </div>
                                ${discordNote ? `<p class="ac-evidence-note">${this.escape(discordNote)}</p>` : ''}
                            </section>
                            <section class="ac-evidence-group ac-interpretation">
                                <div class="ac-section-label">Admin Interpretation</div>
                                <p>${this.escape(this.adminInterpretation(item, hard, discord, action, evidenceType))}</p>
                            </section>
                        </div>
                        ${this.rawDebugDetails(item, rawReasons)}
                    </details>
                </div>
            </div>`;
    },

    renderCaseProfile: function (caseId, cases, actionResult) {
        const target = (cases || []).find(item =>
            String(item.caseId || '') === String(caseId || '') ||
            this.caseKey(item) === String(caseId || '') ||
            String(item.guid || '').toLowerCase() === String(caseId || '').toLowerCase());

        if (!target) {
            return `
                <div id="anticheat-metrics-panel" class="ac-dashboard">
                    ${this.dashboardStyles()}
                    <header class="ac-page-header">
                        <div>
                            <h1 class="ac-title">Case not found</h1>
                            <p class="ac-subtitle">The anti-cheat case could not be found in the current log window.</p>
                        </div>
                        <button type="button" class="ac-back-button" onclick="history.back()">Back</button>
                    </header>
                </div>`;
        }

        const status = this.caseStatus(target);
        const risk = this.riskInfo(target);
        const confidence = this.confidenceInfo(target);
        const breakdown = this.caseRiskBreakdown(target);
        const reports = (target.events || []).filter(event => event.eventType === 'player_report' || this.itemLooksLikeReport(event));
        const actions = this.caseActions(target);
        const sortedEvents = (target.events || []).slice().sort((a, b) => (Date.parse(a.timestamp || a.time || '') || 0) - (Date.parse(b.timestamp || b.time || '') || 0));
        const caseKey = this.caseKey(target);
        const watchLabel = status === 'Watching' ? 'Undo Watch' : 'Watch';
        const watchAction = status === 'Watching' ? 'unwatch' : 'watch';
        const reviewSent = target.review && (target.review.sentAt || target.review.lastAttemptAt);
        const reviewLabel = reviewSent ? 'Review Sent' : 'Send Review';

        return `
            <div id="anticheat-metrics-panel" class="ac-dashboard ac-profile">
                ${this.dashboardStyles()}
                ${actionResult ? this.actionNotice(actionResult) : ''}
                <header class="ac-page-header">
                    <div>
                        <h1 class="ac-title">Anti-cheat Case</h1>
                        <p class="ac-subtitle">${this.escape(target.player || 'Unknown')} · ${this.escape(target.guid || 'Unknown GUID')}</p>
                    </div>
                    <div class="ac-header-meta">
                        <button type="button" class="ac-back-button" data-ac-back="true">Back to queue</button>
                    </div>
                </header>

                <section class="ac-profile-hero">
                    <div>
                        <div class="ac-person-title">
                            ${this.playerLink(target)}
                            <span class="${this.badgeClass(status)}">${this.escape(status)}</span>
                        </div>
                        <p class="ac-profile-reason">${this.escape(target.mainReason || this.plainReason(target))}</p>
                        <div class="ac-muted-line">Client ${this.escape(target.client || 'Unknown')} · ${this.escape(target.server || 'Unknown server')} · ${this.escape(target.map || target.latestMap || 'Unknown map')}</div>
                    </div>
                    <div class="ac-actions">
                        <button type="button"
                                data-ac-watch-action="${this.escape(watchAction)}"
                                data-case-id="${this.escape(target.caseId || caseKey)}">${this.escape(watchLabel)}</button>
                        <button type="button"
                                data-ac-clear="true"
                                data-case-id="${this.escape(target.caseId || caseKey)}"
                                ${status === 'Cleared' ? 'disabled' : ''}>Clear</button>
                        <button type="button"
                                data-ac-review="true"
                                data-case-id="${this.escape(target.caseId || caseKey)}"
                                ${reviewSent ? 'disabled' : ''}>${this.escape(reviewLabel)}</button>
                    </div>
                </section>

                <section class="ac-profile-grid">
                    ${this.profileSection('Player Summary', [
                        ['Name', target.player || 'Unknown'],
                        ['GUID', target.guid || 'Unknown'],
                        ['Client ID', target.client || 'Unknown'],
                        ['Status', status],
                        ['Priority', target.priority || status],
                        ['Latest Server', target.server || 'Unknown'],
                        ['Latest Map', target.map || target.latestMap || 'Unknown'],
                        ['First Seen', target.firstSeen || 'Unknown'],
                        ['Last Seen', target.lastSeen || 'Unknown'],
                        ['Reports', target.reportsCount || target.reports || 0],
                        ['Events', target.eventsCount || (target.events || []).length],
                        ['Actions Taken', target.actionsTakenCount || target.actions || 0]
                    ])}
                    ${this.profileSection('Risk / Confidence', [
                        ['Overall Risk', `${risk.score}/100 (${risk.label})`],
                        ['Confidence', `${confidence.score}/100 (${confidence.label})`],
                        ['Aim Risk', `${breakdown.aim}/100`],
                        ['ESP / Wallhack Suspicion', `${breakdown.esp}/100`],
                        ['Recoil Risk', `${breakdown.recoil}/100`],
                        ['Report Pressure', `${breakdown.reports}/100`],
                        ['Telemetry Quality', target.evidenceQuality || 'Unknown'],
                        ['False Positive Risk', target.falsePositiveRisk || 'Unknown']
                    ])}
                </section>

                <section class="ac-profile-section">
                    <h2 class="ac-section-title">Admin Interpretation</h2>
                    <p>${this.escape(target.interpretation || this.interpretationForCase(target))}</p>
                </section>

                <section class="ac-profile-section">
                    <h2 class="ac-section-title">Evidence Timeline</h2>
                    <div class="ac-timeline">
                        ${sortedEvents.length ? sortedEvents.map(event => this.timelineEvent(event)).join('') : '<p class="ac-muted-line">No events recorded for this case.</p>'}
                    </div>
                </section>

                <section class="ac-profile-grid">
                    <div class="ac-profile-section">
                        <h2 class="ac-section-title">Reports</h2>
                        ${reports.length ? reports.map((event, index) => this.reportRow(event, reports, index)).join('') : '<p class="ac-muted-line">No reports linked to this case.</p>'}
                    </div>
                    <div class="ac-profile-section">
                        <h2 class="ac-section-title">Action History</h2>
                        ${actions.length ? actions.map(action => this.actionRow(action)).join('') : '<p class="ac-muted-line">No staff actions recorded for this case.</p>'}
                    </div>
                </section>

                ${this.caseProfileScript()}
            </div>`;
    },

    profileSection: function (title, rows) {
        return `
            <div class="ac-profile-section">
                <h2 class="ac-section-title">${this.escape(title)}</h2>
                <div class="ac-profile-fields">
                    ${(rows || []).map(row => this.evidenceItem(row[0], row[1])).join('')}
                </div>
            </div>`;
    },

    timelineEvent: function (event) {
        const rawReasons = (event.rawReasons || event.reasons || []).length
            ? (event.rawReasons || event.reasons || []).map(reason => `<li>${this.escape(reason)}</li>`).join('')
            : '<li>No raw reason text was logged.</li>';
        return `
            <article class="ac-timeline-item">
                <div class="ac-timeline-head">
                    <strong>${this.escape(event.eventType || event.kind || 'event')}</strong>
                    <span>${this.localTimeElement(event.timestamp || event.time, event.displayTime || event.timestamp || event.time || 'Unknown')}</span>
                </div>
                <div class="ac-evidence-grid">
                    ${this.evidenceItem('Suspected Cheat', event.suspectedCheat || event.cheatType || 'Unknown')}
                    ${this.evidenceItem('Weapon', event.weapon || 'Not recorded')}
                    ${this.evidenceHtmlItem('Victim', this.victimLink(event.victimName || event.victim || 'Not available'))}
                    ${this.evidenceItem('Distance', event.distance || 'Unknown')}
                    ${this.evidenceItem('Angle', event.angle || 'Unknown')}
                    ${this.evidenceItem('Line of Sight', event.lineOfSight || 'Unknown')}
                    ${this.evidenceItem('Hit Location', event.hitLocation || 'Not recorded')}
                    ${this.evidenceItem('Risk', event.riskScore !== undefined ? `${event.riskScore}/100` : 'Unknown')}
                    ${this.evidenceItem('Confidence', event.confidenceScore !== undefined ? `${event.confidenceScore}/100` : 'Unknown')}
                </div>
                <details class="ac-raw">
                    <summary>Show raw/debug details</summary>
                    ${this.rawDebugContent(event, rawReasons)}
                </details>
            </article>`;
    },

    reportRow: function (event, reports, index) {
        const reporter = event.reporterName || event.reporter || 'Unknown reporter';
        const reporterKey = this.clean(event.reporterGuid || reporter).toLowerCase();
        const previous = reports.slice(0, index).some(item => this.clean(item.reporterGuid || item.reporterName || item.reporter || '').toLowerCase() === reporterKey);
        return `
            <div class="ac-history-row">
                <strong>${this.escape(reporter)}</strong>
                <span>${previous ? 'Repeated reporter' : 'Unique reporter'}</span>
                <p>${this.escape((event.rawReasons || event.reasons || []).join(' | ') || event.reason || 'No report reason recorded.')}</p>
                <small>${this.escape(event.serverName || event.server || 'Unknown server')} · ${this.escape(event.map || 'Unknown map')} · ${this.localTimeElement(event.timestamp || event.time, event.displayTime || event.timestamp || event.time || 'Unknown')}</small>
            </div>`;
    },

    actionRow: function (action) {
        const flag = action.iw4mFlag || {};
        return `
            <div class="ac-history-row">
                <strong>${this.escape(action.actionType || 'action')}</strong>
                <span>${this.escape(action.performedBy || 'Unknown Admin')}</span>
                <p>${this.escape(action.reason || 'No reason recorded.')}</p>
                ${action.iw4mFlagAttempted !== undefined ? `<small>IW4MAdmin flag: ${action.iw4mFlagSucceeded ? 'Succeeded' : 'Failed/skipped'}${action.iw4mFlagMessage ? ` · ${this.escape(action.iw4mFlagMessage)}` : ''}</small>` : ''}
                ${flag.message && action.iw4mFlagAttempted === undefined ? `<small>IW4MAdmin flag: ${this.escape(flag.message)}</small>` : ''}
                <small>${this.localTimeElement(action.timestamp, action.timestamp || 'Unknown')} · ${this.escape(action.source || 'unknown source')}</small>
            </div>`;
    },

    caseActions: function (target) {
        const state = this.readWatchState();
        const key = this.watchKey(target);
        const caseKey = `case:${this.clean(target.caseId || '').toLowerCase()}`;
        return (state.actions || []).filter(action =>
            action.caseId === target.caseId ||
            this.clean(action.playerGuid || '').toLowerCase() === this.clean(target.guid || '').toLowerCase() ||
            key === this.watchKey(action) ||
            caseKey === `case:${this.clean(action.caseId || '').toLowerCase()}`
        ).sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0));
    },

    caseRiskBreakdown: function (target) {
        const events = target.events || [];
        const maxFor = predicate => Math.max(0, ...events.filter(predicate).map(event => Number(event.riskScore || 0)));
        return {
            aim: maxFor(event => this.isAimLockLikeEvent(event) || this.hasStrongAimAngle(event)),
            esp: maxFor(event => this.isSoftEspOrLosEvent(event)),
            recoil: maxFor(event => (event.eventType || '') === 'recoil_suspicion' || this.eventText(event).indexOf('recoil') !== -1),
            reports: Math.min(100, Number(target.uniqueReporters || target.reportsCount || target.reports || 0) * 25)
        };
    },

    caseProfileScript: function () {
        return `
            <script>
                (() => {
                    const actionUrl = params => {
                        const url = new URL(window.location.href);
                        Object.keys(params || {}).forEach(key => url.searchParams.set(key, params[key]));
                        url.searchParams.set('_', Date.now().toString());
                        return url.toString();
                    };
                    const replacePanel = html => {
                        const doc = new DOMParser().parseFromString(html, 'text/html');
                        const nextPanel = doc.getElementById('anticheat-metrics-panel');
                        const currentPanel = document.getElementById('anticheat-metrics-panel');
                        if (nextPanel && currentPanel) currentPanel.replaceWith(nextPanel);
                    };
                    const run = (button, action) => {
                        const caseId = button.getAttribute('data-case-id') || '';
                        if (!caseId || button.disabled) return;
                        if (action === 'clear' && !confirm('Mark this anti-cheat case as cleared? Evidence will be kept.')) return;
                        if (action === 'send-review' && !confirm('Send this case to the Discord staff review webhook?')) return;
                        const previous = button.textContent;
                        button.disabled = true;
                        button.textContent = action === 'watch' ? 'Watching...' : (action === 'unwatch' ? 'Removing...' : (action === 'clear' ? 'Clearing...' : 'Sending...'));
                        fetch(actionUrl({ acAction: action, caseId: caseId }), { cache: 'no-store', credentials: 'same-origin' })
                            .then(response => response.text())
                            .then(replacePanel)
                            .catch(() => { button.disabled = false; button.textContent = previous; });
                    };
                    document.querySelectorAll('#anticheat-metrics-panel button[data-ac-watch-action]').forEach(button => button.addEventListener('click', () => run(button, button.getAttribute('data-ac-watch-action') || 'watch')));
                    document.querySelectorAll('#anticheat-metrics-panel button[data-ac-clear]').forEach(button => button.addEventListener('click', () => run(button, 'clear')));
                    document.querySelectorAll('#anticheat-metrics-panel button[data-ac-review]').forEach(button => button.addEventListener('click', () => run(button, 'send-review')));
                    document.querySelectorAll('#anticheat-metrics-panel button[data-ac-back]').forEach(button => button.addEventListener('click', () => {
                        const url = new URL(window.location.href);
                        url.searchParams.delete('acCase');
                        url.searchParams.delete('acAction');
                        url.searchParams.delete('caseId');
                        window.location.href = url.toString();
                    }));
                    const formatter = new Intl.DateTimeFormat(undefined, {
                        year: 'numeric', month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', second: '2-digit',
                        fractionalSecondDigits: 3, timeZoneName: 'short'
                    });
                    document.querySelectorAll('#anticheat-metrics-panel .js-local-time').forEach(element => {
                        const date = new Date(element.getAttribute('datetime'));
                        if (!Number.isNaN(date.getTime())) element.textContent = formatter.format(date);
                    });
                })();
            </script>`;
    },

    evidenceItem: function (label, value) {
        return `
            <div class="ac-evidence-item">
                <span>${this.escape(label)}</span>
                <strong>${this.escape(value)}</strong>
            </div>`;
    },

    evidenceHtmlItem: function (label, htmlValue) {
        return `
            <div class="ac-evidence-item">
                <span>${this.escape(label)}</span>
                <strong>${htmlValue || this.escape('Not available')}</strong>
            </div>`;
    },

    rawDebugDetails: function (item, rawReasonsHtml) {
        return `
            <details class="ac-raw">
                <summary>Show raw/debug details</summary>
                ${this.rawDebugContent(item, rawReasonsHtml)}
            </details>`;
    },

    rawDebugContent: function (item, rawReasonsHtml) {
        const fields = this.iw4mRawDebugFields(item || {});
        const rows = fields.map(field => `
            <div class="ac-debug-row">
                <dt>${this.escape(field[0])}</dt>
                <dd>${this.escape(field[1])}</dd>
            </div>`).join('');

        return `
            <p class="ac-raw-helper">Technical data for deeper validation. IW4MAdmin snapshot fields are shown when available.</p>
            <div class="ac-debug-list">${rows}</div>
            <div class="ac-raw-grid">
                <div>
                    <div class="ac-section-label">Raw reasons</div>
                    <ul>${rawReasonsHtml || '<li>No raw reason text was logged.</li>'}</ul>
                </div>
                <div>
                    <div class="ac-section-label">Raw metric text</div>
                    <p class="ac-raw-helper">${this.escape(item.rawData || item.metrics || 'No raw metric text was logged.')}</p>
                </div>
            </div>`;
    },

    iw4mRawDebugFields: function (item) {
        const metricPairs = this.parseMetricPairs(item.rawData || item.metrics || '');
        const events = item.events || [];
        const latest = item.latest || item.latestEvent || item;
        const eventCount = Number(item.eventsCount || events.length || 0);
        const reports = Number(item.reportsCount || item.reports || 0);
        const reasons = item.rawReasons || item.reasons || [];

        return [
            ['CapturedViewAngles', this.firstValue(item.capturedViewAngles, item.CapturedViewAngles, metricPairs.CapturedViewAngles, 'Not recorded')],
            ['CurrentSessionLength', this.firstValue(item.currentSessionLength, item.CurrentSessionLength, metricPairs.CurrentSessionLength, 'Not recorded')],
            ['CurrentStrain', this.firstValue(item.currentStrain, item.CurrentStrain, metricPairs.CurrentStrain, 'Not recorded')],
            ['CurrentViewAngle', this.firstValue(item.currentViewAngle, item.CurrentViewAngle, metricPairs.CurrentViewAngle, 'Not recorded')],
            ['Deaths', this.firstValue(item.deaths, item.Deaths, metricPairs.Deaths, 'Not recorded')],
            ['Distance', this.firstValue(item.distance, item.Distance, latest.distance, metricPairs.distance, metricPairs.Distance, 'Unknown')],
            ['EloRating', this.firstValue(item.eloRating, item.EloRating, metricPairs.EloRating, 'Not recorded')],
            ['EvidenceQuality', this.firstValue(item.evidenceQuality, item.EvidenceQuality, 'Unknown')],
            ['FalsePositiveRisk', this.firstValue(item.falsePositiveRisk, item.FalsePositiveRisk, 'Unknown')],
            ['HitDestination', this.firstValue(item.hitDestination, item.HitDestination, metricPairs.HitDestination, 'Not recorded')],
            ['HitLocation', this.firstValue(item.hitLocationId, item.HitLocationId, metricPairs.HitLocation, 'Not recorded')],
            ['HitLocationReference', this.firstValue(item.hitLocationReference, item.HitLocationReference, item.hitLocation, latest.hitLocation, 'Not recorded')],
            ['HitOrigin', this.firstValue(item.hitOrigin, item.HitOrigin, metricPairs.HitOrigin, 'Not recorded')],
            ['Hits', this.firstValue(item.hits, item.Hits, metricPairs.Hits, 'Not recorded')],
            ['HitType', this.firstValue(item.hitType, item.HitType, metricPairs.HitType, 'Not recorded')],
            ['Kills', this.firstValue(item.kills, item.Kills, metricPairs.Kills, 'Not recorded')],
            ['LastStrainAngle', this.firstValue(item.lastStrainAngle, item.LastStrainAngle, metricPairs.LastStrainAngle, 'Not recorded')],
            ['LineOfSight', this.firstValue(item.lineOfSight, item.LineOfSight, latest.lineOfSight, metricPairs['line of sight'], metricPairs.LineOfSight, 'Unknown')],
            ['Map', this.firstValue(item.map, item.latestMap, latest.map, 'Unknown')],
            ['Probability', this.firstValue(item.probability, item.Probability, this.probabilityForRisk(item.overallRisk || item.riskScore), 'Unknown')],
            ['RawScore', this.firstValue(item.score, item.rawScore, latest.rawScore, 'Unknown')],
            ['RecoilOffset', this.firstValue(item.recoilOffset, item.RecoilOffset, metricPairs.RecoilOffset, 'Not recorded')],
            ['Reports', reports],
            ['RiskScore', this.firstValue(item.overallRisk, item.riskScore, latest.riskScore, 'Unknown')],
            ['ConfidenceScore', this.firstValue(item.confidence, item.confidenceScore, latest.confidenceScore, 'Unknown')],
            ['ServerName', this.firstValue(item.serverName, item.server, latest.serverName, latest.server, 'Unknown server')],
            ['SessionAngleOffset', this.firstValue(item.sessionAngleOffset, item.SessionAngleOffset, metricPairs.SessionAngleOffset, 'Not recorded')],
            ['SessionAverageSnapValue', this.firstValue(item.sessionAverageSnapValue, item.SessionAverageSnapValue, metricPairs.SessionAverageSnapValue, 'Not recorded')],
            ['SessionScore', this.firstValue(item.sessionScore, item.SessionScore, metricPairs.SessionScore, 'Not recorded')],
            ['SessionSnapHits', this.firstValue(item.sessionSnapHits, item.SessionSnapHits, metricPairs.SessionSnapHits, 'Not recorded')],
            ['SessionSPM', this.firstValue(item.sessionSpm, item.SessionSPM, metricPairs.SessionSPM, 'Not recorded')],
            ['StrainAngleBetween', this.firstValue(item.strainAngleBetween, item.StrainAngleBetween, metricPairs.StrainAngleBetween, 'Not recorded')],
            ['SuspectedCheat', this.firstValue(item.suspectedCheat, item.cheatType, latest.suspectedCheat, latest.cheatType, 'Unknown')],
            ['TimeSinceLastEvent', this.firstValue(item.timeSinceLastEvent, item.TimeSinceLastEvent, metricPairs.TimeSinceLastEvent, 'Not recorded')],
            ['Victim', this.firstValue(item.victimName, item.victim, latest.victimName, latest.victim, 'Not available')],
            ['VisibleTime', this.firstValue(item.visibleTime, latest.visibleTime, metricPairs['visible time'], metricPairs.VisibleTime, 'Unknown')],
            ['WeaponId', this.firstValue(item.weaponId, item.WeaponId, metricPairs.WeaponId, 'Not recorded')],
            ['WeaponReference', this.firstValue(item.weaponReference, item.WeaponReference, item.weapon, latest.weapon, 'Not recorded')],
            ['When', this.firstValue(item.timestamp, item.time, latest.timestamp, latest.time, 'Unknown')],
            ['EventCount', eventCount],
            ['ReasonCount', reasons.length || 0]
        ];
    },

    parseMetricPairs: function (text) {
        const pairs = {};
        const raw = String(text || '');

        raw.split('|').forEach(part => {
            const index = part.indexOf('=');
            if (index <= 0) {
                return;
            }

            const key = part.substring(0, index).trim();
            const value = part.substring(index + 1).trim();

            if (key) {
                pairs[key] = value;
            }
        });

        return pairs;
    },

    firstValue: function () {
        for (let i = 0; i < arguments.length; i++) {
            const value = arguments[i];
            if (value !== undefined && value !== null && String(value) !== '') {
                return value;
            }
        }

        return '';
    },

    miniMetric: function (label, value, tone) {
        return `
            <div class="ac-mini-metric ac-tone-${this.escape(tone || 'slate')}">
                <span>${this.escape(label)}</span>
                <strong>${this.escape(value)}</strong>
            </div>`;
    },

    dashboardStyles: function () {
        return `
            <style>
                #anticheat-metrics-panel.ac-dashboard {
                    --ac-bg: #101216;
                    --ac-surface: #151820;
                    --ac-surface-soft: #191d25;
                    --ac-line: rgba(148, 163, 184, .095);
                    --ac-line-strong: rgba(148, 163, 184, .145);
                    --ac-text: #edf1f6;
                    --ac-muted: #98a2b3;
                    --ac-muted-2: #737f90;
                    --ac-red: #e78282;
                    --ac-amber: #d6aa5b;
                    --ac-blue: #8eb3dc;
                    --ac-green: #8bcfa7;
                    max-width: 1360px;
                    margin: 0 auto;
                    padding: 14px 18px 44px;
                    color: var(--ac-text);
                }
                #anticheat-metrics-panel .ac-page-header,
                #anticheat-metrics-panel .ac-toolbar,
                #anticheat-metrics-panel .ac-case-summary {
                    display: flex;
                    justify-content: space-between;
                    gap: 28px;
                }
                #anticheat-metrics-panel .ac-page-header {
                    align-items: flex-start;
                    padding: 2px 0 16px;
                    border-bottom: 1px solid var(--ac-line);
                }
                #anticheat-metrics-panel .ac-title {
                    margin: 0;
                    color: var(--ac-text);
                    font-size: 22px;
                    line-height: 1.2;
                    font-weight: 650;
                    letter-spacing: 0;
                }
                #anticheat-metrics-panel .ac-subtitle,
                #anticheat-metrics-panel .ac-section-subtitle,
                #anticheat-metrics-panel .ac-muted-line,
                #anticheat-metrics-panel .ac-status-row,
                #anticheat-metrics-panel .ac-stat-desc,
                #anticheat-metrics-panel .ac-header-meta,
                #anticheat-metrics-panel .ac-recommendation {
                    color: var(--ac-muted);
                }
                #anticheat-metrics-panel .ac-subtitle {
                    margin: 5px 0 0;
                    font-size: 13px;
                }
                #anticheat-metrics-panel .ac-header-meta {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    justify-content: flex-end;
                    gap: 8px 12px;
                    font-size: 12px;
                }
                #anticheat-metrics-panel .ac-health {
                    display: inline-flex;
                    align-items: center;
                    gap: 7px;
                    border: 1px solid var(--ac-line);
                    border-radius: 999px;
                    padding: 4px 9px;
                    background: rgba(255,255,255,.014);
                    color: var(--ac-muted);
                }
                #anticheat-metrics-panel .ac-health-dot {
                    width: 7px;
                    height: 7px;
                    border-radius: 50%;
                    background: var(--ac-green);
                }
                #anticheat-metrics-panel .ac-health.is-warning .ac-health-dot { background: var(--ac-amber); }
                #anticheat-metrics-panel .ac-action-notice {
                    margin: 0 0 14px;
                    border: 1px solid var(--ac-line);
                    border-radius: 10px;
                    padding: 10px 12px;
                    background: rgba(255,255,255,.018);
                    color: var(--ac-text);
                    font-size: 13px;
                }
                #anticheat-metrics-panel .ac-action-notice p {
                    margin: 4px 0 0;
                    color: var(--ac-muted);
                    font-size: 12px;
                }
                #anticheat-metrics-panel .ac-action-notice.is-success {
                    border-color: rgba(139, 207, 167, .28);
                }
                #anticheat-metrics-panel .ac-action-notice.is-warning {
                    border-color: rgba(214, 170, 91, .32);
                }
                #anticheat-metrics-panel .ac-metrics-strip {
                    display: grid;
                    grid-template-columns: repeat(6, minmax(0, 1fr));
                    gap: 12px;
                    margin: 22px 0 26px;
                    border: 0;
                    border-radius: 0;
                    background: transparent;
                    overflow: visible;
                }
                #anticheat-metrics-panel .ac-stat {
                    min-width: 0;
                    padding: 14px 16px;
                    border: 1px solid var(--ac-line);
                    border-radius: 11px;
                    background: rgba(255,255,255,.018);
                }
                #anticheat-metrics-panel .ac-stat:last-child { border-right: 1px solid var(--ac-line); }
                #anticheat-metrics-panel .ac-stat-label,
                #anticheat-metrics-panel .ac-section-label,
                #anticheat-metrics-panel .ac-control span,
                #anticheat-metrics-panel .ac-mini-metric span,
                #anticheat-metrics-panel .ac-evidence-item span {
                    color: var(--ac-muted-2);
                    font-size: 11px;
                    font-weight: 600;
                    letter-spacing: .01em;
                }
                #anticheat-metrics-panel .ac-evidence .ac-section-label {
                    color: #aab3c1;
                    font-size: 12px;
                    font-weight: 650;
                    letter-spacing: 0;
                }
                #anticheat-metrics-panel .ac-stat-value {
                    margin-top: 7px;
                    color: var(--ac-text);
                    font-size: 25px;
                    line-height: 1;
                    font-weight: 680;
                }
                #anticheat-metrics-panel .ac-stat-desc {
                    margin-top: 7px;
                    font-size: 11px;
                    line-height: 1.35;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                #anticheat-metrics-panel .ac-tone-red .ac-stat-value,
                #anticheat-metrics-panel .ac-tone-red strong { color: var(--ac-red); }
                #anticheat-metrics-panel .ac-tone-orange .ac-stat-value,
                #anticheat-metrics-panel .ac-tone-orange strong,
                #anticheat-metrics-panel .ac-tone-yellow strong { color: var(--ac-amber); }
                #anticheat-metrics-panel .ac-tone-blue .ac-stat-value,
                #anticheat-metrics-panel .ac-tone-blue strong,
                #anticheat-metrics-panel .ac-tone-purple strong { color: var(--ac-blue); }
                #anticheat-metrics-panel .ac-tone-green .ac-stat-value,
                #anticheat-metrics-panel .ac-tone-green strong { color: var(--ac-green); }
                #anticheat-metrics-panel .ac-queue {
                    border: 1px solid var(--ac-line);
                    border-radius: 12px;
                    background: rgba(255,255,255,.01);
                    overflow: hidden;
                }
                #anticheat-metrics-panel .ac-toolbar {
                    align-items: center;
                    padding: 18px 20px;
                    border-bottom: 1px solid var(--ac-line);
                    background: transparent;
                }
                #anticheat-metrics-panel .ac-section-title {
                    margin: 0;
                    color: var(--ac-text);
                    font-size: 15px;
                    font-weight: 620;
                }
                #anticheat-metrics-panel .ac-section-subtitle {
                    margin: 3px 0 0;
                    font-size: 12px;
                }
                #anticheat-metrics-panel .ac-controls {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: end;
                    justify-content: flex-end;
                    gap: 10px;
                }
                #anticheat-metrics-panel .ac-control select {
                    min-width: 148px;
                    margin-top: 4px;
                    border: 1px solid var(--ac-line);
                    border-radius: 8px;
                    background: #11141a;
                    color: var(--ac-text);
                    min-height: 34px;
                    padding: 7px 10px;
                    font-size: 12px;
                    outline: none;
                }
                #anticheat-metrics-panel .ac-toolbar-actions,
                #anticheat-metrics-panel .ac-actions {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                }
                #anticheat-metrics-panel .ac-toolbar-actions button,
                #anticheat-metrics-panel .ac-actions button {
                    border: 1px solid var(--ac-line);
                    border-radius: 8px;
                    background: transparent;
                    color: var(--ac-muted);
                    font-size: 12px;
                    font-weight: 500;
                    min-height: 34px;
                    padding: 7px 10px;
                }
                #anticheat-metrics-panel .ac-toolbar-actions button { cursor: pointer; color: var(--ac-text); }
                #anticheat-metrics-panel .ac-toolbar-actions button:hover,
                #anticheat-metrics-panel .ac-actions button:hover {
                    border-color: var(--ac-line-strong);
                    background: rgba(255,255,255,.025);
                }
                #anticheat-metrics-panel .ac-actions button:first-child {
                    color: #dce5ef;
                    border-color: rgba(142, 179, 220, .22);
                    background: rgba(142, 179, 220, .035);
                }
                #anticheat-metrics-panel .ac-actions button[data-ac-open],
                #anticheat-metrics-panel .ac-actions button[data-ac-watch-action],
                #anticheat-metrics-panel .ac-actions button[data-ac-clear],
                #anticheat-metrics-panel .ac-actions button[data-ac-review] {
                    cursor: pointer;
                    opacity: 1;
                    color: #dce5ef;
                }
                #anticheat-metrics-panel .ac-actions button[disabled] {
                    cursor: not-allowed;
                    opacity: .65;
                }
                #anticheat-metrics-panel .ac-case-list {
                    display: grid;
                    gap: 0;
                    background: transparent;
                }
                #anticheat-metrics-panel .ac-case {
                    position: relative;
                    border-bottom: 1px solid var(--ac-line);
                    background: transparent;
                }
                #anticheat-metrics-panel .ac-case:hover {
                    background: rgba(255,255,255,.012);
                }
                #anticheat-metrics-panel .ac-case:last-child { border-bottom: 0; }
                #anticheat-metrics-panel .ac-case:before {
                    content: "";
                    position: absolute;
                    left: 0;
                    top: 22px;
                    bottom: 22px;
                    width: 2px;
                    border-radius: 2px;
                    background: transparent;
                }
                #anticheat-metrics-panel .ac-accent-red:before { background: var(--ac-red); }
                #anticheat-metrics-panel .ac-accent-orange:before { background: var(--ac-amber); }
                #anticheat-metrics-panel .ac-accent-blue:before,
                #anticheat-metrics-panel .ac-accent-purple:before { background: rgba(122,167,223,.6); }
                #anticheat-metrics-panel .ac-accent-green:before { background: var(--ac-green); }
                #anticheat-metrics-panel .ac-case-summary {
                    align-items: flex-start;
                    padding: 22px 22px 14px 24px;
                }
                #anticheat-metrics-panel .ac-case-person {
                    flex: 0 0 300px;
                    min-width: 0;
                }
                #anticheat-metrics-panel .ac-person-title {
                    display: flex;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 9px;
                }
                #anticheat-metrics-panel .ac-person-title a,
                #anticheat-metrics-panel .ac-person-title > span:first-child {
                    color: var(--ac-text);
                    font-size: 15px;
                    font-weight: 640;
                    text-decoration: none;
                }
                #anticheat-metrics-panel .ac-muted-line {
                    margin-top: 5px;
                    font-size: 12px;
                    line-height: 1.45;
                    overflow-wrap: anywhere;
                    white-space: normal;
                }
                #anticheat-metrics-panel .ac-case-main {
                    flex: 1 1 auto;
                    min-width: 300px;
                }
                #anticheat-metrics-panel .ac-case-main p {
                    margin: 9px 0 0;
                    color: #dce2eb;
                    font-size: 13px;
                    line-height: 1.55;
                }
                #anticheat-metrics-panel .ac-badges {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 7px;
                }
                #anticheat-metrics-panel .ac-badge {
                    display: inline-flex;
                    align-items: center;
                    border: 1px solid var(--ac-line);
                    border-radius: 999px;
                    background: rgba(255,255,255,.018);
                    color: var(--ac-muted);
                    padding: 2px 7px;
                    font-size: 10.5px;
                    line-height: 1.35;
                    white-space: nowrap;
                }
                #anticheat-metrics-panel .ac-badge-red { color: #eda1a1; border-color: rgba(239,115,115,.18); background: rgba(239,115,115,.04); }
                #anticheat-metrics-panel .ac-badge-orange { color: #ddb879; border-color: rgba(217,164,65,.16); background: rgba(217,164,65,.04); }
                #anticheat-metrics-panel .ac-badge-yellow { color: #d7c47a; border-color: rgba(215,196,122,.14); }
                #anticheat-metrics-panel .ac-badge-blue,
                #anticheat-metrics-panel .ac-badge-purple { color: #a9c1df; border-color: rgba(122,167,223,.14); }
                #anticheat-metrics-panel .ac-badge-green { color: #a5d7ba; border-color: rgba(120,198,154,.16); }
                #anticheat-metrics-panel .ac-status-row {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px 14px;
                    margin-top: 8px;
                    color: var(--ac-muted);
                    font-size: 12px;
                }
                #anticheat-metrics-panel .ac-case-aside {
                    flex: 0 0 300px;
                    min-width: 0;
                }
                #anticheat-metrics-panel .ac-mini-metrics {
                    display: grid;
                    grid-template-columns: repeat(4, minmax(0, 1fr));
                    gap: 14px;
                }
                #anticheat-metrics-panel .ac-mini-metric {
                    min-width: 0;
                }
                #anticheat-metrics-panel .ac-mini-metric span,
                #anticheat-metrics-panel .ac-mini-metric strong {
                    display: block;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                #anticheat-metrics-panel .ac-mini-metric strong {
                    margin-top: 4px;
                    color: var(--ac-text);
                    font-size: 14px;
                    font-weight: 640;
                }
                #anticheat-metrics-panel .ac-recommendation {
                    margin-top: 7px;
                    font-size: 12px;
                    line-height: 1.35;
                    text-align: right;
                }
                #anticheat-metrics-panel .ac-case-footer {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    flex-wrap: wrap;
                    gap: 14px;
                    padding: 0 22px 22px 24px;
                }
                #anticheat-metrics-panel .ac-evidence-details {
                    margin-left: auto;
                    text-align: right;
                }
                #anticheat-metrics-panel .ac-evidence-details > summary,
                #anticheat-metrics-panel .ac-raw summary {
                    cursor: pointer;
                    color: var(--ac-muted);
                    font-size: 12px;
                    font-weight: 500;
                }
                #anticheat-metrics-panel .ac-evidence-details > summary:hover,
                #anticheat-metrics-panel .ac-raw summary:hover {
                    color: var(--ac-text);
                }
                #anticheat-metrics-panel .ac-evidence-details[open] {
                    flex: 1 1 100%;
                    width: 100%;
                    margin: 10px 0 0;
                    text-align: left;
                }
                #anticheat-metrics-panel .ac-evidence {
                    margin-top: 14px;
                    padding-top: 18px;
                    border-top: 1px solid var(--ac-line);
                }
                #anticheat-metrics-panel .ac-evidence-group {
                    padding: 0 0 18px;
                    margin: 0 0 18px;
                    border-bottom: 1px solid var(--ac-line);
                }
                #anticheat-metrics-panel .ac-evidence-group:last-child {
                    margin-bottom: 0;
                    padding-bottom: 0;
                    border-bottom: 0;
                }
                #anticheat-metrics-panel .ac-evidence-grid,
                #anticheat-metrics-panel .ac-tech-grid {
                    display: grid;
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                    gap: 14px 22px;
                    margin-top: 12px;
                }
                #anticheat-metrics-panel .ac-evidence-item {
                    min-width: 0;
                }
                #anticheat-metrics-panel .ac-evidence-item span,
                #anticheat-metrics-panel .ac-evidence-item strong {
                    display: block;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                #anticheat-metrics-panel .ac-evidence-item span {
                    color: var(--ac-muted-2);
                    font-size: 10px;
                    font-weight: 560;
                    line-height: 1.3;
                }
                #anticheat-metrics-panel .ac-evidence-item strong {
                    margin-top: 5px;
                    color: #eef2f7;
                    font-size: 13px;
                    line-height: 1.35;
                    font-weight: 620;
                }
                #anticheat-metrics-panel .ac-evidence-note {
                    margin: 12px 0 0;
                    color: var(--ac-muted);
                    font-size: 12px;
                    line-height: 1.55;
                }
                #anticheat-metrics-panel .ac-interpretation p {
                    max-width: 940px;
                    margin: 10px 0 0;
                    color: #c9d0da;
                    font-size: 12.5px;
                    line-height: 1.65;
                }
                #anticheat-metrics-panel .ac-raw {
                    margin-top: 18px;
                    padding: 14px 0 0;
                    border-top: 1px solid var(--ac-line);
                    color: var(--ac-muted);
                }
                #anticheat-metrics-panel .ac-raw-grid {
                    display: grid;
                    grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr);
                    gap: 22px;
                    margin-top: 12px;
                }
                #anticheat-metrics-panel .ac-raw-helper {
                    margin: 6px 0 0;
                    color: var(--ac-muted-2);
                    font-size: 12px;
                }
                #anticheat-metrics-panel .ac-debug-list {
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 0 28px;
                    margin-top: 14px;
                    padding: 12px 0;
                    border-top: 1px solid var(--ac-line);
                    border-bottom: 1px solid var(--ac-line);
                }
                #anticheat-metrics-panel .ac-debug-row {
                    display: grid;
                    grid-template-columns: minmax(140px, .45fr) minmax(0, 1fr);
                    gap: 12px;
                    padding: 6px 0;
                    min-width: 0;
                    border-bottom: 1px solid rgba(148, 163, 184, .055);
                }
                #anticheat-metrics-panel .ac-debug-row dt {
                    color: var(--ac-muted-2);
                    font-size: 11px;
                    font-weight: 560;
                    line-height: 1.35;
                }
                #anticheat-metrics-panel .ac-debug-row dd {
                    margin: 0;
                    min-width: 0;
                    color: #d7dde6;
                    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
                    font-size: 11px;
                    line-height: 1.45;
                    overflow-wrap: anywhere;
                }
                #anticheat-metrics-panel .ac-raw ul {
                    margin: 6px 0 0;
                    padding-left: 16px;
                    color: var(--ac-muted);
                    font-size: 12px;
                    line-height: 1.45;
                }
                #anticheat-metrics-panel .ac-empty {
                    display: grid;
                    place-items: center;
                    gap: 6px;
                    padding: 36px 16px;
                    color: var(--ac-muted);
                    text-align: center;
                }
                #anticheat-metrics-panel .ac-empty i {
                    color: var(--ac-green);
                    font-size: 24px;
                }
                #anticheat-metrics-panel .ac-empty p { margin: 0; font-size: 12px; }
                #anticheat-metrics-panel .ac-filter-empty { border-top: 1px solid var(--ac-line); }
                #anticheat-metrics-panel .ac-back-button {
                    border: 1px solid var(--ac-line-strong);
                    border-radius: 8px;
                    background: rgba(255,255,255,.025);
                    color: var(--ac-text);
                    padding: 7px 10px;
                    font-size: 12px;
                }
                #anticheat-metrics-panel .ac-profile-hero,
                #anticheat-metrics-panel .ac-profile-section,
                #anticheat-metrics-panel .ac-timeline-item {
                    border: 1px solid var(--ac-line);
                    border-radius: 12px;
                    background: rgba(255,255,255,.018);
                }
                #anticheat-metrics-panel .ac-profile-hero {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 20px;
                    margin: 20px 0;
                    padding: 18px;
                }
                #anticheat-metrics-panel .ac-profile-reason {
                    margin: 8px 0 8px;
                    color: var(--ac-text);
                    font-size: 14px;
                    line-height: 1.5;
                }
                #anticheat-metrics-panel .ac-profile-grid {
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 14px;
                    margin: 14px 0;
                }
                #anticheat-metrics-panel .ac-profile-section {
                    padding: 16px;
                    margin: 14px 0;
                }
                #anticheat-metrics-panel .ac-profile-fields {
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 11px;
                    margin-top: 12px;
                }
                #anticheat-metrics-panel .ac-timeline {
                    display: grid;
                    gap: 12px;
                    margin-top: 12px;
                }
                #anticheat-metrics-panel .ac-timeline-item {
                    padding: 14px;
                }
                #anticheat-metrics-panel .ac-timeline-head {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                    margin-bottom: 12px;
                    color: var(--ac-muted);
                    font-size: 12px;
                }
                #anticheat-metrics-panel .ac-timeline-head strong {
                    color: var(--ac-text);
                    font-size: 13px;
                    font-weight: 600;
                }
                #anticheat-metrics-panel .ac-history-row {
                    border-top: 1px solid var(--ac-line);
                    padding: 11px 0;
                    color: var(--ac-muted);
                    font-size: 12px;
                }
                #anticheat-metrics-panel .ac-history-row:first-of-type { border-top: 0; }
                #anticheat-metrics-panel .ac-history-row strong {
                    color: var(--ac-text);
                    margin-right: 8px;
                    font-size: 13px;
                }
                #anticheat-metrics-panel .ac-history-row p {
                    margin: 6px 0;
                    color: var(--ac-text);
                    line-height: 1.45;
                }
                #anticheat-metrics-panel .ac-history-row small {
                    display: block;
                    margin-top: 4px;
                    color: var(--ac-muted-2);
                }
                @media (max-width: 1180px) {
                    #anticheat-metrics-panel .ac-metrics-strip { grid-template-columns: repeat(3, minmax(0, 1fr)); }
                    #anticheat-metrics-panel .ac-case-summary { flex-wrap: wrap; }
                    #anticheat-metrics-panel .ac-case-person { flex-basis: 280px; }
                    #anticheat-metrics-panel .ac-case-aside { flex: 1 1 100%; }
                    #anticheat-metrics-panel .ac-recommendation { text-align: left; }
                }
                @media (max-width: 760px) {
                    #anticheat-metrics-panel.ac-dashboard { padding: 10px 12px 26px; }
                    #anticheat-metrics-panel .ac-page-header,
                    #anticheat-metrics-panel .ac-toolbar,
                    #anticheat-metrics-panel .ac-case-summary,
                    #anticheat-metrics-panel .ac-profile-hero,
                    #anticheat-metrics-panel .ac-case-footer { flex-direction: column; align-items: stretch; }
                    #anticheat-metrics-panel .ac-page-header,
                    #anticheat-metrics-panel .ac-toolbar { gap: 14px; }
                    #anticheat-metrics-panel .ac-toolbar,
                    #anticheat-metrics-panel .ac-case-summary { padding-left: 16px; padding-right: 16px; }
                    #anticheat-metrics-panel .ac-case-footer { padding-left: 16px; padding-right: 16px; }
                    #anticheat-metrics-panel .ac-header-meta,
                    #anticheat-metrics-panel .ac-controls,
                    #anticheat-metrics-panel .ac-toolbar-actions,
                    #anticheat-metrics-panel .ac-actions { justify-content: flex-start; }
                    #anticheat-metrics-panel .ac-controls { gap: 10px; }
                    #anticheat-metrics-panel .ac-metrics-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
                    #anticheat-metrics-panel .ac-case-person,
                    #anticheat-metrics-panel .ac-case-main,
                    #anticheat-metrics-panel .ac-case-aside { flex-basis: auto; min-width: 0; width: 100%; }
                    #anticheat-metrics-panel .ac-mini-metrics,
                    #anticheat-metrics-panel .ac-profile-grid,
                    #anticheat-metrics-panel .ac-profile-fields,
                    #anticheat-metrics-panel .ac-evidence-grid,
                    #anticheat-metrics-panel .ac-tech-grid,
                    #anticheat-metrics-panel .ac-debug-list,
                    #anticheat-metrics-panel .ac-raw-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
                    #anticheat-metrics-panel .ac-evidence-details { margin-left: 0; text-align: left; }
                }
                @media (max-width: 520px) {
                    #anticheat-metrics-panel .ac-metrics-strip,
                    #anticheat-metrics-panel .ac-mini-metrics,
                    #anticheat-metrics-panel .ac-profile-grid,
                    #anticheat-metrics-panel .ac-profile-fields,
                    #anticheat-metrics-panel .ac-evidence-grid,
                    #anticheat-metrics-panel .ac-tech-grid,
                    #anticheat-metrics-panel .ac-debug-list,
                    #anticheat-metrics-panel .ac-raw-grid { grid-template-columns: 1fr; }
                    #anticheat-metrics-panel .ac-debug-row { grid-template-columns: 1fr; gap: 3px; }
                    #anticheat-metrics-panel .ac-stat { padding: 13px 14px; }
                    #anticheat-metrics-panel .ac-stat-value { font-size: 23px; }
                    #anticheat-metrics-panel .ac-controls { display: grid; grid-template-columns: 1fr; }
                    #anticheat-metrics-panel .ac-control select { width: 100%; }
                }
            </style>`;
    },

    caseKey: function (item) {
        if (item.caseId) {
            return String(item.caseId).replace(/[^a-z0-9|_.:-]/gi, '_');
        }

        return [
            this.clean(item.guid || item.player || 'unknown').toLowerCase(),
            this.clean(item.server || item.serverKey || 'unknown').toLowerCase(),
            this.clean(item.map || 'unknown').toLowerCase()
        ].join('|').replace(/[^a-z0-9|_.:-]/g, '_');
    },

    handleDashboardAction: function (meta, originId) {
        const action = this.clean(this.metaValue(meta, 'acAction'), '').toLowerCase();
        if (!action) {
            return null;
        }

        if (action !== 'watch' && action !== 'unwatch' && action !== 'clear' && action !== 'send-review') {
            return {
                success: false,
                message: 'Unknown anti-cheat action.',
                detail: `Action "${action}" is not supported.`
            };
        }

        const caseId = this.clean(this.metaValue(meta, 'caseId'), '');
        if (!caseId) {
            return {
                success: false,
                message: 'Unable to update case.',
                detail: 'No case id was provided.'
            };
        }

        if (action === 'watch') {
            return this.markCaseWatching(caseId, originId);
        }
        if (action === 'unwatch') {
            return this.unwatchCase(caseId, originId);
        }
        if (action === 'clear') {
            return this.markCaseCleared(caseId, originId);
        }
        return this.sendCaseReview(caseId, originId);
    },

    handleWatchCommand: function (gameEvent) {
        const origin = gameEvent && (gameEvent.origin || gameEvent.Origin);
        const originId = origin && (origin.clientId || origin.ClientId || origin.name || origin.Name) || '';
        const raw = this.clean(gameEvent && (gameEvent.data || gameEvent.Data || gameEvent.commandText || gameEvent.CommandText), '');
        const caseId = raw.split(/\s+/)[0] || '';
        const result = this.markCaseWatching(caseId, originId, origin);
        const message = result && result.detail
            ? `${result.message} ${result.detail}`
            : (result && result.message || 'Watch action completed.');

        if (origin && typeof origin.tell === 'function') {
            origin.tell(message);
        } else if (origin && typeof origin.Tell === 'function') {
            origin.Tell(message);
        }
    },

    iw4mFlagEligibility: function (target) {
        const risk = this.riskInfo(target).score;
        const confidence = this.confidenceInfo(target).score;
        const hard = Number(target.hardDetectionCount || 0) > 0 || this.isHardDetection(target.latest || target);
        const reports = Number(target.reportsCount || target.reports || 0);
        const uniqueReporters = Number(target.uniqueReporters || 0);
        const events = Number(target.eventsCount || (target.events || []).length || 0);
        const categories = Number(target.suspiciousCategories || this.suspiciousCategoryCount(target.events || [], reports, target.hardDetectionCount || 0));
        const uniqueVictims = Number(target.uniqueVictims || 0);
        const falsePositiveRisk = String(target.falsePositiveRisk || '').toLowerCase();
        const highFalsePositiveRisk = falsePositiveRisk.indexOf('high') !== -1;
        const text = this.eventText(target);
        const aimLockEvidenceCount = (target.events || [target]).filter(event => {
            const eventText = this.eventText(event);
            return this.isAimLockLikeEvent(event) &&
                (eventText.indexOf('snap-lock') !== -1 ||
                    eventText.indexOf('ads snapped') !== -1 ||
                    eventText.indexOf('ads aim stayed tightly') !== -1 ||
                    eventText.indexOf('near-perfect aim') !== -1 ||
                    eventText.indexOf('aim lock') !== -1 ||
                    eventText.indexOf('aim assist') !== -1);
        }).length;
        const repeatedAimLock = aimLockEvidenceCount >= 2 &&
            risk >= 75 &&
            confidence >= 65 &&
            !highFalsePositiveRisk;
        const strongSingleAimLock = (text.indexOf('near-perfect aim') !== -1 ||
            text.indexOf('ads aim stayed tightly locked') !== -1 ||
            text.indexOf('ads snapped onto a bot') !== -1) &&
            risk >= 80 &&
            confidence >= 70 &&
            !highFalsePositiveRisk;
        const repeatedSupportedSoftEvidence = events >= 4 &&
            risk >= 75 &&
            confidence >= 60 &&
            !highFalsePositiveRisk &&
            (uniqueVictims >= 2 || categories >= 2 || reports > 0);

        if (target.actionsTakenCount > 0 || target.actions > 0 || target.kind === 'AUTO_BAN' || target.kind === 'AUTO_TEMPBAN') {
            return {
                eligible: true,
                reason: 'IW4MAdmin flag allowed because an anti-cheat moderation action already exists.'
            };
        }

        if (hard && risk >= 75 && confidence >= 75 && !highFalsePositiveRisk) {
            return {
                eligible: true,
                reason: 'IW4MAdmin flag allowed because hard anti-cheat telemetry crossed risk and confidence thresholds.'
            };
        }

        if (strongSingleAimLock || repeatedAimLock) {
            return {
                eligible: true,
                reason: 'IW4MAdmin flag allowed because repeated or very strong aim-lock evidence crossed confidence thresholds.'
            };
        }

        if (uniqueReporters >= 2 && events >= 2 && risk >= 70 && confidence >= 55 && !highFalsePositiveRisk) {
            return {
                eligible: true,
                reason: 'IW4MAdmin flag allowed because multiple unique reports overlap with suspicious telemetry.'
            };
        }

        if (repeatedSupportedSoftEvidence) {
            return {
                eligible: true,
                reason: 'IW4MAdmin flag allowed because repeated suspicious telemetry has independent support.'
            };
        }

        return {
            eligible: false,
            reason: 'Marked Watching locally. IW4MAdmin flag skipped because this case is not high-confidence enough yet.'
        };
    },

    markCaseWatching: function (caseId, originId, originClient) {
        const target = this.findCase(caseId);

        if (!target) {
            return {
                success: false,
                message: 'Unable to mark Watch.',
                detail: 'The case could not be found in the current anti-cheat data.'
            };
        }

        const now = new Date().toISOString();
        const admin = this.adminNameFromOrigin(originId);
        const reason = `Marked as "Watch" by ${admin} @ ${this.formatActionTime(now)} via Anticheat Panel.`;
        const state = this.readWatchState();
        const watchKey = this.watchKey(target);
        const existing = state.watches[watchKey];
        const alreadyWatching = !!existing;
        const existingFlagSucceeded = !!(existing && existing.iw4mFlag && existing.iw4mFlag.success);
        const shouldRetryFlag = alreadyWatching && !existingFlagSucceeded;
        const flagEligibility = this.iw4mFlagEligibility(target);
        const flagResult = alreadyWatching && !shouldRetryFlag
            ? {
                attempted: false,
                success: true,
                duplicate: true,
                message: 'Already watching; IW4MAdmin flag was not sent again.'
            }
            : (flagEligibility.eligible
                ? this.iw4mAdminFlagService(originClient || null, originId || '').flagWatch(target, admin, reason)
                : {
                    attempted: false,
                    success: false,
                    configured: true,
                    skippedForConfidence: true,
                    message: flagEligibility.reason,
                    reason: reason,
                    target: this.flagTargetSummary(target)
                });

        const record = this.actionRecord(target, 'watch', admin, now, reason, {
            actionType: 'watch',
            iw4mFlagAttempted: !!flagResult.attempted,
            iw4mFlagSucceeded: !!flagResult.success,
            iw4mFlagMessage: flagResult.message || '',
            iw4mFlag: flagResult,
            iw4mFlagEligible: !!flagEligibility.eligible,
            iw4mFlagEligibilityReason: flagEligibility.reason || ''
        });

        state.watches[watchKey] = Object.assign({}, existing || {}, {
            caseId: target.caseId,
            playerGuid: target.guid || '',
            playerName: target.player || 'Unknown',
            clientId: target.client || '',
            profileId: target.profileId || this.profileIdFor(target) || '',
            status: 'watching',
            priority: 'watching',
            reason: reason,
            lastWatchAt: existing && existing.lastWatchAt ? existing.lastWatchAt : now,
            lastRequestedAt: now,
            lastRequestedBy: admin,
            iw4mFlag: flagResult,
            iw4mFlagEligible: !!flagEligibility.eligible,
            iw4mFlagEligibilityReason: flagEligibility.reason || '',
            actionCount: Number(existing && existing.actionCount || 0) + 1
        });
        delete state.clears[watchKey];

        this.pushActionRecord(state, record);

        this.writeWatchState(state);

        if (alreadyWatching && !shouldRetryFlag) {
            return {
                success: true,
                message: 'Player is already marked as Watching.',
                detail: `${target.player || 'Player'} was already marked as Watch. IW4MAdmin was not flagged again.`
            };
        }

        if (flagResult.success) {
            return {
                success: true,
                message: shouldRetryFlag ? 'Player was already Watching and is now flagged in IW4MAdmin.' : 'Player marked as Watching and flagged in IW4MAdmin.',
                detail: flagResult.message || ''
            };
        }

        return {
            success: true,
            message: flagResult.attempted ? 'Player marked as Watching locally, but IW4MAdmin flag failed.' : 'Player marked as Watching.',
            detail: flagResult.attempted
                ? `Marked locally, but IW4MAdmin flag failed. ${flagResult.message || ''}`
                : (flagResult.message || 'Marked as watching locally. IW4MAdmin flag was skipped because this case is not high-confidence yet.')
        };
    },

    unwatchCase: function (caseId, originId) {
        const target = this.findCase(caseId);

        if (!target) {
            return {
                success: false,
                message: 'Unable to undo Watch.',
                detail: 'The case could not be found in the current anti-cheat data.'
            };
        }

        const state = this.readWatchState();
        const key = this.watchKey(target);
        const existing = state.watches[key];

        if (!existing) {
            return {
                success: true,
                message: 'Player is not currently marked as Watching.',
                detail: `${target.player || 'Player'} did not have an active Watch marker.`
            };
        }

        const now = new Date().toISOString();
        const admin = this.adminNameFromOrigin(originId);
        const reason = `Removed "Watch" by ${admin} @ ${this.formatActionTime(now)} via Anticheat Panel.`;
        const unflagResult = this.unflagWatchInIw4mDatabase(target, existing, reason);

        delete state.watches[key];
        this.pushActionRecord(state, this.actionRecord(target, 'unwatch', admin, now, reason, {
            actionType: 'unwatch',
            iw4mFlagAttempted: !!unflagResult.attempted,
            iw4mFlagSucceeded: !!unflagResult.success,
            iw4mFlagMessage: unflagResult.message || '',
            iw4mFlag: unflagResult
        }));
        this.writeWatchState(state);

        return {
            success: true,
            message: 'Watch removed.',
            detail: unflagResult.message || 'The player is no longer marked Watching in the anti-cheat panel.'
        };
    },

    markCaseCleared: function (caseId, originId) {
        const target = this.findCase(caseId);
        if (!target) {
            return {
                success: false,
                message: 'Unable to clear case.',
                detail: 'The case could not be found in the current anti-cheat data.'
            };
        }

        const state = this.readWatchState();
        const key = this.watchKey(target);
        const existingWatch = state.watches[key];
        if (state.clears[key]) {
            return {
                success: true,
                message: 'Case is already cleared.',
                detail: `${target.player || 'Player'} is already marked as cleared.`
            };
        }

        const now = new Date().toISOString();
        const admin = this.adminNameFromOrigin(originId);
        const reason = `Marked as cleared by ${admin} @ ${this.formatActionTime(now)} via Anticheat Panel.`;
        const unflagResult = existingWatch && existingWatch.iw4mFlag && existingWatch.iw4mFlag.success
            ? this.unflagWatchInIw4mDatabase(target, existingWatch, reason)
            : {
                attempted: false,
                success: false,
                configured: true,
                message: existingWatch
                    ? 'Local Watch marker was cleared. No successful IW4MAdmin Watch flag was recorded, so no IW4MAdmin unflag was queued.'
                    : 'No local Watch marker existed, so no IW4MAdmin unflag was queued.'
            };
        state.clears[key] = {
            caseId: target.caseId,
            playerGuid: target.guid || '',
            playerName: target.player || 'Unknown',
            clientId: target.client || '',
            profileId: target.profileId || this.profileIdFor(target) || '',
            status: 'cleared',
            reason: reason,
            clearedAt: now,
            clearedBy: admin,
            iw4mUnflag: unflagResult
        };
        delete state.watches[key];

        this.pushActionRecord(state, this.actionRecord(target, 'clear', admin, now, reason, {
            actionType: 'clear',
            iw4mFlagAttempted: !!unflagResult.attempted,
            iw4mFlagSucceeded: !!unflagResult.success,
            iw4mFlagMessage: unflagResult.message || '',
            iw4mFlag: unflagResult
        }));
        this.writeWatchState(state);

        return {
            success: true,
            message: 'Case marked as cleared.',
            detail: `Evidence was preserved for history. ${unflagResult.message || ''}`
        };
    },

    sendCaseReview: function (caseId, originId) {
        const target = this.findCase(caseId);
        if (!target) {
            return {
                success: false,
                message: 'Unable to send review.',
                detail: 'The case could not be found in the current anti-cheat data.'
            };
        }

        const state = this.readWatchState();
        const key = this.watchKey(target);
        const existing = state.reviews[key];
        if (existing && (existing.sentAt || existing.lastAttemptAt)) {
            return {
                success: true,
                message: existing.sentAt ? 'Discord review already sent.' : 'Discord review already attempted.',
                detail: `${target.player || 'Player'} already has a Discord review action recorded. Duplicate review sends are blocked.`
            };
        }

        const now = new Date().toISOString();
        const admin = this.adminNameFromOrigin(originId);
        const webhook = this.discordWebhook();
        const reason = `Sent Discord review by ${admin} @ ${this.formatActionTime(now)} via Anticheat Panel.`;
        let reviewResult = {
            attempted: false,
            success: false,
            message: 'Discord review is not configured.'
        };

        if (webhook && this.helper) {
            reviewResult = this.sendCaseReviewDiscord(target, webhook);
        }

        state.reviews[key] = {
            caseId: target.caseId,
            playerGuid: target.guid || '',
            playerName: target.player || 'Unknown',
            clientId: target.client || '',
            profileId: target.profileId || this.profileIdFor(target) || '',
            status: reviewResult.success ? 'sent' : 'failed',
            reason: reason,
            sentAt: reviewResult.success ? now : '',
            lastAttemptAt: now,
            requestedBy: admin,
            result: reviewResult
        };

        this.pushActionRecord(state, this.actionRecord(target, 'send_discord_review', admin, now, reason, {
            discordAttempted: !!reviewResult.attempted,
            discordSucceeded: !!reviewResult.success,
            discordMessage: reviewResult.message || ''
        }));
        this.writeWatchState(state);

        return {
            success: reviewResult.success,
            message: reviewResult.success ? 'Discord staff review sent.' : 'Discord review is not configured.',
            detail: reviewResult.message || ''
        };
    },

    findCase: function (caseId) {
        const id = String(caseId || '');
        const items = this.readEvents();
        const cases = this.buildCases(items);
        return cases.find(item =>
            String(item.caseId || '') === id ||
            this.caseKey(item) === id ||
            String(item.guid || '').toLowerCase() === id.toLowerCase());
    },

    actionRecord: function (target, actionType, admin, timestamp, reason, extra) {
        return Object.assign({
            actionId: `${actionType}:${Date.parse(timestamp) || Date.now()}:${this.stableHash(`${target.caseId || ''}|${reason || ''}`)}`,
            actionType: actionType,
            caseId: target.caseId,
            playerGuid: target.guid || '',
            playerName: target.player || 'Unknown',
            clientId: target.client || '',
            profileId: target.profileId || this.profileIdFor(target) || '',
            performedBy: admin || 'Unknown Admin',
            timestamp: timestamp,
            source: 'anticheat_panel',
            reason: reason || ''
        }, extra || {});
    },

    pushActionRecord: function (state, record) {
        state.actions = Array.isArray(state.actions) ? state.actions : [];
        state.actions.push(record);
        if (state.actions.length > 500) {
            state.actions = state.actions.slice(state.actions.length - 500);
        }
    },

    watchKey: function (item) {
        const guid = this.clean(item.guid || item.playerGuid || '').toLowerCase();
        if (guid) {
            return `guid:${guid}`;
        }

        return `case:${this.clean(item.caseId || this.caseKey(item)).toLowerCase()}`;
    },

    buildCases: function (items) {
        const groups = {};
        const normalizedItems = (items || []).map((sourceItem, index) => sourceItem.eventId ? sourceItem : this.normalizeEvent(sourceItem, index));
        const guidAliases = {};

        normalizedItems.forEach(item => {
            if (this.clean(item.playerGuid || item.guid || '').toLowerCase()) {
                this.caseAliasKeys(item).forEach(alias => {
                    guidAliases[alias] = item.caseId;
                });
            }
        });

        normalizedItems.forEach(item => {
            const hasGuid = !!this.clean(item.playerGuid || item.guid || '').toLowerCase();
            const aliasCaseId = !hasGuid ? this.firstAliasCaseId(item, guidAliases) : '';
            if (aliasCaseId) {
                item.caseId = aliasCaseId;
            }

            const key = item.caseId;

            if (!groups[key]) {
                groups[key] = {
                    caseId: item.caseId,
                    player: item.playerName,
                    guid: item.playerGuid,
                    client: item.clientId,
                    profileId: item.profileId,
                    server: item.serverName,
                    serverKey: item.serverKey,
                    map: item.map,
                    latestMap: item.map,
                    kind: item.kind,
                    eventType: item.eventType,
                    subType: item.subType,
                    probability: item.probability,
                    cheatType: item.suspectedCheat,
                    score: item.rawScore,
                    riskScore: item.riskScore,
                    confidenceScore: item.confidenceScore,
                    victim: item.victimName,
                    weapon: item.weapon,
                    hitLocation: item.hitLocation,
                    lineOfSight: item.lineOfSight,
                    distance: item.distance,
                    angle: item.angle,
                    visibleTime: item.visibleTime,
                    falsePositiveRisk: item.falsePositiveRisk,
                    evidenceQuality: item.evidenceQuality,
                    action: item.action,
                    admin: item.admin,
                    time: item.timestamp,
                    firstSeen: item.timestamp,
                    lastSeen: item.timestamp,
                    displayTime: item.displayTime,
                    mainReason: '',
                    recommendedAction: '',
                    recommendedActionCode: '',
                    interpretation: '',
                    priority: 'Watching',
                    status: 'Watching',
                    overallRisk: 0,
                    confidence: 0,
                    latest: item,
                    events: [],
                    reasons: [],
                    rawReasons: [],
                    reports: 0,
                    reportsCount: 0,
                    uniqueReporters: 0,
                    reporterIds: [],
                    victimIds: [],
                    alerts: 0,
                    discordAlertCount: 0,
                    actions: 0,
                    actionsTakenCount: 0,
                    hardDetectionCount: 0,
                    softSuspicionCount: 0
                };
            }

            const group = groups[key];
            group.events.push(item);
            group.firstSeen = this.earliestIso(group.firstSeen, item.timestamp);
            group.lastSeen = this.latestIso(group.lastSeen, item.timestamp);

            if ((Date.parse(item.timestamp || '') || 0) >= (Date.parse(group.time || '') || 0)) {
                Object.assign(group, {
                    player: item.playerName || group.player,
                    guid: item.playerGuid || group.guid,
                    client: item.clientId || group.client,
                    profileId: item.profileId || group.profileId,
                    server: item.serverName || group.server,
                    serverKey: item.serverKey || group.serverKey,
                    map: item.map || group.map,
                    latestMap: item.map || group.latestMap,
                    kind: item.kind || group.kind,
                    eventType: item.eventType || group.eventType,
                    subType: item.subType || group.subType,
                    probability: item.probability || group.probability,
                    cheatType: item.suspectedCheat || group.cheatType,
                    score: item.rawScore || group.score,
                    riskScore: item.riskScore,
                    confidenceScore: item.confidenceScore,
                    victim: item.victimName || group.victim,
                    weapon: item.weapon || group.weapon,
                    hitLocation: item.hitLocation || group.hitLocation,
                    lineOfSight: item.lineOfSight || group.lineOfSight,
                    distance: item.distance || group.distance,
                    angle: item.angle || group.angle,
                    visibleTime: item.visibleTime || group.visibleTime,
                    falsePositiveRisk: item.falsePositiveRisk || group.falsePositiveRisk,
                    evidenceQuality: item.evidenceQuality || group.evidenceQuality,
                    action: item.action || group.action,
                    admin: item.admin || group.admin,
                    time: item.timestamp || group.time,
                    displayTime: item.displayTime || group.displayTime,
                    latest: item
                });
            }

            if (item.crossedDiscordAlertRules || item.kind === 'ALERT' || item.kind === 'REVIEW_ALERT') {
                group.alerts++;
                group.discordAlertCount++;
            }

            if (item.eventType === 'moderation_action' || item.kind === 'AUTO_BAN' || item.kind === 'AUTO_TEMPBAN') {
                group.actions++;
                group.actionsTakenCount++;
            }

            if (item.eventType === 'player_report' || this.itemLooksLikeReport(item)) {
                group.reports++;
                group.reportsCount++;
                const reporterKey = this.clean(item.reporterGuid || item.reporterName || item.reporter || item.admin || item.eventId || '').toLowerCase();
                if (reporterKey && group.reporterIds.indexOf(reporterKey) === -1) {
                    group.reporterIds.push(reporterKey);
                }
            }

            const victimKey = this.clean(item.victimName || item.victim || '').toLowerCase();
            if (victimKey && victimKey !== 'not available' && victimKey !== 'unknown' && group.victimIds.indexOf(victimKey) === -1) {
                group.victimIds.push(victimKey);
            }

            if (item.eventType === 'iw4m_hard_detection' || this.isHardDetection(item)) {
                group.hardDetectionCount++;
            } else {
                group.softSuspicionCount++;
            }

            (item.rawReasons || item.reasons || []).forEach(reason => {
                if (group.reasons.indexOf(reason) === -1) {
                    group.reasons.push(reason);
                }
                if (group.rawReasons.indexOf(reason) === -1) {
                    group.rawReasons.push(reason);
                }
            });
        });

        const watchState = this.readWatchState();
        const cases = Object.keys(groups).map(key => this.applyWatchState(this.finalizeCase(groups[key]), watchState));
        cases.sort((a, b) => this.riskInfo(b).score - this.riskInfo(a).score);
        return cases;
    },

    caseAliasKeys: function (item) {
        const player = this.normalizedPlayerName(item.playerName || item.player || '');
        const server = this.clean(item.serverName || item.server || item.serverKey || '').toLowerCase();
        const client = this.clean(item.clientId || item.client || '').toLowerCase();
        const profile = this.clean(item.profileId || '').toLowerCase();
        const keys = [];

        if (player && server && client && client !== 'unknown') {
            keys.push(`player-server-client:${player}|${server}|${client}`);
        }
        if (player && server) {
            keys.push(`player-server:${player}|${server}`);
        }
        if (profile) {
            keys.push(`profile:${profile}`);
        }

        return keys;
    },

    firstAliasCaseId: function (item, aliases) {
        const keys = this.caseAliasKeys(item);
        for (let i = 0; i < keys.length; i++) {
            if (aliases[keys[i]]) {
                return aliases[keys[i]];
            }
        }
        return '';
    },

    normalizeEvent: function (item, index) {
        const normalized = Object.assign({}, item || {});
        normalized.timestamp = item.time || item.timestamp || new Date().toISOString();
        normalized.displayTime = item.displayTime || this.formatDisplayTime(normalized.timestamp);
        normalized.playerName = item.playerName || item.player || 'Unknown';
        normalized.playerGuid = item.playerGuid || item.guid || '';
        normalized.clientId = item.clientId || item.client || 'Unknown';
        normalized.serverName = item.serverName || item.server || item.serverKey || 'Unknown server';
        normalized.serverKey = item.serverKey || normalized.serverName;
        normalized.map = item.map || 'Unknown map';
        normalized.suspectedCheat = item.suspectedCheat || item.cheatType || 'Unknown';
        normalized.victimName = item.victimName || item.victim || 'Not available';
        normalized.rawScore = item.rawScore || item.score || '0';
        normalized.rawReasons = item.rawReasons || item.reasons || [];
        normalized.rawData = item.rawData || item.metrics || '';
        normalized.reporterName = item.reporterName || item.reporter || item.reportedBy || '';
        normalized.reporterGuid = item.reporterGuid || item.reporterId || '';
        normalized.kind = item.kind || 'EVIDENCE';
        normalized.eventType = item.eventType || this.classifyEventType(normalized);
        normalized.subType = item.subType || this.classifySubType(normalized);
        normalized.caseId = item.caseId || this.caseIdForEvent(normalized);
        normalized.eventId = item.eventId || this.eventIdFor(normalized, index);

        const scores = this.scoreEvent(normalized);
        normalized.riskScore = item.riskScore !== undefined ? Number(item.riskScore) : scores.riskScore;
        normalized.confidenceScore = item.confidenceScore !== undefined ? Number(item.confidenceScore) : scores.confidenceScore;
        normalized.evidenceQuality = item.evidenceQuality || scores.evidenceQuality;
        normalized.falsePositiveRisk = item.falsePositiveRisk || scores.falsePositiveRisk;

        const eligibility = this.discordEligibilityForEvent(normalized);
        normalized.crossedDiscordAlertRules = item.crossedDiscordAlertRules !== undefined
            ? !!item.crossedDiscordAlertRules
            : eligibility.crossedDiscordAlertRules;
        normalized.discordStatus = item.discordStatus || eligibility.discordStatus;
        normalized.discordAlertReason = item.discordAlertReason || eligibility.discordAlertReason;
        normalized.discordEligibleAt = item.discordEligibleAt || eligibility.discordEligibleAt;

        normalized.player = normalized.playerName;
        normalized.guid = normalized.playerGuid;
        normalized.client = normalized.clientId;
        normalized.server = normalized.serverName;
        normalized.cheatType = normalized.suspectedCheat;
        normalized.victim = normalized.victimName;
        normalized.score = normalized.rawScore;
        normalized.reasons = normalized.rawReasons;
        normalized.reporter = normalized.reporterName;

        return normalized;
    },

    finalizeCase: function (group) {
        const events = group.events || [];
        const hard = group.hardDetectionCount || 0;
        const reports = group.reportsCount || group.reports || 0;
        const uniqueReporters = Math.max((group.reporterIds || []).length, group.uniqueReporters || 0, reports > 0 ? 1 : 0);
        const uniqueVictims = Math.max((group.victimIds || []).length, 0);
        const softEspEvents = events.filter(event => this.isSoftEspOrLosEvent(event)).length;
        const strongAngleEvents = events.filter(event => this.hasStrongAimAngle(event)).length;
        const hardAimEvents = events.filter(event => this.isHardDetection(event) || this.isAimLockLikeEvent(event)).length;
        const suspiciousCategories = this.suspiciousCategoryCount(events, reports, hard);
        const repeatedBonus = Math.min(18, Math.max(0, events.length - 1) * 4);
        const hardBonus = Math.min(12, hard * 4);
        const reportBonus = Math.min(18, uniqueReporters * 7 + Math.max(0, reports - uniqueReporters) * 3);
        const maxRisk = Math.max(0, ...events.map(event => Number(event.riskScore || 0)));
        const maxConfidence = Math.max(0, ...events.map(event => Number(event.confidenceScore || 0)));
        const avgConfidence = events.length
            ? Math.round(events.reduce((sum, event) => sum + Number(event.confidenceScore || 0), 0) / events.length)
            : 0;

        group.overallRisk = this.clampScore(maxRisk + repeatedBonus + hardBonus + reportBonus);
        group.confidence = this.clampScore(Math.max(maxConfidence, avgConfidence + Math.min(15, repeatedBonus + hardBonus + Math.min(6, uniqueReporters * 2))));

        if (hard === 0 && softEspEvents > 0) {
            const hasReportSupport = uniqueReporters > 0;
            const hasDistinctPattern = uniqueVictims >= 2;
            const hasStrongAimSupport = strongAngleEvents >= 1 || hardAimEvents >= 1;
            const hasMultipleEvidenceTypes = suspiciousCategories >= 2;

            // Soft ESP/LOS evidence is useful, but common lanes, sound, UAV, and trace quirks can look similar.
            // Keep it below High Priority unless another independent signal supports it.
            if (!hasReportSupport && !hasDistinctPattern && !hasStrongAimSupport) {
                group.overallRisk = Math.min(group.overallRisk, 69);
                group.confidence = Math.min(group.confidence, 44);
            } else if (!hasReportSupport && !hasMultipleEvidenceTypes && softEspEvents < 3) {
                group.overallRisk = Math.min(group.overallRisk, 74);
                group.confidence = Math.min(group.confidence, 49);
            } else if (!hasReportSupport && uniqueVictims < 2 && strongAngleEvents < 2) {
                group.overallRisk = Math.min(group.overallRisk, 79);
                group.confidence = Math.min(group.confidence, 54);
            }
        }

        group.reportsCount = reports;
        group.uniqueReporters = uniqueReporters;
        group.uniqueVictims = uniqueVictims;
        group.suspiciousCategories = suspiciousCategories;
        group.eventsCount = events.length;
        group.discordAlertCount = group.discordAlertCount || group.alerts || 0;
        group.actionsTakenCount = group.actionsTakenCount || group.actions || 0;
        group.latestEvent = group.latest;

        const status = this.caseStatus(group);
        group.status = status;
        group.priority = status;
        group.mainReason = this.mainReasonForCase(group);
        group.recommendedActionCode = this.recommendedActionCode(group);
        group.recommendedAction = this.actionLabelForCode(group.recommendedActionCode);
        group.interpretation = this.interpretationForCase(group);

        const eligibility = this.discordEligibilityForCase(group);
        group.crossedDiscordAlertRules = eligibility.crossedDiscordAlertRules;
        group.discordStatus = eligibility.discordStatus;
        group.discordAlertReason = eligibility.discordAlertReason;
        group.discordEligibleAt = eligibility.discordEligibleAt;

        group.riskScore = group.overallRisk;
        group.confidenceScore = group.confidence;
        group.score = `${group.overallRisk} total`;
        group.probability = this.probabilityForRisk(group.overallRisk);
        group.evidenceQuality = group.evidenceQuality || this.evidenceQualityForCase(group);
        group.falsePositiveRisk = group.falsePositiveRisk || this.falsePositiveRiskForCase(group);

        return group;
    },

    applyWatchState: function (group, state) {
        const watches = state && state.watches ? state.watches : {};
        const clears = state && state.clears ? state.clears : {};
        const reviews = state && state.reviews ? state.reviews : {};
        const clearEntry = clears[this.watchKey(group)] || clears[`case:${this.clean(group.caseId || '').toLowerCase()}`];
        const entry = watches[this.watchKey(group)] || watches[`case:${this.clean(group.caseId || '').toLowerCase()}`];
        const reviewEntry = reviews[this.watchKey(group)] || reviews[`case:${this.clean(group.caseId || '').toLowerCase()}`];

        if (reviewEntry) {
            group.review = reviewEntry;
            group.reviewStatus = reviewEntry.status || '';
            if (reviewEntry.status === 'sent') {
                group.discordStatus = 'sent';
                group.discordAlertReason = 'Staff review was sent from the Anticheat Panel.';
                group.crossedDiscordAlertRules = true;
                group.discordSentAt = reviewEntry.sentAt || reviewEntry.lastAttemptAt || '';
            } else if (reviewEntry.status === 'failed') {
                group.discordStatus = 'failed';
                group.discordAlertReason = reviewEntry.result && reviewEntry.result.message || 'Discord review failed.';
            }
        }

        if (clearEntry) {
            group.status = 'Cleared';
            group.priority = 'Cleared';
            group.clear = clearEntry;
            group.clearStatus = 'cleared';
            group.clearedAt = clearEntry.clearedAt || '';
            group.clearedBy = clearEntry.clearedBy || 'Unknown Admin';
            group.recommendedActionCode = 'cleared';
            group.recommendedAction = this.actionLabelForCode(group.recommendedActionCode);
            return group;
        }

        if (!entry) {
            return group;
        }

        group.status = 'Watching';
        group.priority = 'Watching';
        group.watch = entry;
        group.watchStatus = 'watching';
        group.watchedAt = entry.lastWatchAt || entry.lastRequestedAt || '';
        group.watchedBy = entry.lastRequestedBy || 'Unknown Admin';
        group.recommendedActionCode = 'keep_watching';
        group.recommendedAction = this.actionLabelForCode(group.recommendedActionCode);

        return group;
    },

    defaultWatchState: function () {
        return {
            version: 1,
            watches: {},
            clears: {},
            reviews: {},
            actions: []
        };
    },

    readWatchState: function () {
        try {
            const io = System.IO;
            const path = String(this.settings.watchStatePath || '/app/Logs/anticheat-watch-actions.json');
            if (!io.File.Exists(path)) {
                return this.defaultWatchState();
            }

            const parsed = JSON.parse(io.File.ReadAllText(path) || '{}');
            return {
                version: parsed.version || 1,
                watches: parsed.watches || {},
                clears: parsed.clears || {},
                reviews: parsed.reviews || {},
                actions: Array.isArray(parsed.actions) ? parsed.actions : []
            };
        } catch (ex) {
            if (this.logger) {
                this.logger.logWarning('{Name} failed to read watch state: {Message}', this.name, ex.message || ex);
            }
            return this.defaultWatchState();
        }
    },

    writeWatchState: function (state) {
        try {
            const io = System.IO;
            const path = String(this.settings.watchStatePath || '/app/Logs/anticheat-watch-actions.json');
            const dir = io.Path.GetDirectoryName(path);
            if (dir && !io.Directory.Exists(dir)) {
                io.Directory.CreateDirectory(dir);
            }
            io.File.WriteAllText(path, JSON.stringify(state || this.defaultWatchState(), null, 2));
            return true;
        } catch (ex) {
            if (this.logger) {
                this.logger.logWarning('{Name} failed to write watch state: {Message}', this.name, ex.message || ex);
            }
            return false;
        }
    },

    iw4mAdminFlagService: function (originClient, originId) {
        return {
            flagWatch: (target, admin, reason) => {
                const targetClient = this.resolveIw4mClient(target);
                if (!targetClient) {
                    return this.flagWatchInIw4mDatabase(target, admin, reason, 'Player was not currently connected, so an IW4MAdmin database flag was attempted.', originId);
                }

                const punisher = this.resolveIw4mAdminClient(originClient, originId, targetClient);
                try {
                    if (typeof targetClient.flag === 'function') {
                        targetClient.flag(reason, punisher);
                    } else if (typeof targetClient.Flag === 'function') {
                        targetClient.Flag(reason, punisher);
                    } else {
                        return this.flagWatchInIw4mDatabase(target, admin, reason, 'Connected IW4MAdmin client object did not expose flag()/Flag(), so a database flag was attempted.', originId);
                    }

                    return {
                        attempted: true,
                        success: true,
                        configured: true,
                        message: 'Flagged in IW4MAdmin',
                        reason: reason,
                        target: this.flagTargetSummary(target)
                    };
                } catch (ex) {
                    if (this.logger) {
                        this.logger.logWarning('{Name} failed to flag watched player in IW4MAdmin: {Message}', this.name, ex.message || ex);
                    }

                    const fallback = this.flagWatchInIw4mDatabase(target, admin, reason, 'Live IW4MAdmin flag failed, so a database flag was attempted.', originId);
                    if (fallback.success) {
                        fallback.message = `Live IW4MAdmin flag failed, but the player was flagged in the IW4MAdmin database. Live error: ${this.clean(ex.message || ex)}`;
                    }
                    return fallback;
                }
            }
        };
    },

    flagWatchInIw4mDatabase: function (target, admin, reason, contextMessage, originId) {
        const summary = this.flagTargetSummary(target);
        const profileId = Number(summary.profileId || 0);
        const penaltyType = Number(this.settings.iw4mFlagPenaltyType || 2);
        const punisherId = this.punisherIdFromOrigin(originId, admin);

        if (!profileId || profileId < 1) {
            return {
                attempted: true,
                success: false,
                configured: true,
                message: 'IW4MAdmin flag failed because this case does not have a resolved IW4MAdmin profile ID yet.',
                reason: reason,
                target: summary
            };
        }

        try {
            this.queueIw4mFlagRequest({
                action: 'flag',
                profileId: profileId,
                punisherId: punisherId,
                penaltyType: penaltyType,
                reason: reason,
                target: summary,
                requestedAt: new Date().toISOString()
            });

            return {
                attempted: true,
                success: true,
                configured: true,
                queued: true,
                message: contextMessage ? `${contextMessage} Queued IW4MAdmin flag write.` : 'Queued IW4MAdmin flag write.',
                reason: reason,
                target: summary
            };
        } catch (ex) {
            if (this.logger) {
                this.logger.logWarning('{Name} failed to create IW4MAdmin database watch flag: {Message}', this.name, ex.message || ex);
            }

            return {
                attempted: true,
                success: false,
                configured: true,
                message: `IW4MAdmin flag queue failed: ${this.clean(ex.message || ex)}`,
                reason: reason,
                target: summary
            };
        }
    },

    unflagWatchInIw4mDatabase: function (target, watchEntry, reason) {
        const summary = this.flagTargetSummary(target);
        const profileId = Number(summary.profileId || (watchEntry && watchEntry.profileId) || 0);
        const penaltyType = Number(this.settings.iw4mFlagPenaltyType || 2);
        const punisherId = this.punisherIdFromOrigin('', this.clean(watchEntry && watchEntry.lastRequestedBy || ''));

        if (!profileId || profileId < 1) {
            return {
                attempted: false,
                success: false,
                configured: true,
                message: 'No IW4MAdmin profile id was available, so only the local Watch marker was removed.',
                reason: reason,
                target: summary
            };
        }

        try {
            this.queueIw4mFlagRequest({
                action: 'unflag',
                profileId: profileId,
                punisherId: punisherId,
                penaltyType: penaltyType,
                reason: reason,
                target: summary,
                requestedAt: new Date().toISOString()
            });

            return {
                attempted: true,
                success: true,
                configured: true,
                queued: true,
                message: 'Queued IW4MAdmin Watch flag removal.'
            };
        } catch (ex) {
            if (this.logger) {
                this.logger.logWarning('{Name} failed to remove IW4MAdmin database watch flag: {Message}', this.name, ex.message || ex);
            }

            return {
                attempted: true,
                success: false,
                configured: true,
                message: `IW4MAdmin unflag queue failed: ${this.clean(ex.message || ex)}`,
                reason: reason,
                target: summary
            };
        }
    },

    queueIw4mFlagRequest: function (request) {
        const io = System.IO;
        const path = String(this.settings.iw4mFlagRequestPath || '/app/Logs/anticheat-iw4m-flag-requests.jsonl');
        const directory = io.Path.GetDirectoryName(path);
        if (directory && !io.Directory.Exists(directory)) {
            io.Directory.CreateDirectory(directory);
        }

        io.File.AppendAllText(path, JSON.stringify(request) + '\n');
    },

    punisherIdFromOrigin: function (originId, adminName) {
        const raw = `${this.clean(originId || '')} ${this.clean(adminName || '')}`;
        const match = raw.match(/\b(\d+)\b/);
        const parsed = match ? Number(match[1]) : 0;
        return parsed > 0 ? parsed : Number(this.settings.iw4mFlagPunisherId || 1);
    },

    utcSqlTimestamp: function () {
        const date = new Date();
        const pad = value => String(value).padStart(2, '0');
        const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${ms}`;
    },

    flagTargetSummary: function (target) {
        return {
            caseId: target.caseId || '',
            playerGuid: target.guid || '',
            playerName: target.player || 'Unknown',
            clientId: target.client || '',
            profileId: target.profileId || this.profileIdFor(target) || ''
        };
    },

    resolveIw4mClient: function (target) {
        if (!this.manager || !target) {
            return null;
        }

        const guid = this.clean(target.guid || target.playerGuid || '').toLowerCase();
        const profileId = this.clean(target.profileId || this.profileIdFor(target) || '');
        const clientNumber = this.clean(target.client || target.clientId || '');
        const mappedProfileId = guid ? this.clean(this.profileIdFromMap(guid) || '') : '';

        try {
            const servers = this.toArray(this.manager.servers || this.manager.Servers);
            for (let i = 0; i < servers.length; i++) {
                const listClients = typeof servers[i].getClientsAsList === 'function'
                    ? this.toArray(servers[i].getClientsAsList())
                    : (typeof servers[i].GetClientsAsList === 'function' ? this.toArray(servers[i].GetClientsAsList()) : []);
                const clients = this.toArray(servers[i].connectedClients || servers[i].ConnectedClients).concat(listClients);
                for (let j = 0; j < clients.length; j++) {
                    const client = clients[j];
                    const networkId = this.clean(client.networkId || client.NetworkId || '').toLowerCase();
                    const currentProfileId = this.clean(client.clientId || client.ClientId || '');
                    const currentClientNumber = this.clean(client.clientNumber || client.ClientNumber || '');

                    if ((guid && networkId === guid) ||
                        (profileId && currentProfileId === profileId) ||
                        (mappedProfileId && currentProfileId === mappedProfileId) ||
                        (clientNumber && currentClientNumber === clientNumber && !guid && !profileId)) {
                        return client;
                    }
                }
            }
        } catch (ex) {
            if (this.logger) {
                this.logger.logWarning('{Name} failed to resolve IW4MAdmin client: {Message}', this.name, ex.message || ex);
            }
        }

        return null;
    },

    resolveIw4mAdminClient: function (originClient, originId, targetClient) {
        if (originClient) {
            return originClient;
        }

        const id = this.clean(originId || '');
        if (id && this.manager) {
            try {
                const servers = this.toArray(this.manager.servers || this.manager.Servers);
                for (let i = 0; i < servers.length; i++) {
                    const clients = this.toArray(servers[i].connectedClients || servers[i].ConnectedClients);
                    for (let j = 0; j < clients.length; j++) {
                        const client = clients[j];
                        const profileId = this.clean(client.clientId || client.ClientId || '');
                        if (profileId === id) {
                            return client;
                        }
                    }
                }
            } catch (ex) {
                if (this.logger) {
                    this.logger.logWarning('{Name} failed to resolve IW4MAdmin admin client: {Message}', this.name, ex.message || ex);
                }
            }
        }

        const server = targetClient && (targetClient.currentServer || targetClient.CurrentServer);
        if (server && typeof server.asConsoleClient === 'function') {
            return server.asConsoleClient();
        }
        if (server && typeof server.AsConsoleClient === 'function') {
            return server.AsConsoleClient();
        }

        return null;
    },

    disabledIw4mAdminFlagService: function () {
        return {
            flagWatch: (target, admin, reason) => {
                return {
                    attempted: false,
                    success: false,
                    configured: false,
                    message: 'IW4MAdmin flag integration is not configured for JavaScript interaction actions.',
                    reason: reason,
                    target: this.flagTargetSummary(target)
                };
            }
        };
    },

    adminNameFromOrigin: function (originId) {
        const value = this.clean(originId || '');
        if (!value) {
            return 'Unknown Admin';
        }

        return `Admin ${value}`;
    },

    classifyEventType: function (item) {
        const text = this.eventText(item);
        const kind = String(item.kind || '').toUpperCase();

        if (kind === 'AUTO_BAN' || kind === 'AUTO_TEMPBAN' || item.action || item.isAutomatedBan) {
            return 'moderation_action';
        }

        if (text.indexOf('report') !== -1) {
            return 'player_report';
        }

        if (this.isHardDetection(item)) {
            return 'iw4m_hard_detection';
        }

        if (text.indexOf('recoil') !== -1) {
            return 'recoil_suspicion';
        }

        if (text.indexOf('snap') !== -1 || text.indexOf('aim') !== -1 || text.indexOf('angle') !== -1 || text.indexOf('quickscope') !== -1 || text.indexOf('sniper') !== -1) {
            return 'aim_suspicion';
        }

        if (text.indexOf('esp') !== -1 || text.indexOf('wall') !== -1 || text.indexOf('pre-aim') !== -1) {
            return 'esp_suspicion';
        }

        if (text.indexOf('poor') !== -1 || text.indexOf('line-of-sight') !== -1 || text.indexOf('line of sight') !== -1 || text.indexOf('visible') !== -1) {
            return 'poor_los';
        }

        return 'manual_note';
    },

    classifySubType: function (item) {
        const text = this.eventText(item);

        if (text.indexOf('silent') !== -1) {
            return 'silent_aim';
        }
        if (text.indexOf('snap') !== -1 || text.indexOf('aim assist') !== -1 || text.indexOf('aim lock') !== -1 || text.indexOf('quickscope') !== -1 || text.indexOf('sniper snap') !== -1) {
            return 'aim_snap';
        }
        if (text.indexOf('recoil') !== -1) {
            return 'recoil';
        }
        if (text.indexOf('esp') !== -1 || text.indexOf('wall') !== -1) {
            return 'esp_los';
        }
        if (text.indexOf('report') !== -1) {
            return 'player_report';
        }
        if (item.action || item.isAutomatedBan) {
            return 'penalty';
        }

        return 'general';
    },

    isSoftEspOrLosEvent: function (item) {
        const eventType = item && (item.eventType || this.classifyEventType(item));
        const text = this.eventText(item);
        return eventType === 'esp_suspicion' ||
            eventType === 'poor_los' ||
            text.indexOf('esp') !== -1 ||
            text.indexOf('wall') !== -1 ||
            text.indexOf('poor/no clear') !== -1 ||
            text.indexOf('line-of-sight') !== -1 ||
            text.indexOf('line of sight') !== -1;
    },

    isAimLockLikeEvent: function (item) {
        const eventType = item && (item.eventType || this.classifyEventType(item));
        const subType = String(item && item.subType || '').toLowerCase();
        const text = this.eventText(item);
        return eventType === 'aim_suspicion' ||
            eventType === 'recoil_suspicion' ||
            subType === 'aim_snap' ||
            text.indexOf('aim lock') !== -1 ||
            text.indexOf('aim assist') !== -1 ||
            text.indexOf('silent aim') !== -1 ||
            text.indexOf('snap') !== -1 ||
            text.indexOf('quickscope') !== -1 ||
            text.indexOf('sniper head') !== -1 ||
            text.indexOf('no recoil') !== -1;
    },

    hasStrongAimAngle: function (item) {
        const angle = this.numericScore(item && item.angle);
        const text = this.eventText(item);
        return angle >= 25 ||
            text.indexOf('large aim angle') !== -1 ||
            text.indexOf('crosshair was far') !== -1 ||
            text.indexOf('angle mismatch') !== -1 && angle >= 25;
    },

    suspiciousCategoryCount: function (events, reports, hard) {
        const categories = {};
        (events || []).forEach(event => {
            if (this.isHardDetection(event)) {
                categories.hard = true;
            }
            if (this.isSoftEspOrLosEvent(event)) {
                categories.espLos = true;
            }
            if (this.isAimLockLikeEvent(event) || this.hasStrongAimAngle(event)) {
                categories.aim = true;
            }
            if ((event.eventType || '') === 'recoil_suspicion' || this.eventText(event).indexOf('recoil') !== -1) {
                categories.recoil = true;
            }
            if (this.eventText(event).indexOf('many kills') !== -1 || this.eventText(event).indexOf('repeated') !== -1 || this.eventText(event).indexOf('pattern') !== -1) {
                categories.pattern = true;
            }
        });
        if (Number(reports || 0) > 0) {
            categories.report = true;
        }
        if (Number(hard || 0) > 0) {
            categories.hard = true;
        }
        return Object.keys(categories).length;
    },

    scoreEvent: function (item) {
        const raw = this.numericScore(item.rawScore || item.score);
        const text = this.eventText(item);
        const hard = this.isHardDetection(item);
        const eventType = item.eventType || this.classifyEventType(item);
        const weapon = String(item.weapon || '').toLowerCase();
        const distance = this.numericScore(item.distance);
        const angle = this.numericScore(item.angle);
        const missingVisibility = this.isMissingValue(item.lineOfSight) || this.isMissingValue(item.distance) || this.isMissingValue(item.angle);
        const unconfirmedVisibility = text.indexOf('not recorded visible') !== -1 || text.indexOf('not recorded before kill') !== -1;
        const poorLos = String(item.lineOfSight || '').toLowerCase().indexOf('poor') !== -1 || text.indexOf('poor/no clear') !== -1;
        const projectile = this.isProjectileOrExplosiveWeapon(weapon);
        const closeRange = distance > 0 && distance < 250;
        const aimLockText = text.indexOf('aim lock') !== -1 ||
            text.indexOf('aim assist') !== -1 ||
            text.indexOf('snap-lock') !== -1 ||
            text.indexOf('ads snapped') !== -1 ||
            text.indexOf('ads aim') !== -1;
        const sniperSampleText = text.indexOf('sniper snap-kill pattern') !== -1 ||
            text.indexOf('quickscope sniper kills') !== -1 ||
            text.indexOf('sniper head/neck hit rate') !== -1;

        let risk = raw;
        let confidence = 35;

        if (eventType === 'moderation_action') {
            risk = Math.max(risk, 90);
            confidence = 95;
        } else if (eventType === 'iw4m_hard_detection') {
            risk = Math.max(risk, 75);
            confidence = 88;
        } else if (eventType === 'player_report') {
            risk = Math.max(risk, 30);
            confidence = 25;
        } else if (eventType === 'esp_suspicion' || eventType === 'poor_los') {
            risk = Math.max(risk, poorLos ? 62 : 50);
            confidence = poorLos ? 45 : 38;
        } else if (eventType === 'aim_suspicion' || eventType === 'recoil_suspicion') {
            risk = Math.max(risk, aimLockText ? 62 : (angle >= 60 ? 68 : 48));
            confidence = eventType === 'recoil_suspicion' ? 62 : (aimLockText ? 58 : 50);
        }

        if (text.indexOf('many kills') !== -1 || text.indexOf('repeated') !== -1 || text.indexOf('pattern') !== -1) {
            risk += 8;
            confidence += 6;
        }

        if (text.indexOf('headshot') !== -1 || text.indexOf('precise') !== -1 || text.indexOf('very precise') !== -1) {
            risk += 6;
            confidence += hard ? 5 : 2;
        }

        if (aimLockText && text.indexOf('repeated') !== -1) {
            risk += 14;
            confidence += 12;
        } else if (aimLockText && text.indexOf('pattern') !== -1 && text.indexOf('many kills') !== -1) {
            risk += 14;
            confidence += 10;
        } else if (aimLockText) {
            risk += 6;
            confidence += 4;
        }

        if (sniperSampleText) {
            risk += 12;
            confidence += 10;

            if (text.indexOf('confidence reduced') !== -1) {
                confidence -= 8;
            }
        }

        if ((eventType === 'esp_suspicion' || eventType === 'poor_los') && poorLos) {
            if (angle > 0 && angle < 20) {
                risk -= 10;
                confidence -= 8;
            } else if (angle >= 25 && angle < 45) {
                risk += 6;
                confidence += 4;
            } else if (angle >= 45) {
                risk += 12;
                confidence += 8;
            }
        }

        if (unconfirmedVisibility) {
            confidence -= 8;
            risk -= 4;
        }

        if (projectile) {
            confidence -= 22;
            risk -= 6;
        }

        if (missingVisibility) {
            confidence -= 15;
        }

        if (closeRange && (eventType === 'aim_suspicion' || eventType === 'poor_los')) {
            confidence -= 12;
        }

        if (String(item.falsePositiveRisk || '').toLowerCase().indexOf('high') !== -1) {
            confidence -= 18;
        }

        confidence = this.clampScore(confidence);
        risk = this.clampScore(risk);

        return {
            riskScore: risk,
            confidenceScore: confidence,
            evidenceQuality: item.evidenceQuality || this.evidenceQualityLabel(confidence, hard),
            falsePositiveRisk: item.falsePositiveRisk || this.falsePositiveRiskLabel(confidence, projectile, missingVisibility, closeRange)
        };
    },

    discordEligibilityForEvent: function (item) {
        const risk = Number(item.riskScore || 0);
        const confidence = Number(item.confidenceScore || 0);
        const hard = this.isHardDetection(item);
        const weakProjectile = this.isProjectileOrExplosiveWeapon(item.weapon) && confidence < 65;
        const softEsp = this.isSoftEspOrLosEvent(item);
        const strongAngle = this.hasStrongAimAngle(item) || this.isAimLockLikeEvent(item);
        const stale = this.isStaleTelemetry(item);
        let crossed = false;
        let reason = 'Evidence only';

        if (!weakProjectile && !stale && hard && risk >= 75 && confidence >= 75) {
            crossed = true;
            reason = 'Hard detection crossed risk and confidence threshold.';
        } else if (!weakProjectile && !stale && softEsp && strongAngle && risk >= 90 && confidence >= 60) {
            crossed = true;
            reason = 'High-risk ESP/LOS telemetry with supporting aim evidence.';
        } else if (!weakProjectile && !stale && !softEsp && risk >= 80 && confidence >= 55) {
            crossed = true;
            reason = 'High-risk suspicious telemetry with meaningful confidence.';
        }

        return {
            crossedDiscordAlertRules: crossed,
            discordStatus: crossed ? 'pending_review' : 'evidence_only',
            discordAlertReason: reason,
            discordEligibleAt: crossed ? item.timestamp : ''
        };
    },

    discordEligibilityForCase: function (group) {
        const hard = Number(group.hardDetectionCount || 0);
        const reports = Number(group.reportsCount || group.reports || 0);
        const uniqueReporters = Number(group.uniqueReporters || 0);
        const events = Number(group.eventsCount || (group.events || []).length);
        const risk = Number(group.overallRisk || 0);
        const confidence = Number(group.confidence || 0);
        const softEspEvents = (group.events || []).filter(event => this.isSoftEspOrLosEvent(event)).length;
        const uniqueVictims = Number(group.uniqueVictims || 0);
        const categories = Number(group.suspiciousCategories || this.suspiciousCategoryCount(group.events || [], reports, hard));
        const strongAimSupport = (group.events || []).filter(event => this.hasStrongAimAngle(event) || this.isAimLockLikeEvent(event)).length;
        let crossed = false;
        let reason = 'Evidence only';

        if (group.actionsTakenCount > 0 || group.actions > 0) {
            crossed = true;
            reason = 'Moderation action already recorded.';
        } else if (hard > 0 && risk >= 75 && confidence >= 75) {
            crossed = true;
            reason = 'Hard detection crossed review threshold.';
        } else if (softEspEvents > 0 && risk >= 85 && confidence >= 55 && (uniqueVictims >= 2 || categories >= 2 || strongAimSupport >= 2 || (uniqueReporters >= 1 && (events >= 3 || strongAimSupport >= 1)))) {
            crossed = true;
            reason = uniqueReporters >= 1
                ? 'Player report overlaps with suspicious ESP/LOS telemetry.'
                : 'Repeated ESP/LOS telemetry has supporting evidence.';
        } else if (softEspEvents === 0 && risk >= 80 && confidence >= 55) {
            crossed = true;
            reason = 'High-risk case with meaningful confidence.';
        } else if (uniqueReporters >= 2 && events >= 2 && risk >= 55 && confidence >= 35) {
            crossed = true;
            reason = 'Multiple player reports overlap with suspicious telemetry.';
        } else if (events >= 4 && risk >= 65 && confidence >= 45 && (uniqueVictims >= 2 || categories >= 2)) {
            crossed = true;
            reason = 'Repeated suspicious events crossed pattern threshold.';
        }

        if (this.isStaleTelemetry(group) && confidence < 55) {
            crossed = false;
            reason = 'Telemetry is stale or incomplete.';
        }

        return {
            crossedDiscordAlertRules: crossed,
            discordStatus: group.discordAlertCount > 0 || group.alerts > 0 ? 'sent' : (crossed ? 'pending_review' : 'evidence_only'),
            discordAlertReason: reason,
            discordEligibleAt: crossed ? group.lastSeen : ''
        };
    },

    mainReasonForCase: function (group) {
        const text = this.eventText(group);
        const reports = Number(group.reportsCount || group.reports || 0);

        if (group.actionsTakenCount > 0 || group.actions > 0) {
            return 'Automated IW4MAdmin anti-cheat action logged.';
        }
        if (group.hardDetectionCount > 0) {
            return 'Hard anti-cheat detection logged from IW4MAdmin-style telemetry.';
        }
        if (reports > 1 && group.eventsCount > 1) {
            return 'Multiple player reports were linked to suspicious telemetry.';
        }
        if (reports > 0 && group.eventsCount > 1) {
            return 'Player report overlaps with suspicious telemetry.';
        }
        if (text.indexOf('snap') !== -1 || text.indexOf('aim lock') !== -1 || text.indexOf('aim assist') !== -1 || text.indexOf('silent aim') !== -1) {
            return 'Repeated aim-related detection pattern logged.';
        }
        if (text.indexOf('poor') !== -1 || text.indexOf('line-of-sight') !== -1 || text.indexOf('line of sight') !== -1) {
            return group.eventsCount > 1 ? 'Multiple poor line-of-sight events were logged.' : 'Poor or missing visibility evidence logged.';
        }
        if (group.confidence < 40) {
            return 'Low-confidence suspicion only. Keep watching.';
        }
        return 'Suspicious behavior logged; review recent context.';
    },

    interpretationForCase: function (group) {
        const latest = group.latestEvent || group.latest || group;

        if (group.actionsTakenCount > 0 || group.actions > 0) {
            return 'IW4MAdmin already recorded an anti-cheat action for this player. Use this evidence to verify the action reason and check nearby events.';
        }
        if (group.hardDetectionCount > 0) {
            return 'This case includes hard anti-cheat telemetry, which is usually stronger evidence than normal gameplay suspicion. Review the full event history before taking action.';
        }
        if (latest.eventType === 'esp_suspicion' || latest.eventType === 'poor_los' || String(latest.lineOfSight || '').toLowerCase().indexOf('poor') !== -1) {
            return 'This is a soft ESP or line-of-sight suspicion event. Treat it as supporting evidence, not proof, unless repeated patterns or reports exist.';
        }
        if (this.isProjectileOrExplosiveWeapon(latest.weapon)) {
            return 'This event may have reduced reliability because projectile or explosive weapons can make aim-angle evidence less trustworthy.';
        }
        if ((group.reportsCount || group.reports || 0) > 0) {
            return 'Player reports increase urgency, but reports alone are not proof. Compare them against telemetry and spectator review.';
        }
        return 'This is supporting evidence for the review queue. Keep watching unless stronger telemetry, repeated events, or staff reports appear.';
    },

    recommendedActionCode: function (group) {
        const risk = Number(group.overallRisk || 0);
        const confidence = Number(group.confidence || 0);
        const reports = Number(group.reportsCount || group.reports || 0);
        const uniqueReporters = Number(group.uniqueReporters || 0);
        const events = Number(group.eventsCount || (group.events || []).length);

        if (group.actionsTakenCount > 0 || group.actions > 0) {
            return 'action_already_taken';
        }
        if (risk >= 85 && confidence >= 85 && group.hardDetectionCount > 0) {
            return 'high_confidence_hard_detection';
        }
        if (risk >= 80 && confidence >= 55 && uniqueReporters >= 2 && events >= 3) {
            return 'eligible_for_temp_review_hold';
        }
        if (risk >= 70 && confidence >= 50 && uniqueReporters >= 1 && events >= 2) {
            return 'send_discord_review';
        }
        if (String(group.falsePositiveRisk || '').toLowerCase().indexOf('high') !== -1 && confidence < 55) {
            return 'keep_watching';
        }
        if (risk >= 65 && confidence >= 55) {
            return 'needs_staff_review';
        }
        if (risk >= 35 || events > 1) {
            return 'keep_watching';
        }
        return 'log_only';
    },

    actionLabelForCode: function (code) {
        const labels = {
            log_only: 'Log only',
            keep_watching: 'Keep watching',
            needs_staff_review: 'Needs staff review',
            send_discord_review: 'Send Discord review later',
            eligible_for_temp_review_hold: 'Eligible for temporary review hold',
            high_confidence_hard_detection: 'High-confidence hard detection',
            action_already_taken: 'Action already taken',
            cleared: 'Cleared'
        };

        return labels[code] || 'Keep watching';
    },

    caseIdForEvent: function (item) {
        const guid = this.clean(item.playerGuid || item.guid || '').toLowerCase();
        if (guid && guid !== 'unknown') {
            return 'guid:' + guid;
        }

        return [
            'fallback',
            this.clean(item.playerName || item.player || 'unknown').toLowerCase(),
            this.clean(item.serverName || item.server || item.serverKey || 'unknown').toLowerCase(),
            this.clean(item.clientId || item.client || '').toLowerCase()
        ].join(':');
    },

    eventIdFor: function (item, index) {
        const seed = [
            item.timestamp,
            item.playerGuid || item.playerName,
            item.serverName,
            item.map,
            item.eventType,
            item.victimName,
            item.weapon,
            (item.rawReasons || []).join('|'),
            index
        ].join('|');

        return 'evt_' + this.hashString(seed);
    },

    hashString: function (value) {
        let hash = 0;
        const text = String(value || '');
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash) + text.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    },

    stableHash: function (value) {
        const text = String(value || '');
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash) + text.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    },

    eventText: function (item) {
        return [
            item && item.kind,
            item && item.eventType,
            item && item.subType,
            item && item.suspectedCheat,
            item && item.cheatType,
            item && item.weapon,
            item && item.lineOfSight,
            item && item.evidenceQuality,
            item && item.falsePositiveRisk,
            item && item.metrics,
            item && item.rawData,
            item && (item.rawReasons || item.reasons || []).join(' ')
        ].join(' ').toLowerCase();
    },

    clampScore: function (value) {
        const number = Number(value || 0);
        return Math.max(0, Math.min(100, Math.round(number)));
    },

    earliestIso: function (a, b) {
        if (!a) return b || '';
        if (!b) return a;
        return (Date.parse(a) || 0) <= (Date.parse(b) || 0) ? a : b;
    },

    latestIso: function (a, b) {
        if (!a) return b || '';
        if (!b) return a;
        return (Date.parse(a) || 0) >= (Date.parse(b) || 0) ? a : b;
    },

    probabilityForRisk: function (risk) {
        if (risk >= 90) return 'Very High';
        if (risk >= 70) return 'High';
        if (risk >= 35) return 'Medium';
        return 'Low';
    },

    evidenceQualityLabel: function (confidence, hard) {
        if (hard || confidence >= 85) return 'High confidence technical signal';
        if (confidence >= 60) return 'Moderate supporting telemetry';
        if (confidence >= 40) return 'Limited supporting telemetry';
        return 'Low-confidence supporting evidence';
    },

    falsePositiveRiskLabel: function (confidence, projectile, missingVisibility, closeRange) {
        if (projectile) return 'High - projectile/explosive weapon reduces aim-angle reliability';
        if (missingVisibility) return 'Medium - missing or incomplete telemetry';
        if (closeRange) return 'Medium - close range can reduce angle evidence reliability';
        if (confidence >= 75) return 'Low';
        if (confidence >= 45) return 'Medium';
        return 'High';
    },

    evidenceQualityForCase: function (group) {
        if (group.confidence >= 85) return 'High confidence case';
        if (group.confidence >= 60) return 'Moderate confidence case';
        if (group.confidence >= 40) return 'Limited confidence case';
        return 'Low-confidence case';
    },

    falsePositiveRiskForCase: function (group) {
        const latest = group.latestEvent || group.latest || group;
        if (this.isProjectileOrExplosiveWeapon(latest.weapon)) {
            return 'High - projectile/explosive weapon reduces reliability';
        }
        if (this.isStaleTelemetry(group)) {
            return 'Medium - stale or incomplete telemetry';
        }
        if (group.confidence >= 75) return 'Low';
        if (group.confidence >= 45) return 'Medium';
        return 'High';
    },

    isProjectileOrExplosiveWeapon: function (weapon) {
        const text = String(weapon || '').toLowerCase();
        return text.indexOf('gl') !== -1 ||
            text.indexOf('m79') !== -1 ||
            text.indexOf('rpg') !== -1 ||
            text.indexOf('at4') !== -1 ||
            text.indexOf('javelin') !== -1 ||
            text.indexOf('grenade') !== -1 ||
            text.indexOf('semtex') !== -1 ||
            text.indexOf('frag') !== -1 ||
            text.indexOf('c4') !== -1 ||
            text.indexOf('explosive') !== -1;
    },

    isMissingValue: function (value) {
        const text = String(value || '').trim().toLowerCase();
        return text === '' || text === '?' || text === 'unknown' || text === 'not recorded' || text === 'not available' || text === 'n/a';
    },

    dashboardStats: function (cases, items) {
        const today = new Date().toISOString().substring(0, 10);
        return {
            needsReview: cases.filter(item => this.caseStatus(item) === 'Needs Review').length,
            highPriority: cases.filter(item => this.caseStatus(item) === 'High Priority').length,
            watching: cases.filter(item => this.caseStatus(item) === 'Watching').length,
            reportsToday: items.filter(item => this.itemLooksLikeReport(item) && String(item.time || '').indexOf(today) === 0).length,
            staleTelemetry: cases.filter(item => this.isStaleTelemetry(item) && this.riskInfo(item).score >= 70 && this.confidenceInfo(item).score >= 45).length,
            actionsTaken: cases.filter(item => item.actions > 0 || item.isAutomatedBan).length
        };
    },

    riskInfo: function (item) {
        const score = item.overallRisk !== undefined
            ? Number(item.overallRisk)
            : (item.riskScore !== undefined ? Number(item.riskScore) : Math.max(
                this.numericScore(item.score),
                ...((item.events || []).map(event => Number(event.riskScore !== undefined ? event.riskScore : this.numericScore(event.score))))
            ));
        let label = 'Low';
        let tone = 'yellow';
        let className = 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30';

        if (score >= 90 || String(item.probability || '').toLowerCase().indexOf('very') !== -1) {
            label = 'Very High';
            tone = 'red';
            className = 'bg-red-600/15 text-red-300 border-red-500/40';
        } else if (score >= 70 || String(item.probability || '').toLowerCase() === 'high') {
            label = 'High';
            tone = 'red';
            className = 'bg-red-500/10 text-red-400 border-red-500/30';
        } else if (score >= 35 || String(item.probability || '').toLowerCase() === 'medium') {
            label = 'Medium';
            tone = 'orange';
            className = 'bg-orange-500/10 text-orange-400 border-orange-500/30';
        }

        return { score: Math.min(100, Math.max(0, score)), label: label, tone: tone, className: className };
    },

    confidenceInfo: function (item) {
        if (item.confidence !== undefined || item.confidenceScore !== undefined) {
            const score = this.clampScore(item.confidence !== undefined ? item.confidence : item.confidenceScore);
            let label = 'Low';
            if (score >= 90) label = 'Very High';
            else if (score >= 70) label = 'High';
            else if (score >= 45) label = 'Medium';
            return { score: score, label: label, tone: this.confidenceTone(label), className: this.confidenceClass(label) };
        }

        const quality = String(item.evidenceQuality || '').toLowerCase();
        const fpRisk = String(item.falsePositiveRisk || '').toLowerCase();
        const hard = this.isHardDetection(item.latest || item);
        let score = 35;
        let label = 'Unknown';

        if (hard || item.actions > 0 || item.kind === 'AUTO_BAN' || item.kind === 'AUTO_TEMPBAN') {
            score = 95;
            label = 'Very High';
        } else {
            const strong = Number((quality.match(/strong signals=(\d+)/) || [])[1] || 0);
            const weak = Number((quality.match(/weak signals=(\d+)/) || [])[1] || 0);

            if (strong >= 3 && strong >= weak) {
                score = 80;
                label = 'High';
            } else if (strong >= 1 || fpRisk.indexOf('medium') !== -1) {
                score = 60;
                label = 'Medium';
            } else if (fpRisk.indexOf('high') !== -1 || weak > strong) {
                score = 35;
                label = 'Low';
            }
        }

        return { score: score, label: label, tone: this.confidenceTone(label), className: this.confidenceClass(label) };
    },

    numericScore: function (value) {
        const text = String(value || '');
        const total = text.match(/(\d+)\s*total/i);
        if (total) {
            return Number(total[1]);
        }

        const numbers = text.match(/\d+/g);
        if (!numbers || numbers.length === 0) {
            return 0;
        }

        return Math.max.apply(null, numbers.map(number => Number(number)));
    },

    caseStatus: function (item) {
        if (item.clearStatus === 'cleared') {
            return 'Cleared';
        }

        if (item.watchStatus === 'watching') {
            return 'Watching';
        }

        if (item.actions > 0 || item.kind === 'AUTO_BAN' || item.kind === 'AUTO_TEMPBAN') {
            return 'Actioned';
        }

        const risk = this.riskInfo(item).score;
        const confidence = this.confidenceInfo(item).score;
        const hard = Number(item.hardDetectionCount || 0) > 0 || this.isHardDetection(item.latest || item);
        const reports = Number(item.reportsCount || item.reports || 0);
        const uniqueVictims = Number(item.uniqueVictims || 0);
        const categories = Number(item.suspiciousCategories || this.suspiciousCategoryCount(item.events || [], reports, item.hardDetectionCount || 0));
        const softEsp = (item.events || [item]).filter(event => this.isSoftEspOrLosEvent(event)).length > 0;
        const strongAimSupport = (item.events || [item]).filter(event => this.hasStrongAimAngle(event) || this.isAimLockLikeEvent(event)).length;
        const text = this.eventText(item);
        const aimLockEvidenceCount = (item.events || [item]).filter(event => {
            const eventText = this.eventText(event);
            return this.isAimLockLikeEvent(event) &&
                (eventText.indexOf('snap-lock') !== -1 ||
                    eventText.indexOf('ads snapped') !== -1 ||
                    eventText.indexOf('ads aim stayed tightly') !== -1 ||
                    eventText.indexOf('near-perfect aim') !== -1);
        }).length;
        const aimLockPattern = this.isAimLockLikeEvent(item) &&
            (text.indexOf('snap-lock') !== -1 || text.indexOf('aim lock') !== -1 || text.indexOf('aim assist') !== -1) &&
            (text.indexOf('many kills') !== -1 || text.indexOf('repeated') !== -1 || text.indexOf('pattern') !== -1);
        const strongSingleAimLock = text.indexOf('near-perfect aim') !== -1 ||
            text.indexOf('ads aim stayed tightly locked') !== -1 ||
            text.indexOf('ads snapped onto a bot') !== -1;

        const independentlySupported = hard ||
            reports > 0 ||
            uniqueVictims >= 2 ||
            categories >= 2 ||
            strongAimSupport >= 2;

        if (hard && (risk >= 80 || confidence >= 75)) {
            return 'High Priority';
        }

        if (!softEsp && (risk >= 85 || (risk >= 70 && confidence >= 70))) {
            return 'High Priority';
        }

        if (aimLockPattern && risk >= 75 && confidence >= 65 && (aimLockEvidenceCount >= 2 || reports > 0 || strongSingleAimLock)) {
            return 'High Priority';
        }

        if (softEsp && independentlySupported && risk >= 85 && confidence >= 55) {
            return 'High Priority';
        }

        if (risk >= 70 && confidence >= 45) {
            return 'Needs Review';
        }

        if (reports > 0 && risk >= 45) {
            return 'Needs Review';
        }

        return 'Watching';
    },

    statusClass: function (status) {
        if (status === 'High Priority') {
            return 'bg-red-500/10 text-red-400 border-red-500/30';
        }
        if (status === 'Needs Review') {
            return 'bg-orange-500/10 text-orange-400 border-orange-500/30';
        }
        if (status === 'Actioned') {
            return 'bg-green-500/10 text-green-400 border-green-500/30';
        }
        if (status === 'Cleared') {
            return 'bg-sky-500/10 text-sky-400 border-sky-500/30';
        }
        return 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30';
    },

    caseAccent: function (status) {
        if (status === 'High Priority') {
            return 'red';
        }
        if (status === 'Needs Review') {
            return 'orange';
        }
        if (status === 'Actioned' || status === 'Cleared') {
            return 'green';
        }
        return 'purple';
    },

    badgeClass: function (label) {
        const value = String(label || '').toLowerCase();
        let tone = 'muted';

        if (value.indexOf('high priority') !== -1 || value.indexOf('very high') !== -1 || value.indexOf('hard') !== -1) {
            tone = 'red';
        } else if (value.indexOf('needs review') !== -1 || value.indexOf('medium') !== -1) {
            tone = 'orange';
        } else if (value.indexOf('watching') !== -1 || value.indexOf('soft') !== -1 || value.indexOf('low') !== -1) {
            tone = 'purple';
        } else if (value.indexOf('sent') !== -1 || value.indexOf('actioned') !== -1 || value.indexOf('cleared') !== -1 || value.indexOf('very high') !== -1) {
            tone = 'green';
        } else if (value.indexOf('confidence') !== -1 || value.indexOf('unknown') !== -1) {
            tone = 'blue';
        }

        return `ac-badge ac-badge-${tone}`;
    },

    confidenceTone: function (label) {
        const value = String(label || '').toLowerCase();
        if (value.indexOf('very') !== -1 || value === 'high') {
            return 'green';
        }
        if (value === 'medium') {
            return 'blue';
        }
        if (value === 'low') {
            return 'yellow';
        }
        return 'muted';
    },

    confidenceClass: function (label) {
        const value = String(label || '').toLowerCase();
        if (value.indexOf('very') !== -1 || value === 'high') {
            return 'bg-green-500/10 text-green-400 border-green-500/30';
        }
        if (value === 'medium') {
            return 'bg-sky-500/10 text-sky-400 border-sky-500/30';
        }
        if (value === 'low') {
            return 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30';
        }
        return 'bg-surface-alt text-muted border-line';
    },

    plainReason: function (item) {
        if (item.mainReason) {
            return item.mainReason;
        }

        const text = [
            item.cheatType,
            item.evidenceQuality,
            item.falsePositiveRisk,
            item.lineOfSight,
            item.angle,
            item.visibleTime,
            (item.reasons || []).join(' ')
        ].join(' ').toLowerCase();

        if (item.actions > 0 || item.kind === 'AUTO_BAN' || item.kind === 'AUTO_TEMPBAN') {
            return 'Automated IW4MAdmin anti-cheat action logged.';
        }

        if (this.isHardDetection(item.latest || item)) {
            return 'Hard anti-cheat detection logged from IW4MAdmin-style telemetry.';
        }

        if (item.reports > 0 && this.riskInfo(item).score >= 45) {
            return 'Player reports overlap with suspicious telemetry.';
        }

        if (text.indexOf('snap') !== -1 || text.indexOf('aim lock') !== -1 || text.indexOf('aim assist') !== -1 || text.indexOf('silent aim') !== -1) {
            return 'Repeated aim-related detection pattern logged.';
        }

        if (text.indexOf('poor') !== -1 || text.indexOf('line-of-sight') !== -1 || text.indexOf('line of sight') !== -1 || text.indexOf('visible') !== -1) {
            return 'Poor or missing visibility evidence logged.';
        }

        if (this.riskInfo(item).score < 35) {
            return 'Low-confidence event; watch for repeat evidence.';
        }

        return 'Suspicious behavior logged; review recent context.';
    },

    recommendedAction: function (item, status, confidence) {
        if (item.recommendedAction) {
            return item.recommendedAction;
        }

        if (status === 'Actioned') {
            return 'Action already taken';
        }

        if (confidence.score >= 90 && this.riskInfo(item).score >= 70) {
            return 'High-confidence hard detection';
        }

        if (status === 'High Priority') {
            return 'Needs staff review';
        }

        if (status === 'Needs Review') {
            return item.alerts > 0 ? 'Send Discord review later' : 'Needs staff review';
        }

        return this.riskInfo(item).score < 35 ? 'Log only' : 'Keep watching';
    },

    shortActionLabel: function (action, status, hard) {
        if (status === 'Actioned') {
            return 'Actioned';
        }

        if (hard || String(action || '').toLowerCase().indexOf('hard') !== -1) {
            return 'Hard detection';
        }

        if (status === 'High Priority' || status === 'Needs Review') {
            return 'Review';
        }

        if (String(action || '').toLowerCase().indexOf('log') !== -1) {
            return 'Log only';
        }

        return 'Watch';
    },

    adminInterpretation: function (item, hard, discord, action, evidenceType) {
        if (item && item.interpretation) {
            return item.interpretation;
        }

        const risk = this.riskInfo(item).score;
        const confidence = this.confidenceInfo(item).score;
        const reports = Number(item && item.reports || 0);
        const crossedRules = discord && discord.crossedRules;

        if (item && (item.kind === 'AUTO_BAN' || item.kind === 'AUTO_TEMPBAN' || item.actions > 0)) {
            return 'IW4MAdmin already recorded an anti-cheat action for this player. Use this evidence to verify the action reason and check whether the same behavior appears in nearby events.';
        }

        if (hard && crossedRules) {
            return 'This case has hard anti-cheat telemetry and crossed Discord alert rules. Review the latest gameplay context, then prioritize spectating or staff review.';
        }

        if (hard) {
            return 'This case has hard anti-cheat telemetry, but this specific event did not cross Discord alert rules by itself. Review it alongside the player’s other events before taking action.';
        }

        if (String(item && item.cheatType || '').toLowerCase().indexOf('esp') !== -1 || String(item && item.lineOfSight || '').toLowerCase().indexOf('poor') !== -1) {
            return 'This is a soft ESP or line-of-sight suspicion event. Treat it as supporting evidence, not proof, unless repeated patterns or player reports exist.';
        }

        if (reports > 0 && risk >= 45) {
            return 'Player reports are linked with suspicious telemetry. This should be reviewed, but the report context still matters before action is taken.';
        }

        if (risk >= 70 || confidence >= 70) {
            return 'The risk or confidence is elevated. Review recent events for a repeated pattern before escalating beyond monitoring.';
        }

        return 'This is supporting evidence for the review queue. Keep watching unless the player accumulates stronger telemetry, repeated events, or staff reports.';
    },

    isHardDetection: function (item) {
        const text = this.eventText(item);
        const kind = String(item && item.kind || '').toUpperCase();

        if (kind === 'AUTO_BAN' || kind === 'AUTO_TEMPBAN' || item && item.isAutomatedBan) {
            return true;
        }

        return text.indexOf('iw4madmin') !== -1 ||
            text.indexOf('automated') !== -1 ||
            text.indexOf('bone') !== -1 ||
            text.indexOf('recoil') !== -1 ||
            text.indexOf('hard anti-cheat') !== -1 ||
            text.indexOf('hard detection') !== -1;
    },

    itemLooksLikeReport: function (item) {
        const text = [
            item && item.kind,
            item && item.cheatType,
            item && (item.reasons || []).join(' ')
        ].join(' ').toLowerCase();

        return text.indexOf('report') !== -1;
    },

    isStaleTelemetry: function (item) {
        const fields = [item.map, item.server || item.serverKey, item.lineOfSight, item.distance, item.angle, item.visibleTime];
        return fields.some(value => {
            const text = String(value || '').toLowerCase();
            return text === '' || text === '?' || text === 'unknown' || text === 'not recorded' || text === 'n/a';
        });
    },

    playerLink: function (item) {
        const name = this.escape(item.player || 'Unknown');
        const profileId = this.profileIdFor(item);

        if (!profileId) {
            return `<span class="font-semibold text-foreground">${name}</span>`;
        }

        return `<a class="font-semibold text-primary underline hover:text-primary-light" href="/client/${encodeURIComponent(profileId)}">${name}</a>`;
    },

    victimLink: function (victimName) {
        const name = this.clean(victimName || 'Not available');
        const escapedName = this.escape(name || 'Not available');
        const profileId = this.profileIdForVictimName(name);

        if (!profileId) {
            return escapedName;
        }

        return `<a class="text-primary underline hover:text-primary-light" href="/client/${encodeURIComponent(profileId)}">${escapedName}</a>`;
    },

    profileIdFor: function (item) {
        if (item && item.profileId && item.profileId !== 'Unknown') {
            return String(item.profileId);
        }

        const guid = String((item && item.guid) || '').toLowerCase();
        if (!guid || !this.manager) {
            return '';
        }

        try {
            const servers = this.toArray(this.manager.servers || this.manager.Servers);
            for (let i = 0; i < servers.length; i++) {
                const clients = this.toArray(servers[i].connectedClients || servers[i].ConnectedClients);
                for (let j = 0; j < clients.length; j++) {
                    const client = clients[j];
                    const networkId = String(client.networkId || client.NetworkId || '').toLowerCase();
                    if (networkId === guid) {
                        const clientId = client.clientId || client.ClientId;
                        return clientId ? String(clientId) : '';
                    }
                }
            }
        } catch (ex) {
            this.logger.logWarning('{Name} failed to resolve profile link: {Message}', this.name, ex.message || ex);
        }

        return this.profileIdFromMap(guid);
    },

    profileIdForVictimName: function (victimName) {
        const normalized = this.normalizedPlayerName(victimName);
        if (!normalized || normalized === 'unknown' || normalized === 'not available') {
            return '';
        }

        try {
            const io = importNamespace('System.IO');
            const path = String(this.settings.clientMapPath || '/app/Logs/iw4m-client-map.json');
            if (!io.File.Exists(path)) {
                return '';
            }

            const map = JSON.parse(String(io.File.ReadAllText(path)));
            const clients = map.clients || {};
            let match = null;

            Object.keys(clients).forEach(guid => {
                const client = clients[guid] || {};
                const clientName = this.normalizedPlayerName(client.name || client.cleanedName || client.Name || client.CleanedName || '');
                if (clientName === normalized && client.clientId) {
                    if (match === null) {
                        match = String(client.clientId);
                    } else if (match !== String(client.clientId)) {
                        match = '';
                    }
                }
            });

            return match || '';
        } catch (ex) {
            this.logger.logWarning('{Name} failed to resolve victim profile id from client map: {Message}', this.name, ex.message || ex);
        }

        return '';
    },

    profileIdFromMap: function (guid) {
        const cleanGuid = String(guid || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        if (!cleanGuid) {
            return '';
        }

        try {
            const io = importNamespace('System.IO');
            const path = String(this.settings.clientMapPath || '/app/Logs/iw4m-client-map.json');
            if (!io.File.Exists(path)) {
                return '';
            }

            const map = JSON.parse(String(io.File.ReadAllText(path)));
            const client = map.clients && map.clients[cleanGuid];
            return client && client.clientId ? String(client.clientId) : '';
        } catch (ex) {
            this.logger.logWarning('{Name} failed to resolve profile id from client map: {Message}', this.name, ex.message || ex);
        }

        return '';
    },

    metric: function (label, value) {
        return `
            <div class="rounded border border-line bg-surface-alt px-3 py-2 min-w-0">
                <div class="text-xs text-muted">${this.escape(label)}</div>
                <div class="text-foreground truncate">${this.escape(value)}</div>
            </div>`;
    },

    readEvents: function () {
        const io = importNamespace('System.IO');
        const logPath = String(this.settings.logPath || '/app/Logs/anti-cheat-combined.log');

        if (!io.File.Exists(logPath)) {
            return [];
        }

        try {
            const raw = String(io.File.ReadAllText(logPath));
            const blocks = raw.split('============================================================');
            const items = [];
            const alertIncidents = {};

            for (let i = blocks.length - 1; i >= 0 && items.length < Number(this.settings.maxItems || 75); i--) {
                const item = this.parseBlock(blocks[i]);
                if (item) {
                    const incidentKey = this.incidentKey(item);

                    if (item.kind === 'REVIEW_ALERT') {
                        continue;
                    }

                    if (item.kind === 'EVIDENCE' && incidentKey && alertIncidents[incidentKey]) {
                        continue;
                    }

                    if (item.kind === 'ALERT' && incidentKey) {
                        alertIncidents[incidentKey] = true;
                    }

                    items.push(item);
                }
            }

            return items;
        } catch (ex) {
            this.logger.logWarning('{Name} failed to read anti-cheat log: {Message}', this.name, ex.toString());
            return [];
        }
    },

    parseBlock: function (block) {
        const lines = String(block || '').split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
        if (lines.length === 0 || lines[0].indexOf('] ') === -1) {
            return null;
        }

        const first = lines[0];
        const firstMatch = first.match(/^\[([^\]]+)\]\s+([^|]+)\|\s*(.+)$/);
        if (!firstMatch) {
            return null;
        }

        const item = {
            time: firstMatch[1],
            displayTime: this.formatDisplayTime(firstMatch[1]),
            kind: firstMatch[2].trim(),
            serverKey: firstMatch[3].trim(),
            reasons: []
        };

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];

            if (line.indexOf('Player: ') === 0) {
                const match = line.match(/^Player:\s*(.*?)\s*\|\s*GUID:\s*(.*?)\s*\|\s*Client:\s*(.*?)$/);
                if (match) {
                    item.player = match[1];
                    item.guid = match[2];
                    item.client = match[3];
                }
            } else if (line.indexOf('Server: ') === 0) {
                item.server = line.substring(8);
            } else if (line.indexOf('Map: ') === 0) {
                item.map = line.substring(5);
            } else if (line.indexOf('Profile: ') === 0) {
                item.profileId = line.substring(9);
            } else if (line.indexOf('Suspicion: ') === 0) {
                const match = line.match(/^Suspicion:\s*(.*?)\s*\|\s*Probability:\s*(.*?)\s*\|\s*Type:\s*(.*?)$/);
                if (match) {
                    item.score = match[1];
                    item.probability = match[2];
                    item.cheatType = match[3];
                }
            } else if (line.indexOf('Evidence Quality: ') === 0) {
                const risk = line.match(/false-positive risk=([^|]+)$/);
                item.evidenceQuality = line.substring(18);
                item.falsePositiveRisk = risk ? risk[1].trim() : '';
            } else if (line.indexOf('Latest Target: ') === 0) {
                item.victim = line.substring(15);
            } else if (line.indexOf('Target: ') === 0) {
                item.victim = line.substring(8);
            } else if (line.indexOf('Victim: ') === 0) {
                item.victim = line.substring(8);
            } else if (line.indexOf('Weapon: ') === 0) {
                const match = line.match(/^Weapon:\s*(.*?)\s*\|\s*Hit Location:\s*(.*?)$/);
                if (match) {
                    item.weapon = match[1];
                    item.hitLocation = match[2];
                }
            } else if (line.indexOf('Metrics: ') === 0) {
                item.metrics = line.substring(9);
                item.distance = this.metricValue(line, /distance=([^|]+)/);
                item.angle = this.metricValue(line, /angle mismatch=([^|]+)/);
                item.lineOfSight = this.metricValue(line, /line of sight=([^|]+)/);
                item.visibleTime = this.metricValue(line, /visible time=([^|]+)/);
            } else if (line.indexOf('Action: ') === 0) {
                item.action = line.substring(8);
                item.isAutomatedBan = true;
            } else if (line.indexOf('Admin: ') === 0) {
                item.admin = line.substring(7);
            } else if (line.indexOf('Reporter: ') === 0) {
                const match = line.match(/^Reporter:\s*(.*?)\s*(?:\|\s*GUID:\s*(.*?))?$/);
                item.reporterName = match ? match[1] : line.substring(10);
                item.reporterGuid = match && match[2] ? match[2] : '';
            } else if (line.indexOf('Reported By: ') === 0) {
                item.reporterName = line.substring(13);
            } else if (line.indexOf('Reason: ') === 0) {
                item.reasons.push(line.substring(8));
            } else if (line.indexOf('- ') === 0) {
                item.reasons.push(line.substring(2));
            }
        }

        return item.player ? item : null;
    },

    metricValue: function (line, regex) {
        const match = String(line || '').match(regex);
        return match ? match[1].trim() : '';
    },

    incidentKey: function (item) {
        if (!item || item.isAutomatedBan) {
            return '';
        }

        return [
            this.clean(item.guid || item.player || ''),
            this.clean(item.server || item.serverKey || ''),
            this.clean(item.map || ''),
            this.clean(item.victim || ''),
            this.clean(item.weapon || ''),
            this.clean(item.hitLocation || '')
        ].join('|');
    },

    formatDisplayTime: function (value) {
        return String(value || '');
    },

    localTimeElement: function (isoValue, fallback) {
        const iso = this.escape(isoValue || '');
        const text = this.escape(fallback || isoValue || '');

        if (!iso) {
            return text;
        }

        return `<time class="js-local-time" datetime="${iso}">${text}</time>`;
    },

    formatActionTime: function (value) {
        const date = new Date(value || Date.now());
        if (Number.isNaN(date.getTime())) {
            return this.clean(value || new Date().toISOString());
        }

        const pad = number => String(number).padStart(2, '0');
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
    },

    probabilityClass: function (probability) {
        const value = String(probability || '').toLowerCase();
        if (value.indexOf('very') !== -1 || value === 'high') {
            return 'bg-red-500/10 text-red-400 border-red-500/30';
        }
        if (value === 'medium') {
            return 'bg-orange-500/10 text-orange-400 border-orange-500/30';
        }
        if (value === 'low') {
            return 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30';
        }
        return 'bg-surface-alt text-muted border-line';
    },

    discordStatus: function (item) {
        if (item && item.discordStatus) {
            const status = String(item.discordStatus || '').toLowerCase();
            const sent = status === 'sent';
            const pending = status === 'pending_review';
            const failed = status === 'failed';
            const suppressed = status === 'not_sent';
            return {
                label: sent ? 'Discord: Sent' : (pending ? 'Discord: Pending review' : (failed ? 'Discord: Failed' : (suppressed ? 'Discord: Not sent' : 'Discord: Evidence only'))),
                shortLabel: sent ? 'Sent' : (pending ? 'Pending review' : (failed ? 'Failed' : (suppressed ? 'Not sent' : 'Evidence only'))),
                title: item.discordAlertReason || (sent ? 'Reported to Discord' : (pending ? 'Eligible for Discord review' : (failed ? 'Discord review failed' : 'Evidence only'))),
                crossedRules: !!item.crossedDiscordAlertRules,
                messageId: item.discordMessageId || '',
                description: item.discordAlertReason || (sent
                    ? 'This case crossed alert rules and was sent to the anti-cheat Discord webhook.'
                    : (failed ? 'A staff review send was attempted but failed.' : 'This is supporting evidence and did not become a Discord alert by itself.')),
                className: sent || pending ? 'bg-green-500/10 text-green-400 border-green-500/30' : (failed ? 'bg-red-500/10 text-red-400 border-red-500/30' : 'bg-surface-alt text-muted border-line')
            };
        }

        const kind = String(item.kind || '').toUpperCase();

        if (kind === 'ALERT' || kind === 'REVIEW_ALERT' || kind === 'AUTO_BAN' || kind === 'AUTO_TEMPBAN') {
            return {
                label: 'Discord: Sent',
                shortLabel: 'Sent',
                title: 'Reported to Discord',
                crossedRules: true,
                messageId: '',
                description: kind.indexOf('AUTO_') === 0
                    ? 'This automated IW4MAdmin ban was sent to the anti-cheat Discord webhook.'
                    : 'This suspicion crossed the alert rules and was sent to the anti-cheat Discord webhook.',
                className: 'bg-green-500/10 text-green-400 border-green-500/30'
            };
        }

        if (kind === 'DISCORD_SUPPRESSED') {
            return {
                label: 'Discord: Suppressed',
                shortLabel: 'Suppressed',
                title: 'Not sent to Discord',
                crossedRules: false,
                messageId: '',
                description: 'The watcher kept this in the website/logs but suppressed the Discord message to avoid noisy or weak alerts.',
                className: 'bg-orange-500/10 text-orange-400 border-orange-500/30'
            };
        }

        return {
            label: 'Discord: Not sent',
            shortLabel: 'Not sent',
            title: 'Evidence only',
            crossedRules: false,
            messageId: '',
            description: 'This was logged as supporting evidence, but it did not become a Discord alert by itself.',
            className: 'bg-surface-alt text-muted border-line'
        };
    },

    discordEvidenceNote: function (discord) {
        if (!discord || !discord.description) {
            return '';
        }

        const description = String(discord.description || '').trim();
        const shortLabel = String(discord.shortLabel || '').trim();
        const title = String(discord.title || '').trim();

        if (!description || description === shortLabel || description === title) {
            return '';
        }

        return description;
    },

    toPlainObject: function (value) {
        return JSON.parse(JSON.stringify(value));
    },

    toArray: function (value) {
        if (!value) {
            return [];
        }

        if (Array.isArray(value)) {
            return value;
        }

        try {
            return Array.from(value);
        } catch (ex) {
            return [];
        }
    },

    metaValue: function (meta, key) {
        if (!meta || !key) {
            return '';
        }

        const direct = meta[key] || meta[key.charAt(0).toUpperCase() + key.slice(1)];
        if (direct !== undefined && direct !== null) {
            return direct;
        }

        const query = this.clean(meta.query || meta.Query || meta.search || meta.Search, '');
        if (!query) {
            try {
                const rawMeta = JSON.stringify(meta || {});
                const match = rawMeta.match(new RegExp(`${key}=([^&"'\\\\s]+)`, 'i'));
                if (match) {
                    return decodeURIComponent(match[1] || '');
                }
            } catch (ex) {
                return '';
            }

            return '';
        }

        const cleanQuery = query.charAt(0) === '?' ? query.substring(1) : query;
        const parts = cleanQuery.split('&');

        for (let i = 0; i < parts.length; i++) {
            const pair = parts[i].split('=');
            if (decodeURIComponent(pair[0] || '').toLowerCase() === key.toLowerCase()) {
                return decodeURIComponent(pair.slice(1).join('=') || '');
            }
        }

        return '';
    },

    buildAutomatedBanEvent: function (type, penalty, penaltyEvent, client, automatedReason) {
        const server = client.currentServer || penaltyEvent.server || penaltyEvent.Server || {};
        const punisher = penalty.punisher || penalty.Punisher || penalty.admin || penalty.Admin || penaltyEvent.origin || penaltyEvent.Origin || {};
        const action = type === 'TempBan' ? 'Temporary Ban' : 'Permanent Ban';
        const reason = automatedReason || penalty.offense || penalty.Offense || 'No reason supplied';
        const host = this.stripColors(server.hostname || server.Hostname || server.serverName || server.ServerName || server.id || 'Unknown server');

        return {
            time: new Date().toISOString(),
            kind: type === 'TempBan' ? 'AUTO_TEMPBAN' : 'AUTO_BAN',
            player: this.playerName(client),
            guid: this.clean(client.networkId || client.NetworkId || client.guid || client.GUID || ''),
            client: this.clean(client.clientNumber || client.ClientNumber || client.clientId || client.ClientId || ''),
            profileId: this.clean(client.clientId || client.ClientId || ''),
            server: host,
            map: this.clean((server.map && (server.map.name || server.map.alias)) || server.mapName || server.MapName || 'Unknown'),
            probability: 'Confirmed',
            cheatType: 'IW4MAdmin automated ban',
            score: 'Automated action',
            victim: '',
            weapon: 'N/A',
            hitLocation: 'N/A',
            lineOfSight: 'N/A',
            distance: 'N/A',
            angle: 'N/A',
            visibleTime: 'N/A',
            falsePositiveRisk: 'Review required',
            action: action,
            admin: this.playerName(punisher) || 'IW4MAdmin',
            reason: this.clean(reason)
        };
    },

    appendAutomatedBanLog: function (event) {
        const io = importNamespace('System.IO');
        const path = String(this.settings.logPath || '/app/Logs/anti-cheat-combined.log');
        const directory = io.Path.GetDirectoryName(path);

        if (directory && !io.Directory.Exists(directory)) {
            io.Directory.CreateDirectory(directory);
        }

        const block = [
            '============================================================',
            `[${event.time}] ${event.kind} | IW4MAdmin`,
            `Player: ${event.player || 'Unknown'} | GUID: ${event.guid || 'Unknown'} | Client: ${event.client || '?'}`,
            `Profile: ${event.profileId || 'Unknown'}`,
            `Server: ${event.server || 'Unknown'}`,
            `Map: ${event.map || 'Unknown'}`,
            `Suspicion: ${event.score} | Probability: ${event.probability} | Type: ${event.cheatType}`,
            `Evidence Quality: automated IW4MAdmin penalty | false-positive risk=${event.falsePositiveRisk}`,
            `Action: ${event.action}`,
            `Admin: ${event.admin}`,
            `Reason: ${event.reason}`,
            `Weapon: ${event.weapon} | Hit Location: ${event.hitLocation}`,
            `Metrics: distance=${event.distance} | angle mismatch=${event.angle} | line of sight=${event.lineOfSight} | visible time=${event.visibleTime}`,
            'What looked suspicious:',
            `  - IW4MAdmin issued an automated ${event.action.toLowerCase()}`,
            `  - ${event.reason}`,
            ''
        ].join('\n');

        io.File.AppendAllText(path, `${block}\n`);
    },

    sendAutomatedBanDiscord: function (event) {
        const webhook = this.discordWebhook();
        if (!webhook || !this.helper) {
            return;
        }

        const body = {
            username: 'IW4MAdmin Anticheat',
            content: this.settings.mention || '@here',
            allowed_mentions: { parse: ['everyone'] },
            embeds: [{
                title: 'Automated Anticheat Ban',
                description: `${event.player || 'Unknown'} was ${event.action.toLowerCase()} by IW4MAdmin.`,
                color: event.kind === 'AUTO_BAN' ? 0xfc0f03 : 0xfc4a03,
                fields: [
                    { name: 'Player', value: event.player || 'Unknown', inline: true },
                    { name: 'GUID', value: event.guid || 'Unknown', inline: true },
                    { name: 'Action', value: event.action, inline: true },
                    { name: 'Reason', value: this.truncate(event.reason || 'No reason supplied', 900), inline: false },
                    { name: 'Server', value: event.server || 'Unknown', inline: false },
                    { name: 'Map', value: event.map || 'Unknown', inline: true }
                ],
                timestamp: event.time
            }]
        };

        this.sendWebhook(webhook, body);
    },

    sendCaseReviewDiscord: function (target, webhook) {
        if (!webhook || !this.helper) {
            return {
                attempted: false,
                success: false,
                message: 'Discord review is not configured.'
            };
        }

        const risk = this.riskInfo(target);
        const confidence = this.confidenceInfo(target);
        const caseUrl = this.caseUrl(target);
        const fields = [
            { name: 'Player', value: target.player || 'Unknown', inline: true },
            { name: 'GUID', value: target.guid || 'Unknown', inline: true },
            { name: 'Risk / Confidence', value: `${risk.score}/100 / ${confidence.label}`, inline: true },
            { name: 'Server', value: target.server || 'Unknown', inline: false },
            { name: 'Map', value: target.map || target.latestMap || 'Unknown', inline: true },
            { name: 'Reports / Events', value: `${target.reportsCount || target.reports || 0} / ${target.eventsCount || (target.events || []).length}`, inline: true },
            { name: 'Reason', value: this.truncate(target.mainReason || this.plainReason(target) || 'Suspicious behavior logged.', 900), inline: false },
            { name: 'Recommended Action', value: target.recommendedAction || 'Needs staff review', inline: false }
        ];

        if (caseUrl) {
            fields.push({ name: 'Open Case', value: caseUrl, inline: false });
        }

        const body = {
            username: 'IW4MAdmin Anticheat',
            content: this.settings.mention || '@here',
            allowed_mentions: { parse: ['everyone'] },
            embeds: [{
                title: 'Anti-cheat Staff Review',
                description: `${target.player || 'Unknown'} was sent for staff review from the Anticheat Panel.`,
                color: risk.score >= 85 ? 0xfc0f03 : (risk.score >= 70 ? 0xfc8c03 : 0xd6aa5b),
                fields: fields,
                timestamp: new Date().toISOString()
            }]
        };

        try {
            this.sendWebhook(webhook, body);
            return {
                attempted: true,
                success: true,
                message: 'Discord review webhook request was sent.'
            };
        } catch (ex) {
            return {
                attempted: true,
                success: false,
                message: `Discord review failed: ${this.clean(ex.message || ex)}`
            };
        }
    },

    caseUrl: function (target) {
        const base = this.clean(this.settings.dashboardBaseUrl || '');
        if (!base) {
            return '';
        }

        const separator = base.indexOf('?') === -1 ? '?' : '&';
        return `${base}${separator}acCase=${encodeURIComponent(target.caseId || this.caseKey(target))}`;
    },

    sendWebhook: function (webhook, body) {
        const pluginScript = importNamespace('IW4MAdmin.Application.Plugin.Script');
        const dictionary = System.Collections.Generic.Dictionary(System.String, System.String);
        const headers = new dictionary();
        const request = new pluginScript.ScriptPluginWebRequest(webhook, JSON.stringify(body), 'POST', 'application/json', headers);

        try {
            this.helper.requestUrl(request, response => {
                if (String(response || '').indexOf('error') !== -1) {
                    plugin.logger.logWarning('{Name} Discord automated-ban webhook response: {Response}', plugin.name, response);
                }
            });
        } catch (ex) {
            this.logger.logWarning('{Name} failed to send automated-ban Discord webhook: {Message}', this.name, ex.message || ex);
        }
    },

    discordWebhook: function () {
        if (this.settings.webhookUrl && String(this.settings.webhookUrl).indexOf('discord.com/api/webhooks/') !== -1) {
            return String(this.settings.webhookUrl);
        }

        try {
            const io = importNamespace('System.IO');
            const path = String(this.settings.cwsSettingsPath || '/app/Configuration/cws/Settings.json');
            if (!io.File.Exists(path)) {
                return '';
            }

            const settings = JSON.parse(String(io.File.ReadAllText(path)));
            const reportHook = settings.reportsWebhookUrl || '';
            const alertHook = settings.alertsWebhookUrl || '';
            if (String(reportHook).indexOf('discord.com/api/webhooks/') !== -1) {
                return String(reportHook);
            }
            if (String(alertHook).indexOf('discord.com/api/webhooks/') !== -1) {
                return String(alertHook);
            }
        } catch (ex) {
            this.logger.logWarning('{Name} could not load Discord webhook config: {Message}', this.name, ex.message || ex);
        }

        return '';
    },

    isAutomatedBan: function (penalty, event, automatedReason) {
        const punisher = penalty.punisher || penalty.Punisher || penalty.admin || penalty.Admin || event.origin || event.Origin || {};
        const punisherId = Number(punisher.clientId || punisher.ClientId || 0);
        const punisherName = this.playerName(punisher).toLowerCase();
        const reason = String(automatedReason || penalty.offense || penalty.Offense || '').toLowerCase();
        const looksLikeAnticheat = reason.indexOf('anti-cheat') !== -1 ||
            reason.indexOf('anticheat') !== -1 ||
            reason.indexOf('cheat') !== -1 ||
            reason.indexOf('aimbot') !== -1 ||
            reason.indexOf('wallhack') !== -1 ||
            reason.indexOf('esp') !== -1 ||
            reason.indexOf('silent aim') !== -1 ||
            reason.indexOf('vpn') !== -1 ||
            reason.indexOf('detected') !== -1 ||
            reason.indexOf('automated') !== -1;

        if (penalty.automatedOffense || penalty.AutomatedOffense) {
            return true;
        }

        const penalties = punisher.administeredPenalties || punisher.AdministeredPenalties || [];
        for (let i = 0; i < penalties.length; i++) {
            if (penalties[i].automatedOffense || penalties[i].AutomatedOffense) {
                return punisherId === 1 ||
                    punisherName === 'iw4madmin' ||
                    punisherName === 'console' ||
                    punisherName.indexOf('iw4madmin') !== -1;
            }
        }

        return looksLikeAnticheat &&
            (punisherId === 1 ||
                punisherName === 'iw4madmin' ||
                punisherName === 'console' ||
                punisherName.indexOf('iw4madmin') !== -1);
    },

    automatedBanReason: function (penalty, event) {
        if (penalty.automatedOffense || penalty.AutomatedOffense) {
            return this.clean(penalty.automatedOffense || penalty.AutomatedOffense);
        }

        const punisher = penalty.punisher || penalty.Punisher || event.origin || event.Origin || {};
        const penalties = punisher.administeredPenalties || punisher.AdministeredPenalties || [];
        for (let i = 0; i < penalties.length; i++) {
            const automated = penalties[i].automatedOffense || penalties[i].AutomatedOffense;
            if (automated) {
                return this.clean(automated);
            }
        }

        return this.clean(penalty.offense || penalty.Offense || '');
    },

    playerName: function (client) {
        if (!client) {
            return '';
        }

        return this.stripColors(client.cleanedName || client.CleanedName || client.name || client.Name || client.toString());
    },

    stripColors: function (value) {
        return this.clean(value).replace(/\^[0-9:;]/g, '');
    },

    normalizedPlayerName: function (value) {
        return this.stripColors(value).toLowerCase().replace(/\s+/g, ' ').trim();
    },

    clean: function (value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
            .trim();
    },

    truncate: function (value, maxLength) {
        const text = this.clean(value);
        const length = Number(maxLength || 900);
        return text.length > length ? text.substring(0, length - 3) + '...' : text;
    },

    escape: function (value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
};
