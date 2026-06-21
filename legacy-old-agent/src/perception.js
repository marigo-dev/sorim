const { summarizeInventory, entityName } = require('./utils');

const HOSTILE_MOBS = new Set([
    'zombie',
    'zombie_villager',
    'drowned',
    'husk',
    'skeleton',
    'stray',
    'creeper',
    'spider',
    'cave_spider',
    'witch',
    'phantom',
    'slime',
    'magma_cube',
    'pillager',
    'vindicator',
    'evoker',
    'vex',
    'guardian',
    'elder_guardian',
    'enderman',
    'piglin_brute',
    'zoglin',
    'wither_skeleton'
]);

class Perception {
    constructor(bot) {
        this.bot = bot;
    }

    observe() {
        const commonNames = new Set(['stone', 'deepslate', 'cobblestone']);
        const valuableIds = Object.values(this.bot.registry.blocksByName)
            .filter(block =>
                isRelevantBlock(block.name) &&
                !commonNames.has(block.name)
            )
            .map(block => block.id);
        const valuableBlocks = this.bot.findBlocks({
            matching: valuableIds,
            maxDistance: 64,
            count: 512
        })
            .map(position => this.bot.blockAt(position))
            .filter(block =>
                block &&
                (
                    !requiresExposedFace(block.name) ||
                    this.hasOpenFace(block.position)
                )
            );
        const commonBlocks = [...commonNames]
            .map(name => {
                const id = this.bot.registry.blocksByName[name]?.id;
                return id == null
                    ? null
                    : this.bot.findBlock({ matching: id, maxDistance: 64 });
            })
            .filter(block =>
                block &&
                (
                    !requiresExposedFace(block.name) ||
                    this.hasOpenFace(block.position)
                )
            );
        const blocks = [...valuableBlocks, ...commonBlocks];

        const nearestByName = new Map();
        for (const block of blocks) {
            const distance = block.position.distanceTo(this.bot.entity.position);
            const existing = nearestByName.get(block.name);

            if (!existing || distance < existing.distance) {
                nearestByName.set(block.name, {
                    name: block.name,
                    distance: Number(distance.toFixed(1))
                });
            }
        }

        const mobs = Object.values(this.bot.entities)
            .filter(entity =>
                entity !== this.bot.entity &&
                entityName(entity) &&
                entity.position.distanceTo(this.bot.entity.position) <= 32
            )
            .map(entity => ({
                id: entity.id,
                name: entityName(entity),
                position: {
                    x: entity.position.x,
                    y: entity.position.y,
                    z: entity.position.z
                },
                distance: Number(
                    entity.position.distanceTo(this.bot.entity.position).toFixed(1)
                )
            }))
            .sort((a, b) => a.distance - b.distance);

        return {
            health: this.bot.health,
            food: this.bot.food,
            timeOfDay: this.bot.time.timeOfDay,
            isNight: !this.bot.time.isDay,
            inWater: Boolean(this.bot.entity.isInWater),
            position: {
                x: Math.floor(this.bot.entity.position.x),
                y: Math.floor(this.bot.entity.position.y),
                z: Math.floor(this.bot.entity.position.z)
            },
            inventory: summarizeInventory(this.bot),
            nearbyBlocks: [...nearestByName.values()]
                .sort((a, b) => a.distance - b.distance),
            nearbyMobs: mobs,
            hostileMobs: mobs.filter(mob =>
                HOSTILE_MOBS.has(mob.name) &&
                mob.distance <= hostileAwarenessRange(mob.name)
            )
        };
    }

    hasOpenFace(position) {
        const faces = [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1]
        ];

        return faces.some(([x, y, z]) => {
            const neighbor = this.bot.blockAt(position.offset(x, y, z));
            return neighbor && (
                neighbor.name === 'air' ||
                neighbor.name === 'cave_air'
            );
        });
    }
}

module.exports = Perception;

function isRelevantBlock(name) {
    return name.endsWith('_log') ||
        name.endsWith('_wood') ||
        name.endsWith('_stem') ||
        name.endsWith('_hyphae') ||
        name.endsWith('_ore') ||
        name === 'stone' ||
        name === 'deepslate' ||
        name === 'cobblestone' ||
        name === 'crafting_table' ||
        name === 'furnace' ||
        name === 'chest' ||
        name.endsWith('_bed') ||
        name === 'sand' ||
        name === 'gravel' ||
        name === 'clay' ||
        name === 'bamboo_block';
}

function requiresExposedFace(name) {
    return name === 'stone' ||
        name === 'deepslate' ||
        name === 'cobblestone' ||
        name.endsWith('_ore');
}

function hostileAwarenessRange(name) {
    if (name === 'creeper') return 20;
    if (name === 'slime' || name === 'magma_cube') return 14;
    if (name === 'skeleton' || name === 'stray' || name === 'pillager') return 32;
    if (name === 'witch' || name === 'phantom') return 28;
    return 18;
}
