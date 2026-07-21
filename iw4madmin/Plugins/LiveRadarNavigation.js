const init = (_, serviceResolver, __, ___) => {
    plugin.onLoad(serviceResolver);
    return plugin;
};

const plugin = {
    author: 'Xenon Servers',
    version: '1.0.0',
    name: 'Live Radar Navigation',
    logger: null,

    onLoad: function (serviceResolver) {
        this.logger = serviceResolver.resolveService('ILogger', ['ScriptPluginV2']);
        this.logger.logInformation('{Name} {Version} loaded', this.name, this.version);
    },

    interactions: [{
        name: 'Webfront::Nav::Main::LiveRadar',
        action: function () {
            const helpers = importNamespace('SharedLibraryCore.Helpers');
            const interaction = new helpers.InteractionData();

            interaction.interactionId = 'Webfront::Nav::Main::LiveRadar';
            interaction.minimumPermission = 0;
            interaction.interactionType = 2;
            interaction.source = plugin.name;
            interaction.name = 'Live Radar';
            interaction.description = 'IW4MAdmin Live Radar';
            interaction.displayMeta = 'ph-crosshair';
            interaction.scriptAction = function () {
                return `
                    <div class="mx-auto max-w-xl py-8 text-center text-muted">
                        Opening IW4MAdmin Live Radar&hellip;
                        <a class="ml-1 text-primary hover:underline" href="/radar">Continue</a>
                    </div>
                    <script>window.location.replace('/radar');</script>
                `;
            };

            return interaction;
        }
    }]
};
