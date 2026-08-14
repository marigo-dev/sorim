const EventStream = require('./eventStream');
const stateBuilder = require('./stateBuilder');

class SensorManager {
    constructor(bot, options = {}) {
        this.bot = bot;
        this.events = new EventStream(options.eventLimit || 128);
        this.getBase = options.getBase || (() => null);
        this.blockScanIntervalMs = Number(options.blockScanIntervalMs || 1500);
        this.cachedBlocks = [];
        this.lastBlockScanAt = 0;
        this.lastInventory = '';
        this.installListeners();
    }

    installListeners() {
        this.bot.on('health', () => {
            this.events.push('health_changed', {
                health: this.bot.health,
                food: this.bot.food,
                oxygen: this.bot.oxygenLevel
            }, this.bot.health <= 8 ? 0.8 : 0.25);
        });
        this.bot.on('death', () => this.events.push('death', {}, 1));
        this.bot.on('entityHurt', entity => {
            if (entity !== this.bot.entity) return;
            this.events.push('damage_received', { health: this.bot.health }, 0.8);
        });
        this.bot.on('playerCollect', (collector, collected) => {
            if (collector !== this.bot.entity) return;
            this.events.push('item_collected', {
                entityId: collected?.id,
                item: collected?.metadata?.[8]?.itemId || 'unknown'
            }, 0.35);
        });

        const client = this.bot._client;
        for (const packetName of ['sound_effect', 'entity_sound_effect']) {
            client?.on(packetName, packet => {
                this.events.push('sound_heard', {
                    sound: String(packet?.soundName || packet?.soundId || packet?.soundEvent || 'unknown'),
                    x: packet?.x,
                    y: packet?.y,
                    z: packet?.z
                }, 0.2);
            });
        }
    }

    recordChat(username, message) {
        this.events.push('chat_received', { username, message }, 0.65);
    }

    record(type, details, importance) {
        return this.events.push(type, details, importance);
    }

    capture(lastError = null, extras = {}) {
        const now = Date.now();
        if (now - this.lastBlockScanAt >= this.blockScanIntervalMs) {
            this.cachedBlocks = stateBuilder.scanBlocks(this.bot, 48);
            this.lastBlockScanAt = now;
        }
        const state = stateBuilder.buildWorldState(this.bot, {
            blocks: this.cachedBlocks,
            events: this.events.recent(20),
            base: this.getBase(),
            lastError
        });
        const observation = stateBuilder.toObservation(state, extras);
        const inventorySignature = observation?.inventoryText || '';
        if (inventorySignature !== this.lastInventory) {
            this.lastInventory = inventorySignature;
            this.events.push('inventory_changed', { inventory: observation.inventory }, 0.2);
        }
        return observation;
    }
}

module.exports = SensorManager;
