const { Vec3 } = require('vec3');

const COMMAND_DELAY_MS = 45;
const LAYER_DELAY_MS = 250;

const CATALOG = {
    spruce_cottage: createSpruceCottage,
    stone_watchtower: createStoneWatchtower,
    village_well: createVillageWell,
    crop_garden: createCropGarden,
    horse_stable: createHorseStable,
    blacksmith: createBlacksmith,
    storage_shed: createStorageShed,
    wizard_tower: createWizardTower
};

async function buildBlueprint(bot, name, origin = null) {
    const blueprint = getBlueprint(name);
    const start = origin ? toVec3(origin) : bot.entity.position.floored().offset(3, 0, 0);
    await ensureCreative(bot);
    await prepareArea(bot, blueprint, start);
    await placeBlocks(bot, blueprint.blocks, start);
    await sleep(300);
    const verification = verifyBlueprint(bot, blueprint, start);
    if (!verification.verified) {
        const missing = verification.missing.slice(0, 5)
            .map(entry => `${entry.block}@${entry.x},${entry.y},${entry.z}`).join(';');
        throw new Error(
            `Blueprint verification failed: ${verification.matched}/${verification.expected} blocks; missing=${missing}`
        );
    }
    console.log(`[BUILD] ${blueprint.name} complete blocks=${blueprint.blocks.length} origin=${start.toString()}`);
    return { name: blueprint.name, origin: vector(start), ...verification };
}

async function buildShowcase(bot, origin = null) {
    const start = origin ? toVec3(origin) : bot.entity.position.floored().offset(5, 0, 0);
    await ensureCreative(bot);

    const names = Object.keys(CATALOG);
    const results = [];
    for (let i = 0; i < names.length; i++) {
        const x = start.x + (i % 4) * 18;
        const z = start.z + Math.floor(i / 4) * 18;
        results.push(await buildBlueprint(bot, names[i], new Vec3(x, start.y, z)));
    }
    return {
        verified: results.length === names.length && results.every(result => result.verified),
        expectedBlueprints: names.length,
        verifiedBlueprints: results.filter(result => result.verified).length,
        results
    };
}

function verifyBlueprint(bot, blueprint, origin) {
    const missing = missingBlueprintBlocks(bot, blueprint.blocks, origin);
    const matched = blueprint.blocks.length - missing.length;
    return {
        verified: missing.length === 0,
        matched,
        expected: blueprint.blocks.length,
        missing
    };
}

function missingBlueprintBlocks(bot, blocks, origin) {
    return blocks.filter(expected => {
        const position = origin.offset(expected.x, expected.y, expected.z);
        const expectedName = String(expected.block).split('[', 1)[0];
        return bot.blockAt(position)?.name !== expectedName;
    });
}

function vector(position) {
    return { x: position.x, y: position.y, z: position.z };
}

function getBlueprint(name) {
    const key = String(name || '').toLowerCase();
    const create = CATALOG[key];
    if (!create) {
        throw new Error(`Unknown blueprint: ${name}. Available: ${Object.keys(CATALOG).join(', ')}`);
    }
    return normalizeBlueprint(create());
}

async function ensureCreative(bot) {
    bot.chat(`/gamemode creative ${bot.username}`);
    await sleep(500);
}

async function prepareArea(bot, blueprint, origin) {
    const bounds = boundsFor(blueprint.blocks);
    const margin = 2;
    const min = origin.offset(bounds.minX - margin, 0, bounds.minZ - margin);
    const max = origin.offset(bounds.maxX + margin, Math.max(bounds.maxY + margin, 8), bounds.maxZ + margin);

    await command(bot, `/fill ${min.x} ${origin.y} ${min.z} ${max.x} ${max.y} ${max.z} air`);
    await command(bot, `/fill ${min.x} ${origin.y - 1} ${min.z} ${max.x} ${origin.y - 1} ${max.z} grass_block`);
    await sleep(400);
}

