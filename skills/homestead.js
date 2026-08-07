const { Vec3 } = require('vec3');
const movement = require('./movement');
const tools = require('./tools');
const craft = require('./craft');
const mine = require('./mine');
const mining = require('./mining');
const smelting = require('./smelting');
const shelter = require('./shelter');
const memory = require('./memory');
const actionControl = require('./actionControl');

const BED_COLORS = [
    'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
    'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
];
const LOG_NAMES = [
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'cherry_log', 'mangrove_log'
];
const PLANK_NAMES = [
    'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks',
    'dark_oak_planks', 'cherry_planks', 'mangrove_planks'
];
const TILLABLE = new Set(['dirt', 'grass_block', 'dirt_path', 'farmland']);
const FARM_RADIUS = 4;
const FOOD_FARM_TARGET = 48;

async function secureBed(bot) {
    const actionVersion = actionControl.snapshot(bot);
    if (hasBed(bot)) return;
    await shelter.leaveBase(bot);
    actionControl.assertActive(bot, actionVersion);

    let bed = findInventoryBed(bot);
    if (!bed) {
        await ensurePlanks(bot, 3);
        actionControl.assertActive(bot, actionVersion);
        const color = await ensureMatchingWool(bot, 3);
        actionControl.assertActive(bot, actionVersion);
        await craft.craftItem(bot, `${color}_bed`, 1);
        bed = findInventoryBed(bot);
    }
    if (!bed) throw new Error('Bed could not be crafted');

    await craft.placeBlock(bot, bed.name);
    memory.setProgress('bedReady', 1);
    console.log(`[HOMESTEAD] bed ready ${bed.name}`);
}

async function establishWheatFarm(bot) {
    const actionVersion = actionControl.snapshot(bot);
    if (hasFarm(bot)) return;
    await shelter.leaveBase(bot);
    actionControl.assertActive(bot, actionVersion);

    const site = findFarmSite(bot);
    if (!site) throw new Error('No 3x3 dirt or grass farm site near base');
    await ensureSeeds(bot, 8);
    actionControl.assertActive(bot, actionVersion);
    await ensureHoe(bot);
    actionControl.assertActive(bot, actionVersion);
    if (bot.blockAt(site.offset(0, -1, 0))?.name !== 'water') {
        await ensureWaterBucket(bot);
        actionControl.assertActive(bot, actionVersion);
    }
    await placeFarmWater(bot, site);
    actionControl.assertActive(bot, actionVersion);

    let planted = 0;
    for (const position of farmRing(site)) {
        actionControl.assertActive(bot, actionVersion);
        const farmland = await tillPosition(bot, position);
        if (!farmland) continue;
        if (await plantSeed(bot, farmland)) planted++;
    }
    if (planted < 6 || countFarmBlocks(bot, site) < 6) {
        throw new Error(`Farm incomplete: planted=${planted}`);
    }
    memory.setProgress('farmReady', 1);
    memory.setFarmCenter(site);
    console.log(`[HOMESTEAD] hydrated wheat farm ready center=${site.toString()} planted=${planted}`);
}

async function expandWheatFarm(bot, target = FOOD_FARM_TARGET) {
    const actionVersion = actionControl.snapshot(bot);
    const center = findFarmCenter(bot);
    if (!center) throw new Error('Existing wheat farm center could not be found');
    await ensureHoe(bot);

    const boundedTarget = Math.max(8, Math.min(80, Number(target) || FOOD_FARM_TARGET));
    let capacity = farmCapacity(bot, center);
    let planted = 0;
    for (const position of farmPlotPositions(center)) {
        actionControl.assertActive(bot, actionVersion);
        if (capacity >= boundedTarget || countItem(bot, 'wheat_seeds') <= 0) break;

        const above = bot.blockAt(position);
        if (above?.name === 'wheat') continue;
        if (!isAir(above)) continue;

        const before = bot.blockAt(position.offset(0, -1, 0));
        if (!TILLABLE.has(before?.name)) continue;
        const farmland = await tillPosition(bot, position);
        if (!farmland) continue;
        if (before?.name !== 'farmland') capacity++;
        if (await plantSeed(bot, farmland)) planted++;
    }

    if (capacity >= 6) {
        memory.setProgress('farmReady', 1);
        memory.setFarmCenter(center);
    }
    console.log(`[HOMESTEAD] farm expansion capacity=${capacity}/${boundedTarget} planted=${planted}`);
    return { capacity, planted, target: boundedTarget };
}

