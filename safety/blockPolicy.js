const persistentMemory = require('../agent/persistentMemory');
const worldMemory = require('../skills/memory');

const STRUCTURAL_NEIGHBORS = new Set([
    'chest', 'barrel', 'crafting_table', 'furnace', 'glass', 'glass_pane',
    'lantern', 'torch', 'ladder', 'bookshelf'
]);

function canBreak(bot, block, purpose = 'mining') {
    if (!block?.position) return { allowed: false, reason: 'missing block position' };
    const zone = protectedZoneAt(block.position);
    if (zone) {
        const policyName = purpose === 'tree_cutting' ? 'treeCutting' : 'mining';
        if (zone.policies?.[policyName] === false) {
            return { allowed: false, reason: `inside protected zone ${zone.id}` };
        }
    }
    if (purpose === 'tree_cutting' && looksStructural(bot, block)) {
        return { allowed: false, reason: 'log is connected to building materials' };
    }
    return { allowed: true, reason: 'policy allows block' };
}

function canHarvestTree(bot, block) {
    return canBreak(bot, block, 'tree_cutting');
}

function syncBaseProtection(base, radius = 10) {
    if (!base) return;
    persistentMemory.addProtectedZone({
        id: 'main_base',
        type: 'protected_build',
        bounds: {
            min: { x: base.x - radius, y: base.y - 6, z: base.z - radius },
            max: { x: base.x + radius, y: base.y + 16, z: base.z + radius }
        },
        policies: { mining: false, treeCutting: false, terrainModification: 'repair_only' }
    });
}

function protectedZoneAt(position) {
    const rememberedBase = worldMemory.getBase();
    if (rememberedBase) syncBaseProtection(rememberedBase);
    return persistentMemory.getProtectedZones().find(zone => inside(position, zone.bounds)) || null;
}

function inside(position, bounds) {
    return position.x >= bounds.min.x && position.x <= bounds.max.x &&
        position.y >= bounds.min.y && position.y <= bounds.max.y &&
        position.z >= bounds.min.z && position.z <= bounds.max.z;
}

function looksStructural(bot, block) {
    const offsets = [
        [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ];
    return offsets.some(([x, y, z]) => {
        const neighbor = bot.blockAt(block.position.offset(x, y, z));
        const name = neighbor?.name || '';
        return STRUCTURAL_NEIGHBORS.has(name) || name.endsWith('_planks') ||
            name.endsWith('_fence') || name.endsWith('_door') || name.endsWith('_stairs') ||
            name.endsWith('_slab') || name.includes('brick');
    });
}

module.exports = { canBreak, canHarvestTree, syncBaseProtection, protectedZoneAt };
