const { Vec3 } = require('vec3');
const movement = require('./movement');
const tools = require('./tools');
const craft = require('./craft');
const mine = require('./mine');
const mining = require('./mining');
const smelting = require('./smelting');
const shelter = require('./shelter');
const entityActions = require('./entityActions');
const memory = require('./memory');
const actionControl = require('./actionControl');

const BED_COLORS = [
    'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
    'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
];
const LOG_NAMES = [
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log'
];
const PLANK_NAMES = [
    'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks',
    'dark_oak_planks', 'cherry_planks', 'mangrove_planks', 'pale_oak_planks'
];
const TILLABLE = new Set(['dirt', 'grass_block', 'dirt_path', 'farmland']);
const FARM_RADIUS = 4;
const FOOD_FARM_TARGET = 48;
const failedSheep = new Map();
let bedUnavailableUntil = 0;

async function secureBed(bot) {
    const actionVersion = actionControl.snapshot(bot);
    if (hasBed(bot)) {
        bedUnavailableUntil = 0;
        memory.setProgress('bedUnavailableUntil', 0);
        return;
    }
    if (isBedTemporarilyUnavailable()) return;
    const surfaceExit = memory.getSurfaceExit();
    if (surfaceExit && bot.entity.position.y < surfaceExit.y - 0.1) {
        console.log('[HOMESTEAD] returning to the surface before searching for sheep');
        await require('./survival').escapePit(bot);
        actionControl.assertActive(bot, actionVersion);
    }
    await shelter.leaveBase(bot);
    actionControl.assertActive(bot, actionVersion);

    let bed = findInventoryBed(bot);
    if (!bed) {
        await ensurePlanks(bot, 3);
        actionControl.assertActive(bot, actionVersion);
        let color;
        try {
            color = await ensureMatchingWool(bot, 3);
        } catch (error) {
            bedUnavailableUntil = Date.now() + 5 * 60 * 1000;
            memory.setProgress('bedUnavailableUntil', bedUnavailableUntil);
            console.log(`[HOMESTEAD] bed delayed for 5 minutes: ${error.message}`);
            return;
        }
        actionControl.assertActive(bot, actionVersion);
        await shelter.returnToBase(bot);
        actionControl.assertActive(bot, actionVersion);
        await craft.craftItem(bot, `${color}_bed`, 1);
        bed = findInventoryBed(bot);
    }
    if (!bed) throw new Error('Bed could not be crafted');

    await craft.placeBlock(bot, bed.name);
    memory.setProgress('bedReady', 1);
    console.log(`[HOMESTEAD] bed ready ${bed.name}`);
}

async function establishWheatFarm(bot, options = {}) {
    const actionVersion = actionControl.snapshot(bot);
    if (hasFarm(bot)) return;
    if (!options.alreadyOutside) await shelter.leaveBase(bot);
    actionControl.assertActive(bot, actionVersion);

    let site = options.site
        ? new Vec3(options.site.x, options.site.y, options.site.z)
        : findFarmSite(bot);
    if (site && bot.entity.position.distanceTo(site) > 6) {
        try {
            await movement.moveNear(bot, site, 3, 12000);
        } catch (error) {
            console.log(`[HOMESTEAD] local farm site unreachable: ${error.message}`);
            site = null;
        }
    }
    if (!site) site = await findNaturalWaterFarmSite(bot, actionVersion);
    if (!site) throw new Error('No naturally hydrated 3x3 farm site found near base');
    actionControl.assertActive(bot, actionVersion);
    console.log(`[HOMESTEAD] farm site selected ${site.toString()}`);
    await ensureSeeds(bot, 8);
    actionControl.assertActive(bot, actionVersion);
    await ensureHoe(bot);
    actionControl.assertActive(bot, actionVersion);
    if (!hasHydrationWater(bot, site)) {
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
    return {
        center: { x: site.x, y: site.y, z: site.z },
        planted,
        capacity: countFarmBlocks(bot, site)
    };
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
        if (farmCapacityAt(bot, center) >= 6) {
            return center;
        }
    }

    const waterId = bot.registry.blocksByName.water?.id;
    if (!Number.isInteger(waterId)) return null;
    const candidate = bot.findBlocks({ matching: waterId, maxDistance: 32, count: 32 })
        .flatMap(position => farmCentersAroundWater(position))
        .map(center => ({ center, capacity: farmCapacityAt(bot, center) }))
        .filter(entry => entry.capacity >= 6)
        .sort((left, right) => right.capacity - left.capacity)[0]?.center || null;
    if (candidate) memory.setFarmCenter(candidate);
    return candidate;
}