function hasBed(bot) {
    const ids = Object.values(bot.registry.blocksByName || {})
        .filter(block => block.name.endsWith('_bed'))
        .map(block => block.id);
    const nearbyBed = ids.length > 0 && Boolean(bot.findBlock({ matching: ids, maxDistance: 32 }));
    if (nearbyBed) return true;
    if (memory.getProgress('bedReady') < 1) return false;
    if (!isNearBase(bot, 40)) return true;

    memory.setProgress('bedReady', 0);
    return false;
}

function hasFarm(bot) {
    const farmlandId = bot.registry.blocksByName.farmland?.id;
    if (!Number.isInteger(farmlandId)) return false;
    const center = findFarmCenter(bot);
    const farmlandCount = center ? farmCapacity(bot, center) : 0;
    if (farmlandCount >= 6 && (
        memory.getProgress('farmReady') >= 1 || countNearbyCrops(bot, 24) >= 6
    )) {
        return true;
    }
    if (memory.getProgress('farmReady') < 1) return false;
    if (!isNearBase(bot, 40)) return true;

    memory.setProgress('farmReady', 0);
    memory.clearFarmCenter();
    return false;
}

function hasMatureCrop(bot) {
    const wheatId = bot.registry.blocksByName.wheat?.id;
    if (!Number.isInteger(wheatId)) return false;
    return bot.findBlocks({ matching: wheatId, maxDistance: 24, count: 32 })
        .map(position => bot.blockAt(position))
        .some(block => Number(block?.getProperties?.().age) >= 7);
}

function growingCropCount(bot) {
    const center = findFarmCenter(bot);
    if (!center) return 0;
    return farmPlotPositions(center)
        .map(position => bot.blockAt(position))
        .filter(block => block?.name === 'wheat')
        .filter(block => Number(block.getProperties?.().age) < 7)
        .length;
}

function farmCapacity(bot, center = findFarmCenter(bot)) {
    if (!center) return 0;
    return farmPlotPositions(center)
        .filter(position => bot.blockAt(position.offset(0, -1, 0))?.name === 'farmland')
        .length;
}

function findFarmCenter(bot) {
    const remembered = memory.getFarmCenter();
    if (remembered) {
        const center = new Vec3(remembered.x, remembered.y, remembered.z);
        if (
            bot.blockAt(center.offset(0, -1, 0))?.name === 'water' &&
            farmCapacityAt(bot, center) >= 6
        ) {
            return center;
        }
    }

    const waterId = bot.registry.blocksByName.water?.id;
    if (!Number.isInteger(waterId)) return null;
    const candidate = bot.findBlocks({ matching: waterId, maxDistance: 32, count: 32 })
        .map(position => position.offset(0, 1, 0))
        .map(center => ({ center, capacity: farmCapacityAt(bot, center) }))
        .filter(entry => entry.capacity >= 6)
        .sort((left, right) => right.capacity - left.capacity)[0]?.center || null;
    if (candidate) memory.setFarmCenter(candidate);
    return candidate;
}

async function ensureMatchingWool(bot, minimum) {
    let color = woolColorWithCount(bot, minimum);
    for (let attempt = 0; !color && attempt < 8; attempt++) {
        const sheep = nearestSheep(bot);
        if (!sheep) {
            await movement.explore(bot, { target: 'food' });
            color = woolColorWithCount(bot, minimum);
            continue;
        }
        await huntSheep(bot, sheep);
        await collectNearbyDrops(bot, 8);
        color = woolColorWithCount(bot, minimum);
    }
    if (!color) throw new Error('Three matching wool could not be collected for a bed');
    return color;
}