async function placeBlocks(bot, blocks, origin) {
    const ordered = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    let lastY = null;
    for (const block of ordered) {
        if (lastY !== null && block.y !== lastY) await sleep(LAYER_DELAY_MS);
        lastY = block.y;
        const position = origin.offset(block.x, block.y, block.z);
        await command(bot, `/setblock ${position.x} ${position.y} ${position.z} ${block.block}`);
    }
    // Attachment blocks can be evaluated before a support in a higher layer.
    // Once the full structure exists, retry only blocks absent from world state.
    for (let pass = 0; pass < 2; pass++) {
        const missing = missingBlueprintBlocks(bot, blocks, origin);
        if (missing.length === 0) break;
        for (const expected of missing) {
            const position = origin.offset(expected.x, expected.y, expected.z);
            await command(bot, `/setblock ${position.x} ${position.y} ${position.z} ${expected.block}`);
        }
        await sleep(150);
    }
}

async function command(bot, text) {
    bot.chat(text);
    await sleep(COMMAND_DELAY_MS);
}

function normalizeBlueprint(blueprint) {
    const deduped = new Map();
    for (const block of blueprint.blocks) {
        if (!block.block || block.block === 'air') continue;
        deduped.set(`${block.x},${block.y},${block.z}`, block);
    }
    return {
        name: blueprint.name,
        blocks: [...deduped.values()]
    };
}

function boundsFor(blocks) {
    return blocks.reduce((bounds, block) => ({
        minX: Math.min(bounds.minX, block.x),
        minY: Math.min(bounds.minY, block.y),
        minZ: Math.min(bounds.minZ, block.z),
        maxX: Math.max(bounds.maxX, block.x),
        maxY: Math.max(bounds.maxY, block.y),
        maxZ: Math.max(bounds.maxZ, block.z)
    }), {
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity
    });
}

function block(x, y, z, name) {
    return { x, y, z, block: name };
}

function fill(blocks, from, to, name) {
    for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x++) {
        for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y++) {
            for (let z = Math.min(from.z, to.z); z <= Math.max(from.z, to.z); z++) {
                blocks.push(block(x, y, z, name));
            }
        }
    }
}

function hollowBox(blocks, min, max, wall, floor = null, roof = null) {
    if (floor) fill(blocks, { x: min.x, y: min.y, z: min.z }, { x: max.x, y: min.y, z: max.z }, floor);
    for (let y = min.y + 1; y <= max.y; y++) {
        for (let x = min.x; x <= max.x; x++) {
            for (let z = min.z; z <= max.z; z++) {
                const edge = x === min.x || x === max.x || z === min.z || z === max.z;
                if (edge) blocks.push(block(x, y, z, wall));
            }
        }
    }
    if (roof) fill(blocks, { x: min.x, y: max.y + 1, z: min.z }, { x: max.x, y: max.y + 1, z: max.z }, roof);
}

function addDoorAndWindows(blocks, doorX, doorZ, facing = 'north') {
    const door = facing === 'south' ? 'oak_door[facing=south,half=lower]' : 'oak_door[facing=north,half=lower]';
    const doorTop = door.replace('half=lower', 'half=upper');
    blocks.push(block(doorX, 1, doorZ, door));
    blocks.push(block(doorX, 2, doorZ, doorTop));
    blocks.push(block(doorX - 2, 2, doorZ, 'glass_pane'));
    blocks.push(block(doorX + 2, 2, doorZ, 'glass_pane'));
}

function createSpruceCottage() {
    const blocks = [];
    hollowBox(blocks, { x: 0, y: 0, z: 0 }, { x: 6, y: 3, z: 6 }, 'spruce_planks', 'cobblestone', null);
    addDoorAndWindows(blocks, 3, 0);
    for (let y = 4; y <= 6; y++) {
        const inset = y - 4;
        fill(blocks, { x: -1 + inset, y, z: -1 + inset }, { x: 7 - inset, y, z: 7 - inset }, 'spruce_stairs[facing=north]');
    }
    blocks.push(block(1, 1, 5, 'crafting_table'));
    blocks.push(block(5, 1, 5, 'furnace'));
    blocks.push(block(3, 1, 5, 'chest'));
    blocks.push(block(3, 4, 3, 'lantern[hanging=true]'));
    return { name: 'spruce_cottage', blocks };
}