async function ensureMatchingWool(bot, minimum) {
    let color = woolColorWithCount(bot, minimum);
    for (let attempt = 0; !color && attempt < 3; attempt++) {
        const sheep = nearestSheep(bot);
        if (!sheep) {
            const search = await movement.explore(bot, {
                target: 'food',
                stopWhen: () => nearestSheep(bot)
            });
            if (!search?.found) await movement.sleep(750);
            color = woolColorWithCount(bot, minimum);
            continue;
        }
        const beforeWool = totalWool(bot);
        const deathPosition = await huntSheep(bot, sheep);
        if (bot.entities[sheep.id]?.isValid !== false && totalWool(bot) <= beforeWool) {
            failedSheep.set(sheep.id, Date.now() + 2 * 60 * 1000);
        }
        await collectNearbyDrops(bot, 8, deathPosition);
        if (totalWool(bot) <= beforeWool && deathPosition) {
            await sweepDropArea(bot, deathPosition);
        }
        color = woolColorWithCount(bot, minimum);
    }
    if (!color) throw new Error('Three matching wool could not be collected for a bed');
    return color;
}

async function huntSheep(bot, sheep) {
    await tools.equipBestWeapon(bot);
    let lastPosition = sheep.position.clone();
    let stalled = 0;
    for (let hit = 0; hit < 10; hit++) {
        const live = bot.entities[sheep.id];
        if (!live || live.isValid === false) return lastPosition;
        lastPosition = live.position.clone();
        if (live.position.distanceTo(bot.entity.position) > 3) {
            const before = bot.entity.position.clone();
            try {
                await movement.moveNear(bot, live.position, 1, 5000);
            } catch (error) {
                console.log(`[HOMESTEAD] sheep path failed: ${error.message}`);
                stalled++;
            }
            if (bot.entity.position.distanceTo(before) < 0.4) stalled++;
            else stalled = 0;
            if (stalled >= 2 && live.position.distanceTo(bot.entity.position) > 3) {
                console.log(`[HOMESTEAD] sheep ${live.id} is unreachable; trying another area`);
                return lastPosition;
            }
        }
        await bot.lookAt(live.position.offset(0, 0.8, 0), true);
        entityActions.attack(bot, live);
        await movement.sleep(650);
    }
    return lastPosition;
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
    if (hasHydrationWater(bot, center)) return;
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
        .find(center => hasHydrationWater(bot, center) && isPlantableFarmRing(bot, center)) || null;
}

async function findNaturalWaterFarmSite(bot, actionVersion) {
    for (let attempt = 0; attempt < 5; attempt++) {
        for (const site of naturalFarmSites(bot).slice(0, 12)) {
            try {
                await movement.moveNear(bot, site, 3, 12000);
                if (bot.entity.position.distanceTo(site) <= 6) return site;
            } catch (error) {
                console.log(`[HOMESTEAD] skipping unreachable farm site ${site.toString()}: ${error.message}`);
                movement.stop(bot);
                await movement.sleep(300);
            }
            actionControl.assertActive(bot, actionVersion);
        }
        await movement.explore(bot, { target: 'water' });
        actionControl.assertActive(bot, actionVersion);
    }
    return null;
}

function nearestNaturalFarmSite(bot) {
    return naturalFarmSites(bot)[0] || null;
}