async function huntSheep(bot, sheep) {
    await tools.equipBestWeapon(bot);
    for (let hit = 0; hit < 14; hit++) {
        const live = bot.entities[sheep.id];
        if (!live || live.isValid === false) return;
        if (live.position.distanceTo(bot.entity.position) > 3) {
            try {
                await movement.moveNear(bot, live.position, 1, 5000);
            } catch {
                await nudgeToward(bot, live.position);
            }
        }
        await bot.lookAt(live.position.offset(0, 0.8, 0), true);
        bot.attack(live);
        await movement.sleep(500);
    }
}

async function ensureSeeds(bot, minimum) {
    for (let attempt = 0; countItem(bot, 'wheat_seeds') < minimum && attempt < 32; attempt++) {
        const grass = findNearbyPlant(bot);
        if (!grass) {
            await movement.explore(bot, { target: 'food' });
            continue;
        }
        await breakPlant(bot, grass);
        await collectNearbyDrops(bot, 3);
    }
    if (countItem(bot, 'wheat_seeds') < minimum) {
        throw new Error(`Wheat seeds unavailable (${countItem(bot, 'wheat_seeds')}/${minimum})`);
    }
}

async function ensureHoe(bot) {
    if (bot.inventory.items().some(item => item.name.endsWith('_hoe'))) return;
    await ensureSticks(bot, 2);
    if (countItem(bot, 'cobblestone') < 2) {
        throw new Error('Stone hoe requires 2 cobblestone');
    }
    await craft.craftItem(bot, 'stone_hoe', 1);
}

async function ensureWaterBucket(bot) {
    if (countItem(bot, 'water_bucket') > 0) return;
    const source = await findOrExploreWaterSource(bot);
    if (!source) throw new Error('No water source found within 48 blocks');

    if (countItem(bot, 'bucket') <= 0) {
        const requiredIngots = Math.max(0, 11 - countItem(bot, 'iron_ingot'));
        if (requiredIngots > 0 && countItem(bot, 'raw_iron') < requiredIngots) {
            await mining.mineIron(bot, requiredIngots);
        }
        const refreshedMissing = Math.max(0, 11 - countItem(bot, 'iron_ingot'));
        if (refreshedMissing > 0) {
            const raw = countItem(bot, 'raw_iron');
            if (raw <= 0) throw new Error('Farm bucket iron could not be collected');
            await smelting.smeltItem(bot, 'raw_iron', 'iron_ingot', Math.min(raw, refreshedMissing));
        }
        if (countItem(bot, 'iron_ingot') < 11) {
            throw new Error('Farm bucket would consume the 8-ingot reserve');
        }
        await craft.craftItem(bot, 'bucket', 1);
    }

    await movement.moveNear(bot, source.position, 2, 15000);
    const bucket = bot.inventory.items().find(item => item.name === 'bucket');
    if (!bucket) throw new Error('Empty bucket not found');
    await bot.equip(bucket, 'hand');
    await movement.sleep(400);
    await bot.lookAt(source.position.offset(0.5, 0.95, 0.5), true);
    await movement.sleep(150);
    bot.activateItem(false);
    await waitForInventoryItem(bot, 'water_bucket', 2500);
    if (countItem(bot, 'water_bucket') <= 0) throw new Error('Water bucket fill was not confirmed');
}

async function placeFarmWater(bot, center) {
    const waterPosition = center.offset(0, -1, 0);
    if (bot.blockAt(waterPosition)?.name === 'water') return;
    await movement.moveNear(bot, center, 1, 12000);
    const waterBucket = bot.inventory.items().find(item => item.name === 'water_bucket');
    if (!waterBucket) throw new Error('Water bucket missing at farm site');
    const centerGround = bot.blockAt(waterPosition);
    const floor = bot.blockAt(center.offset(0, -2, 0));
    if (!floor || floor.boundingBox !== 'block') throw new Error('Farm water trench has no floor');
    if (centerGround && !isAir(centerGround)) {
        await bot.dig(centerGround);
        await waitForBlock(bot, waterPosition, 'air', 2000);
    }
    if (!isAir(bot.blockAt(waterPosition))) throw new Error('Farm water trench could not be opened');
    await bot.equip(waterBucket, 'hand');
    await movement.sleep(400);
    await bot.lookAt(floor.position.offset(0.5, 1, 0.5), true);
    await movement.sleep(150);
    bot.activateItem(false);
    await waitForBlock(bot, waterPosition, 'water', 2500);
    if (bot.blockAt(waterPosition)?.name !== 'water') {
        throw new Error('Farm water placement was not confirmed');
    }
}