function createStoneWatchtower() {
    const blocks = [];
    hollowBox(blocks, { x: 0, y: 0, z: 0 }, { x: 4, y: 8, z: 4 }, 'stone_bricks', 'stone_bricks', null);
    for (let y = 2; y <= 7; y += 2) {
        blocks.push(block(2, y, 0, 'glass_pane'));
        blocks.push(block(2, y, 4, 'glass_pane'));
        blocks.push(block(0, y, 2, 'glass_pane'));
        blocks.push(block(4, y, 2, 'glass_pane'));
    }
    fill(blocks, { x: -1, y: 9, z: -1 }, { x: 5, y: 9, z: 5 }, 'stone_bricks');
    for (const [x, z] of [[-1, -1], [1, -1], [3, -1], [5, -1], [-1, 1], [5, 1], [-1, 3], [5, 3], [-1, 5], [1, 5], [3, 5], [5, 5]]) {
        blocks.push(block(x, 10, z, 'stone_brick_wall'));
    }
    blocks.push(block(2, 1, 0, 'oak_door[facing=north,half=lower]'));
    blocks.push(block(2, 2, 0, 'oak_door[facing=north,half=upper]'));
    blocks.push(block(2, 10, 2, 'campfire[lit=true]'));
    return { name: 'stone_watchtower', blocks };
}

function createVillageWell() {
    const blocks = [];
    fill(blocks, { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, 'stone_bricks');
    fill(blocks, { x: 1, y: 1, z: 1 }, { x: 3, y: 1, z: 3 }, 'water');
    for (const [x, z] of [[0, 0], [4, 0], [0, 4], [4, 4]]) {
        fill(blocks, { x, y: 1, z }, { x, y: 4, z }, 'oak_fence');
    }
    fill(blocks, { x: -1, y: 5, z: -1 }, { x: 5, y: 5, z: 5 }, 'spruce_slab[type=top]');
    blocks.push(block(2, 4, 2, 'lantern[hanging=true]'));
    return { name: 'village_well', blocks };
}

function createCropGarden() {
    const blocks = [];
    fill(blocks, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 6 }, 'farmland[moisture=7]');
    fill(blocks, { x: 5, y: 0, z: 0 }, { x: 5, y: 0, z: 6 }, 'water');
    for (let x = 0; x <= 10; x++) {
        for (let z = 0; z <= 6; z++) {
            if (x === 5) continue;
            blocks.push(block(x, 1, z, (x + z) % 3 === 0 ? 'carrots[age=7]' : 'wheat[age=7]'));
        }
    }
    for (let x = -1; x <= 11; x++) {
        blocks.push(block(x, 1, -1, 'oak_fence'));
        blocks.push(block(x, 1, 7, 'oak_fence'));
    }
    for (let z = 0; z <= 6; z++) {
        blocks.push(block(-1, 1, z, 'oak_fence'));
        blocks.push(block(11, 1, z, 'oak_fence'));
    }
    blocks.push(block(5, 1, -1, 'oak_fence_gate[facing=north]'));
    return { name: 'crop_garden', blocks };
}

