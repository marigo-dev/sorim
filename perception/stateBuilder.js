const IMPORTANT_BLOCKS = new Set([
    'stone', 'cobblestone', 'coal_ore', 'deepslate_coal_ore',
    'iron_ore', 'deepslate_iron_ore', 'crafting_table', 'furnace',
    'chest', 'barrel', 'torch', 'bed', 'farmland', 'water', 'lava'
]);

function buildWorldState(bot, options = {}) {
    if (!bot.entity) return null;
    const position = bot.entity.position;
    const inventory = countInventory(bot);
    const entities = scanEntities(bot, position);
    const blocks = options.blocks || scanBlocks(bot, Number(options.blockRange || 48));
    const base = options.base || null;
    const environment = readEnvironment(bot);

    const state = {
        timestamp: Date.now(),
        self: {
            position: vector(position),
            velocity: vector(bot.entity.velocity || { x: 0, y: 0, z: 0 }, false),
            health: finite(bot.health, 20),
            food: finite(bot.food, 20),
            oxygen: finite(bot.oxygenLevel, 20),
            onGround: Boolean(bot.entity.onGround),
            inWater: Boolean(bot.entity.isInWater || bot.entity.isInBubbleColumn),
            equipment: equipment(bot)
        },
        inventory,
        environment,
        entities,
        players: entities.filter(entity => entity.kind === 'player'),
        blocks: categorizeBlocks(blocks),
        nearbyBlocks: blocks,
        nearbyMobs: entities
            .filter(entity => entity.kind !== 'player')
            .slice(0, 8)
            .map(entity => ({ id: entity.id, name: entity.name, distance: entity.distance })),
        base,
        recentEvents: options.events || [],
        lastError: options.lastError || null
    };

    return state;
}

function toObservation(state, extras = {}) {
    if (!state) return null;
    return {
        health: state.self.health,
        food: state.self.food,
        oxygen: state.self.oxygen,
        position: state.self.position,
        inventory: state.inventory,
        inventoryText: inventoryText(state.inventory),
        nearbyBlocks: state.nearbyBlocks,
        nearbyMobs: state.nearbyMobs,
        worldState: state,
        base: state.base,
        lastError: state.lastError,
        ...extras
    };
}

function scanBlocks(bot, maxDistance) {
    const positions = bot.findBlocks({
        matching: block => Boolean(
            block?.name?.endsWith('_log') ||
            IMPORTANT_BLOCKS.has(block?.name) ||
            block?.name?.endsWith('_bed')
        ),
        maxDistance,
        count: 160
    });

    return positions
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .map(block => ({
            name: block.name,
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
            distance: rounded(block.position.distanceTo(bot.entity.position))
        }))
        .sort((left, right) => {
            const logPriority = Number(right.name.endsWith('_log')) - Number(left.name.endsWith('_log'));
            return logPriority || left.distance - right.distance;
        })
        .slice(0, 48);
}

function scanEntities(bot, origin) {
    return Object.values(bot.entities || {})
        .filter(entity => entity !== bot.entity && entity.position)
        .map(entity => ({
            id: entity.id,
            name: entity.name || entity.username || entity.displayName || 'unknown',
            kind: entity.type || 'unknown',
            position: vector(entity.position),
            distance: rounded(entity.position.distanceTo(origin)),
            visible: typeof bot.canSeeEntity === 'function' ? Boolean(bot.canSeeEntity(entity)) : null
        }))
        .filter(entity => entity.distance <= 32)
        .sort((left, right) => left.distance - right.distance)
        .slice(0, 32);
}

function categorizeBlocks(blocks) {
    const result = { resources: [], utilities: [], hazards: [] };
    for (const block of blocks) {
        if (['lava', 'water'].includes(block.name)) result.hazards.push(block);
        else if (['crafting_table', 'furnace', 'chest', 'barrel', 'torch'].includes(block.name) || block.name.endsWith('_bed')) {
            result.utilities.push(block);
        } else {
            result.resources.push(block);
        }
    }
    return result;
}

function readEnvironment(bot) {
    const time = Number(bot.time?.timeOfDay || 0);
    return {
        dimension: bot.game?.dimension || bot.game?.dimensionName || 'unknown',
        timeOfDay: time,
        phase: time >= 12500 && time <= 23500 ? 'night' : 'day',
        weather: bot.isRaining ? 'rain' : 'clear'
    };
}

function equipment(bot) {
    const slots = {};
    for (const [name, slot] of [['head', 5], ['torso', 6], ['legs', 7], ['feet', 8]]) {
        slots[name] = bot.inventory?.slots?.[slot]?.name || null;
    }
    slots.mainHand = bot.heldItem?.name || null;
    return slots;
}

function countInventory(bot) {
    const counts = {};
    for (const item of bot.inventory?.slots?.filter(Boolean) || []) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
    }
    if (bot.heldItem) {
        counts[bot.heldItem.name] = Math.max(counts[bot.heldItem.name] || 0, bot.heldItem.count);
    }
    return counts;
}

function inventoryText(inventory) {
    return Object.entries(inventory).map(([name, count]) => `${name}:${count}`).join(', ') || 'empty';
}

function vector(value, floor = true) {
    const convert = floor ? Math.floor : number => Number(number.toFixed(3));
    return { x: convert(value.x), y: convert(value.y), z: convert(value.z) };
}

function finite(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function rounded(value) {
    return Number(value.toFixed(1));
}

module.exports = { buildWorldState, toObservation, scanBlocks, countInventory, inventoryText };