async function tillPosition(bot, position) {
    let ground = bot.blockAt(position.offset(0, -1, 0));
    if (ground?.name === 'farmland') return ground;
    if (!TILLABLE.has(ground?.name)) return null;
    await movement.moveNear(bot, position, 3, 7000);
    const hoe = bot.inventory.items().find(item => item.name.endsWith('_hoe'));
    if (!hoe) return null;
    await bot.equip(hoe, 'hand');
    await movement.sleep(300);
    await bot.activateBlock(ground, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5));
    await waitForBlock(bot, ground.position, 'farmland', 1600);
    ground = bot.blockAt(position.offset(0, -1, 0));
    return ground?.name === 'farmland' ? ground : null;
}

async function plantSeed(bot, farmland) {
    const above = farmland.position.offset(0, 1, 0);
    if (bot.blockAt(above)?.name === 'wheat') return true;
    const seed = bot.inventory.items().find(item => item.name === 'wheat_seeds');
    if (!seed) return false;
    await bot.equip(seed, 'hand');
    await movement.sleep(300);
    try {
        await bot.activateBlock(farmland, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5));
    } catch {
        return false;
    }
    await movement.sleep(250);
    return bot.blockAt(above)?.name === 'wheat';
}

function findFarmSite(bot) {
    const remembered = memory.getBase();
    const origin = remembered
        ? new Vec3(remembered.x, remembered.y, remembered.z)
        : bot.entity.position.floored();
    const offsets = [
        [5, 0], [-5, 0], [0, 5], [0, -5],
        [6, 3], [-6, 3], [6, -3], [-6, -3]
    ];
    return offsets
        .map(([dx, dz]) => origin.offset(dx, 0, dz))
        .find(center => {
            const centerGround = bot.blockAt(center.offset(0, -1, 0));
            const trenchFloor = bot.blockAt(center.offset(0, -2, 0));
            if (
                (!TILLABLE.has(centerGround?.name) && centerGround?.name !== 'water') ||
                trenchFloor?.boundingBox !== 'block'
            ) {
                return false;
            }
            return farmRing(center).every(position => {
                const ground = bot.blockAt(position.offset(0, -1, 0));
                const above = bot.blockAt(position);
                return TILLABLE.has(ground?.name) && isAir(above);
            });
        }) || null;
}

function farmRing(center) {
    const positions = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            positions.push(center.offset(dx, 0, dz));
        }
    }
    return positions;
}

function farmPlotPositions(center, radius = FARM_RADIUS) {
    const positions = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            if (dx === 0 && dz === 0) continue;
            positions.push(center.offset(dx, 0, dz));
        }
    }
    return positions.sort((left, right) => {
        const leftDx = Math.abs(left.x - center.x);
        const leftDz = Math.abs(left.z - center.z);
        const rightDx = Math.abs(right.x - center.x);
        const rightDz = Math.abs(right.z - center.z);
        return Math.max(leftDx, leftDz) - Math.max(rightDx, rightDz) ||
            left.distanceTo(center) - right.distanceTo(center);
    });
}

function farmCapacityAt(bot, center) {
    return farmPlotPositions(center)
        .filter(position => bot.blockAt(position.offset(0, -1, 0))?.name === 'farmland')
        .length;
}

function countFarmBlocks(bot, center) {
    return farmRing(center)
        .filter(position => bot.blockAt(position.offset(0, -1, 0))?.name === 'farmland')
        .length;
}

function countNearbyCrops(bot, maxDistance) {
    const wheatId = bot.registry.blocksByName.wheat?.id;
    if (!Number.isInteger(wheatId)) return 0;
    return bot.findBlocks({ matching: wheatId, maxDistance, count: 32 }).length;
}