function createHorseStable() {
    const blocks = [];
    fill(blocks, { x: 0, y: 0, z: 0 }, { x: 8, y: 0, z: 6 }, 'coarse_dirt');
    for (const x of [0, 4, 8]) {
        fill(blocks, { x, y: 1, z: 0 }, { x, y: 4, z: 0 }, 'oak_log');
        fill(blocks, { x, y: 1, z: 6 }, { x, y: 4, z: 6 }, 'oak_log');
    }
    fill(blocks, { x: 0, y: 4, z: 0 }, { x: 8, y: 4, z: 6 }, 'spruce_planks');
    fill(blocks, { x: -1, y: 5, z: -1 }, { x: 9, y: 5, z: 7 }, 'spruce_stairs[facing=north]');
    for (let z = 1; z <= 5; z++) {
        blocks.push(block(4, 1, z, 'oak_fence'));
    }
    blocks.push(block(2, 1, 0, 'oak_fence_gate[facing=north]'));
    blocks.push(block(6, 1, 0, 'oak_fence_gate[facing=north]'));
    blocks.push(block(2, 1, 5, 'hay_block'));
    blocks.push(block(6, 1, 5, 'hay_block'));
    return { name: 'horse_stable', blocks };
}

function createBlacksmith() {
    const blocks = [];
    hollowBox(blocks, { x: 0, y: 0, z: 0 }, { x: 7, y: 3, z: 5 }, 'cobblestone', 'stone_bricks', null);
    addDoorAndWindows(blocks, 3, 0);
    fill(blocks, { x: -1, y: 4, z: -1 }, { x: 8, y: 4, z: 6 }, 'dark_oak_planks');
    fill(blocks, { x: 1, y: 1, z: 4 }, { x: 2, y: 1, z: 4 }, 'furnace[facing=north]');
    blocks.push(block(5, 1, 4, 'anvil'));
    blocks.push(block(6, 1, 4, 'smithing_table'));
    blocks.push(block(1, 1, 1, 'lava'));
    blocks.push(block(1, 2, 1, 'iron_bars'));
    blocks.push(block(4, 1, 4, 'chest'));
    return { name: 'blacksmith', blocks };
}

function createStorageShed() {
    const blocks = [];
    hollowBox(blocks, { x: 0, y: 0, z: 0 }, { x: 6, y: 3, z: 4 }, 'oak_planks', 'spruce_planks', 'spruce_planks');
    addDoorAndWindows(blocks, 3, 0);
    for (let x = 1; x <= 5; x += 2) {
        blocks.push(block(x, 1, 3, 'chest[facing=north]'));
        blocks.push(block(x, 2, 3, 'barrel[facing=north]'));
    }
    blocks.push(block(3, 1, 2, 'crafting_table'));
    return { name: 'storage_shed', blocks };
}

function createWizardTower() {
    const blocks = [];
    for (let y = 0; y <= 10; y++) {
        for (let x = -2; x <= 2; x++) {
            for (let z = -2; z <= 2; z++) {
                const d = Math.abs(x) + Math.abs(z);
                if (d === 2 || d === 3) blocks.push(block(x, y, z, y % 2 === 0 ? 'deepslate_bricks' : 'cobbled_deepslate'));
            }
        }
    }
    for (let y = 3; y <= 9; y += 3) {
        blocks.push(block(0, y, -2, 'purple_stained_glass_pane'));
        blocks.push(block(0, y, 2, 'purple_stained_glass_pane'));
    }
    fill(blocks, { x: -3, y: 11, z: -3 }, { x: 3, y: 11, z: 3 }, 'amethyst_block');
    fill(blocks, { x: -2, y: 12, z: -2 }, { x: 2, y: 12, z: 2 }, 'purple_wool');
    blocks.push(block(0, 13, 0, 'lightning_rod'));
    blocks.push(block(0, 1, -2, 'dark_oak_door[facing=north,half=lower]'));
    blocks.push(block(0, 2, -2, 'dark_oak_door[facing=north,half=upper]'));
    return { name: 'wizard_tower', blocks };
}

function toVec3(value) {
    if (value instanceof Vec3) return value.floored();
    return new Vec3(Number(value.x), Number(value.y), Number(value.z)).floored();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    buildBlueprint,
    buildShowcase,
    getBlueprint,
    listBlueprints: () => Object.keys(CATALOG)
};