function naturalFarmSites(bot) {
    const waterId = bot.registry.blocksByName.water?.id;
    if (!Number.isInteger(waterId)) return [];
    const seen = new Set();
    return bot.findBlocks({ matching: waterId, maxDistance: 48, count: 64 })
        .flatMap(position => farmCentersAroundWater(position))
        .filter(center => {
            const key = center.toString();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .filter(center => isPlantableFarmRing(bot, center))
        .sort((left, right) => left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position));
}

function farmCentersAroundWater(waterPosition) {
    const centers = [];
    for (let dx = -4; dx <= 4; dx++) {
        for (let dz = -4; dz <= 4; dz++) {
            const distance = Math.max(Math.abs(dx), Math.abs(dz));
            if (distance < 2 || distance > 4) continue;
            centers.push(waterPosition.offset(dx, 1, dz));
        }
    }
    return centers;
}

function isPlantableFarmRing(bot, center) {
    const centerGround = bot.blockAt(center.offset(0, -1, 0));
    if (!TILLABLE.has(centerGround?.name) || !isAir(bot.blockAt(center)) || !isAir(bot.blockAt(center.offset(0, 1, 0)))) {
        return false;
    }
    const plantable = farmRing(center).filter(position => {
        const ground = bot.blockAt(position.offset(0, -1, 0));
        const above = bot.blockAt(position);
        return TILLABLE.has(ground?.name) && isAir(above);
    }).length;
    return hasHydrationWater(bot, center) && plantable >= 6;
}

function hasHydrationWater(bot, center) {
    for (let dx = -4; dx <= 4; dx++) {
        for (let dz = -4; dz <= 4; dz++) {
            if (bot.blockAt(center.offset(dx, -1, dz))?.name === 'water') return true;
        }
    }
    return false;
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

async function collectNearbyDrops(bot, attempts, fallbackPosition = null) {
    if (fallbackPosition) {
        try {
            await movement.moveNear(bot, fallbackPosition, 1, 5000);
        } catch (error) {
            console.log(`[HOMESTEAD] fallback pickup path failed: ${error.message}`);
        }
        await movement.sleep(500);
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
        const drop = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item' && entity.position)
            .filter(entity => entity.position.distanceTo(bot.entity.position) <= 10)
            .filter(entity => entity.position.y >= bot.entity.position.y - 1.5)
            .filter(entity => entity.position.y <= bot.entity.position.y + 3)
            .sort((left, right) =>
                left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position)
            )[0];
        if (!drop) {
            await movement.sleep(250);
            continue;
        }
        try {
            await movement.moveNear(bot, drop.position, 1, 4000);
        } catch (error) {
            console.log(`[HOMESTEAD] drop pickup path failed: ${error.message}`);
            break;
        }
        await movement.sleep(250);
    }
}

async function sweepDropArea(bot, center) {
    const stands = [
        center.floored(),
        center.floored().offset(1, 0, 0),
        center.floored().offset(-1, 0, 0),
        center.floored().offset(0, 0, 1),
        center.floored().offset(0, 0, -1)
    ];
    for (const stand of stands) {
        try {
            await movement.moveNear(bot, stand, 1, 2500);
        } catch (error) {
            console.log(`[HOMESTEAD] sweep path failed at ${stand.toString()}: ${error.message}`);
        }
        await movement.sleep(250);
    }
}

function nearestSheep(bot) {
    const now = Date.now();
    for (const [id, expiresAt] of failedSheep) {
        if (expiresAt <= now) failedSheep.delete(id);
    }
    return Object.values(bot.entities || {})
        .filter(entity => entity.name === 'sheep' && entity.position)
        .filter(entity => !failedSheep.has(entity.id))
        .filter(entity => entity.position.distanceTo(bot.entity.position) <= 48)
        .sort((left, right) =>
            left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position)
        )[0] || null;
}

function isBedTemporarilyUnavailable() {
    return Date.now() < Math.max(
        bedUnavailableUntil,
        memory.getProgress('bedUnavailableUntil')
    );
}

function woolColorWithCount(bot, minimum) {
    return BED_COLORS.find(color => countItem(bot, `${color}_wool`) >= minimum) || null;
}

function totalWool(bot) {
    return BED_COLORS.reduce((sum, color) => sum + countItem(bot, `${color}_wool`), 0);
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
    isBedTemporarilyUnavailable,
    findFarmCenter,
    farmPlotPositions,
    hasHydrationWater,
    nearestNaturalFarmSite
};