function findWaterSource(bot) {
    const waterId = bot.registry.blocksByName.water?.id;
    if (!Number.isInteger(waterId)) return null;
    return bot.findBlocks({ matching: waterId, maxDistance: 48, count: 64 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(block => {
            const level = block.getProperties?.().level;
            return level === undefined || Number(level) === 0;
        })
        .sort((left, right) =>
            left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position)
        )[0] || null;
}

async function findOrExploreWaterSource(bot) {
    let source = findWaterSource(bot);
    for (let attempt = 0; !source && attempt < 4; attempt++) {
        await movement.explore(bot, { target: 'water' });
        source = findWaterSource(bot);
    }
    return source;
}

function findNearbyPlant(bot) {
    const ids = ['short_grass', 'tall_grass']
        .map(name => bot.registry.blocksByName[name]?.id)
        .filter(Number.isInteger);
    if (ids.length === 0) return null;
    return bot.findBlock({ matching: ids, maxDistance: 24 });
}

async function breakPlant(bot, block) {
    await movement.moveNear(bot, block.position, 3, 7000);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    bot._client.write('block_dig', { status: 0, location: block.position, face: 1 });
    bot.swingArm();
    await movement.sleep(80);
    bot._client.write('block_dig', { status: 2, location: block.position, face: 1 });
    await movement.sleep(250);
}

async function ensurePlanks(bot, minimum) {
    while (totalPlanks(bot) < minimum) {
        let log = bot.inventory.items().find(item => LOG_NAMES.includes(item.name));
        if (!log) {
            await mine.mineBlock(bot, { target: 'any_log' });
            log = bot.inventory.items().find(item => LOG_NAMES.includes(item.name));
        }
        if (!log) throw new Error('Wood for homestead could not be collected');
        await craft.craftItem(bot, log.name.replace(/_log$/, '_planks'), 4);
    }
}

async function ensureSticks(bot, minimum) {
    if (countItem(bot, 'stick') >= minimum) return;
    await ensurePlanks(bot, 2);
    await craft.craftItem(bot, 'stick', minimum - countItem(bot, 'stick'));
}

async function collectNearbyDrops(bot, attempts) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const drop = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item' && entity.position)
            .filter(entity => entity.position.distanceTo(bot.entity.position) <= 10)
            .sort((left, right) =>
                left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position)
            )[0];
        if (!drop) {
            await movement.sleep(250);
            continue;
        }
        try {
            await movement.moveNear(bot, drop.position, 1, 4000);
        } catch {
            await nudgeToward(bot, drop.position);
        }
        await movement.sleep(250);
    }
}

async function nudgeToward(bot, position) {
    try {
        await bot.lookAt(position.offset(0, 0.5, 0), true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        await movement.sleep(700);
    } finally {
        movement.stop(bot);
    }
}

function nearestSheep(bot) {
    return Object.values(bot.entities || {})
        .filter(entity => entity.name === 'sheep' && entity.position)
        .filter(entity => entity.position.distanceTo(bot.entity.position) <= 24)
        .sort((left, right) =>
            left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position)
        )[0] || null;
}

function woolColorWithCount(bot, minimum) {
    return BED_COLORS.find(color => countItem(bot, `${color}_wool`) >= minimum) || null;
}

function findInventoryBed(bot) {
    return bot.inventory.items().find(item => item.name.endsWith('_bed')) || null;
}

function totalPlanks(bot) {
    return bot.inventory.items()
        .filter(item => PLANK_NAMES.includes(item.name))
        .reduce((total, item) => total + item.count, 0);
}

function countItem(bot, name) {
    return bot.inventory.slots
        .filter(Boolean)
        .filter(item => item.name === name)
        .reduce((total, item) => total + item.count, 0);
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

function isNearBase(bot, maximumDistance) {
    const base = memory.getBase();
    if (!base || !bot.entity?.position) return true;
    return bot.entity.position.distanceTo(new Vec3(base.x, base.y, base.z)) <= maximumDistance;
}

async function waitForInventoryItem(bot, itemName, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (countItem(bot, itemName) > 0) return true;
        await movement.sleep(100);
    }
    return false;
}

async function waitForBlock(bot, position, blockName, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (bot.blockAt(position)?.name === blockName) return true;
        await movement.sleep(100);
    }
    return false;
}

module.exports = {
    secureBed,
    establishWheatFarm,
    expandWheatFarm,
    hasBed,
    hasFarm,
    hasMatureCrop,
    growingCropCount,
    farmCapacity,
    findFarmCenter,
    farmPlotPositions
};
