const { Vec3 } = require('vec3');
const movement = require('./movement');
const tools = require('./tools');
const food = require('./food');
const shelter = require('./shelter');
const memory = require('./memory');
const actionControl = require('./actionControl');

const HOSTILES = new Set([
    'zombie',
    'zombie_villager',
    'skeleton',
    'creeper',
    'spider',
    'enderman',
    'witch',
    'drowned',
    'husk',
    'stray'
]);

const NIGHT_BLOCKED_LEVELS = new Set([
    'L9_FOOD_LOOP',
    'L11_STABLE_SURVIVAL'
]);

const MELEE_HOSTILES = new Set([
    'zombie',
    'zombie_villager',
    'spider',
    'drowned',
    'husk'
]);

function chooseImmediateAction(bot, observation, level = null) {
    const hostile = nearestHostile(bot, 10);
    if (hostile && (observation.health <= 18 || hostile.distance <= 7)) {
        return {
            action: 'fight_mob',
            entityId: hostile.id,
            reason: `Threat nearby: ${hostile.name}`
        };
    }

    if (observation.food <= 14 && food.foodScore(observation.inventory) > 0) {
        return {
            action: 'eat_food',
            reason: 'Hunger dropped; eat first'
        };
    }

    if (
        observation.food <= 8 &&
        food.foodScore(observation.inventory) === 0 &&
        !isNight(bot) &&
        !food.isTemporarilyUnavailable()
    ) {
        return {
            action: 'find_food',
            reason: 'No food and hunger is critical'
        };
    }

    if (shouldReachSurfaceForWork(bot, observation, level)) {
        return {
            action: 'escape_pit',
            reason: 'Return upward before surface work'
        };
    }

    if (shouldEscapePit(bot, observation)) {
        return {
            action: 'escape_pit',
            reason: 'Trapped in a pit; get out first'
        };
    }

    if (isNight(bot) && isSurface(bot)) {
        if (findNearbyBed(bot, 8)) {
            return {
                action: 'sleep_bed',
                reason: 'Night and bed found; sleep'
            };
        }

        if (memory.hasBase()) {
            if (!isNearBase(bot, 5)) {
                return {
                    action: 'return_base',
                    reason: 'Night on surface; return to base'
                };
            }

            if (shouldPauseForNight(level)) {
                return {
                    action: 'wait_safe',
                    ms: 3000,
                    reason: 'Night and no bed; risky outside task delayed until morning'
                };
            }
        } else if (shouldPauseForNight(level)) {
            return {
                action: 'wait_safe',
                ms: 2000,
                reason: 'Night and no base; reducing movement'
            };
        }
    }

    return null;
}

function isNearBase(bot, range) {
    const base = memory.getBase();
    if (!base) return false;
    const dx = bot.entity.position.x - base.x;
    const dy = bot.entity.position.y - base.y;
    const dz = bot.entity.position.z - base.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= range;
}

function shouldEscapePit(bot, observation) {
    if (memory.hasBase() && isNearBase(bot, 5)) return false;
    if (shelter.isBuildingNear(bot)) return false;
    const surfaceExit = memory.getSurfaceExit();
    if (surfaceExit && bot.entity.position.y >= surfaceExit.y - 1) return false;
    if (!isInPit(bot)) return false;

    const hurtAndTrapped = observation.health < 14;
    if (hurtAndTrapped) return true;

    const hasEnoughStoneForNextStep = (observation.inventory.cobblestone || 0) >= 16 &&
        !memory.hasBase();
    if (hasEnoughStoneForNextStep) return false;

    return bot.entity.position.y < 50;
}

function shouldReachSurfaceForWork(bot, observation, level) {
    if (level?.id === 'L7_BUILD_SAFE_SHELTER' && !memory.hasBase()) {
        if (shelter.isBuildingNear(bot)) return false;
        const surfaceExit = memory.getSurfaceExit();
        if (surfaceExit) return bot.entity.position.y < surfaceExit.y - 1;
        return bot.entity.position.y < 55;
    }
    if (bot.entity.position.y >= 58) return false;
    if (
        level?.id === 'L11_STABLE_SURVIVAL' &&
        woodUnits(observation.inventory) < 2
    ) {
        return true;
    }
    return false;
}

async function fightMob(bot, entityId) {
    const entity = bot.entities[entityId] || nearestHostile(bot, 10)?.entity;
    if (!entity) return;

    const targetName = entityName(entity);
    console.log(`[SURVIVAL] fighting ${targetName}`);
    const weapon = await tools.equipBestWeapon(bot);
    if (!weapon) {
        console.log(`[SURVIVAL] no weapon for ${targetName}; using bare hands defensively`);
        await retreatFromThreat(bot, entity, 4);
        return;
    }

    if (targetName === 'creeper') {
        await retreatFromThreat(bot, entity, 4);
        return;
    }

    if (targetName === 'skeleton' || targetName === 'stray') {
        await handleRangedThreat(bot, entity, weapon);
        return;
    }

    if (!MELEE_HOSTILES.has(targetName) && bot.health <= 16) {
        await retreatFromThreat(bot, entity, 3);
        return;
    }

    for (let i = 0; i < 8 && bot.health > 0; i++) {
        const liveEntity = bot.entities[entity.id];
        if (!liveEntity || liveEntity.isValid === false) return;

        const name = entityName(liveEntity);
        if (bot.health <= 9) {
            await retreatFromThreat(bot, liveEntity, 3);
            return;
        }

        if (name === 'creeper') {
            await retreatFromThreat(bot, liveEntity, 4);
            return;
        }

        const distance = liveEntity.position.distanceTo(bot.entity.position);
        if (distance > 7) return;
        if (distance > 3.0) {
            await strafeApproach(bot, liveEntity.position);
            continue;
        }
        await bot.lookAt(liveEntity.position.offset(0, 1.2, 0), true);
        bot.attack(liveEntity);
        if (i % 2 === 1) {
            await backAway(bot, liveEntity.position);
        }
        await movement.sleep(650);
    }
}

async function handleRangedThreat(bot, entity, weapon) {
    const hasShield = bot.inventory.items().some(item => item.name === 'shield');
    const hasArmor = armorScore(bot) >= 2;

    if (hasShield) await equipShield(bot);

    for (let i = 0; i < 8 && bot.health > 0; i++) {
        const liveEntity = bot.entities[entity.id];
        if (!liveEntity || liveEntity.isValid === false) return;

        const distance = liveEntity.position.distanceTo(bot.entity.position);
        if (bot.health <= 12 && !hasShield) {
            await retreatFromThreat(bot, liveEntity, 4);
            return;
        }

        if (!weapon && !hasShield && !hasArmor) {
            await retreatFromThreat(bot, liveEntity, 4);
            return;
        }

        if (distance > 14 && !hasShield) return;

        if (distance > 2.8) {
            await strafeApproach(bot, liveEntity.position);
            continue;
        }

        await bot.lookAt(liveEntity.position.offset(0, 1.25, 0), true);
        bot.attack(liveEntity);
        await backAway(bot, liveEntity.position);
    }
}

async function equipShield(bot) {
    const shield = bot.inventory.items().find(item => item.name === 'shield');
    if (!shield) return;
    try {
        await bot.equip(shield, 'off-hand');
    } catch {
        // Off-hand support varies across protocol shims; fighting can continue without it.
    }
}

function armorScore(bot) {
    const slots = bot.inventory.slots.filter(Boolean);
    return slots.filter(item =>
        /_(helmet|chestplate|leggings|boots)$/.test(item.name)
    ).length;
}

async function strafeApproach(bot, targetPosition) {
    try {
        await bot.lookAt(targetPosition.offset(0, 1.2, 0), true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        bot.setControlState(Math.random() > 0.5 ? 'left' : 'right', true);
        bot.setControlState('jump', true);
        await movement.sleep(650);
    } finally {
        bot.clearControlStates();
    }
}

async function retreatFromThreat(bot, entity, steps) {
    for (let i = 0; i < steps; i++) {
        const liveEntity = bot.entities[entity.id];
        await backAway(bot, liveEntity?.position || entity.position);
        if (!liveEntity || liveEntity.position.distanceTo(bot.entity.position) > 9) return;
    }
}

async function escapePit(bot) {
    const actionVersion = actionControl.snapshot(bot);
    const origin = bot.entity.position.floored();
    console.log(`[SURVIVAL] escaping pit ${origin.toString()}`);

    const surfaceExit = memory.getSurfaceExit();
    if (surfaceExit) {
        const reached = await climbTowardSurfaceExit(
            bot,
            new Vec3(surfaceExit.x, surfaceExit.y, surfaceExit.z),
            actionVersion
        );
        if (reached) return;
    }

    const exits = findNearbyExits(bot, origin);
    for (const exit of exits.slice(0, 8)) {
        actionControl.assertActive(bot, actionVersion);
        try {
            const before = bot.entity.position.clone();
            await movement.moveNear(bot, exit, 1, 1800);
            const raised = bot.entity.position.y > before.y + 0.5;
            const escaped = !isInPit(bot);
            if (raised || escaped) return;
        } catch {
            // Try next exit.
        }
    }

    const carved = await carveEscapeStaircase(bot, surfaceExit, actionVersion);
    if (carved) return;
    await pillarUp(bot);
}

async function carveEscapeStaircase(bot, surfaceExit, actionVersion) {
    const origin = bot.entity.position.floored();
    const directions = escapeDirections(origin, surfaceExit);

    await digIfNeeded(bot, origin.offset(0, 2, 0));
    await digIfNeeded(bot, origin.offset(0, 3, 0));
    await waitForGround(bot, 1000);

    for (const direction of directions) {
        actionControl.assertActive(bot, actionVersion);
        const beforeY = bot.entity.position.y;
        const current = bot.entity.position.floored();
        const next = current.offset(direction.x, 1, direction.z);
        const floor = next.offset(0, -1, 0);

        await digIfNeeded(bot, next);
        await digIfNeeded(bot, next.offset(0, 1, 0));
        await ensureStepFloor(bot, floor);

        try {
            await movement.moveBlock(bot, next, 4000);
        } catch {
            await bot.lookAt(next.offset(0.5, 1, 0.5), true);
            await jumpForward(bot);
        }

        if (bot.entity.position.y >= beforeY + 0.7) {
            console.log(`[SURVIVAL] carved escape step y=${beforeY.toFixed(1)}->${bot.entity.position.y.toFixed(1)}`);
            return true;
        }
    }
    return false;
}

function escapeDirections(origin, surfaceExit) {
    const directions = [
        new Vec3(1, 0, 0),
        new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1),
        new Vec3(0, 0, -1)
    ];
    if (!surfaceExit) return directions;
    return directions.sort((a, b) =>
        origin.offset(a.x, 0, a.z).distanceTo(surfaceExit) -
        origin.offset(b.x, 0, b.z).distanceTo(surfaceExit)
    );
}

async function climbTowardSurfaceExit(bot, exit, actionVersion) {
    const startY = bot.entity.position.y;
    for (let i = 0; i < 8; i++) {
        actionControl.assertActive(bot, actionVersion);
        const current = bot.entity.position.floored();
        if (current.y >= exit.y - 1 && current.distanceTo(exit) <= 4) {
            console.log(`[SURVIVAL] reached surface exit area ${current.toString()}`);
            return true;
        }

        const dx = Math.abs(exit.x - current.x) >= Math.abs(exit.z - current.z)
            ? Math.sign(exit.x - current.x)
            : 0;
        const dz = dx === 0 ? Math.sign(exit.z - current.z) : 0;
        const horizontal = current.offset(dx || 1, 0, dz);
        const next = current.y < exit.y - 1
            ? horizontal.offset(0, 1, 0)
            : horizontal;

        await clearStandSpace(bot, next);
        await ensureStepFloor(bot, next.offset(0, -1, 0));

        try {
            await movement.moveNear(bot, next, 1, 2500);
        } catch {
            await bot.lookAt(next.offset(0.5, 1, 0.5), true);
            await jumpForward(bot);
        }

        if (bot.entity.position.y > startY + 0.6) return true;
    }
    return false;
}

async function clearStandSpace(bot, position) {
    await digIfNeeded(bot, position);
    await digIfNeeded(bot, position.offset(0, 1, 0));
    await digIfNeeded(bot, position.offset(0, 2, 0));
}

async function ensureStepFloor(bot, position) {
    const floor = bot.blockAt(position);
    if (floor?.boundingBox === 'block') return;
    const item = bot.inventory.items().find(entry =>
        ['dirt', 'cobblestone', 'oak_planks', 'birch_planks'].includes(entry.name)
    );
    if (!item) return;

    const reference = findPlacementReference(bot, position);
    if (!reference) return;
    try {
        await bot.equip(item, 'hand');
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(reference.block, reference.face);
        await movement.sleep(150);
    } catch {
        // The next movement attempt may still find a natural floor.
    }
}

async function digIfNeeded(bot, position) {
    const block = bot.blockAt(position);
    if (!block || isAir(block) || !bot.canDigBlock(block)) return;
    await tools.equipBestTool(bot, 'pickaxe');
    try {
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await movement.withTimeout(bot.dig(block), 6000, `Timed out clearing ${block.name}`);
    } catch {
        try {
            bot.stopDigging();
        } catch {
            // Dig state may already be clear.
        }
    }
}

function findPlacementReference(bot, target) {
    const options = [
        { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
        { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
        { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
        { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
        { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) }
    ];
    for (const option of options) {
        const block = bot.blockAt(target.plus(option.offset));
        if (block?.boundingBox === 'block') return { block, face: option.face };
    }
    return null;
}

async function returnBase(bot) {
    const moved = await shelter.returnToBase(bot);
    if (!moved) await movement.explore(bot, { target: 'safe' });
}

async function waitSafe(bot, ms = 1500) {
    movement.stop(bot);
    await movement.sleep(ms);
}

async function sleepInBed(bot) {
    const bed = findNearbyBed(bot, 8);
    if (!bed) return;

    try {
        await movement.moveNear(bot, bed.position, 2, 8000);
    } catch (error) {
        console.log(`[SURVIVAL] could not walk to bed: ${error.message}`);
    }

    try {
        console.log(`[SURVIVAL] sleeping in bed ${bed.position.toString()}`);
        await bot.sleep(bed);
        await movement.sleep(1000);
        while (isNight(bot) && bot.isSleeping) {
            await movement.sleep(1000);
        }
    } catch (error) {
        console.log(`[SURVIVAL] could not sleep in bed: ${error.message}`);
        await waitSafe(bot, 3000);
    }
}

function nearestHostile(bot, radius) {
    return Object.values(bot.entities || {})
        .filter(entity => isHostileEntity(entity))
        .filter(entity => entity.position && entity.position.distanceTo(bot.entity.position) <= radius)
        .map(entity => ({
            id: entity.id,
            name: entityName(entity),
            distance: entity.position.distanceTo(bot.entity.position),
            entity
        }))
        .sort((a, b) => a.distance - b.distance)[0] || null;
}

function isHostileEntity(entity) {
    const name = entityName(entity);
    if (HOSTILES.has(name)) return true;
    if (entity.type !== 'mob') return false;
    return ![
        'cow',
        'pig',
        'sheep',
        'chicken',
        'horse',
        'donkey',
        'cat',
        'wolf',
        'villager',
        'cod',
        'salmon',
        'tropical_fish',
        'pufferfish',
        'squid',
        'glow_squid',
        'turtle',
        'frog',
        'item'
    ].includes(name);
}

function entityName(entity) {
    return String(entity.name || entity.mobType || entity.displayName || entity.type || 'unknown')
        .toLowerCase()
        .replace(/^minecraft:/, '')
        .replace(/\s+/g, '_');
}

function isNight(bot) {
    const time = bot.time?.timeOfDay ?? 0;
    return time >= 12500 && time <= 23500;
}

function shouldPauseForNight(level) {
    if (!level?.id) return true;
    return NIGHT_BLOCKED_LEVELS.has(level.id);
}

function findNearbyBed(bot, maxDistance) {
    const ids = Object.values(bot.registry.blocksByName || {})
        .filter(block => block.name.endsWith('_bed'))
        .map(block => block.id);
    if (ids.length === 0) return null;

    return bot.findBlocks({ matching: ids, maxDistance, count: 8 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .sort((a, b) =>
            a.position.distanceTo(bot.entity.position) -
            b.position.distanceTo(bot.entity.position)
        )[0] || null;
}

function isSurface(bot) {
    return bot.entity.position.y >= 58;
}

function isInPit(bot) {
    const position = bot.entity.position.floored();
    const openNeighbors = [
        [1, 0], [-1, 0], [0, 1], [0, -1]
    ].filter(([dx, dz]) => {
        const feet = bot.blockAt(position.offset(dx, 0, dz));
        const body = bot.blockAt(position.offset(dx, 1, dz));
        return isAir(feet) && isAir(body);
    }).length;

    return openNeighbors === 0;
}

function findNearbyExits(bot, origin) {
    const exits = [];
    for (let dx = -4; dx <= 4; dx++) {
        for (let dz = -4; dz <= 4; dz++) {
            for (let dy = 0; dy <= 4; dy++) {
                const position = origin.offset(dx, dy, dz);
                const feet = bot.blockAt(position);
                const head = bot.blockAt(position.offset(0, 1, 0));
                const floor = bot.blockAt(position.offset(0, -1, 0));
                if (isAir(feet) && isAir(head) && floor?.boundingBox === 'block') {
                    const horizontal = Math.hypot(dx, dz);
                    if (dy > 0 || horizontal >= 1.5) exits.push(position);
                }
            }
        }
    }
    return exits.sort((a, b) => {
        const heightDifference = (b.y - origin.y) - (a.y - origin.y);
        return heightDifference || a.distanceTo(origin) - b.distanceTo(origin);
    });
}

async function pillarUp(bot) {
    const block = bot.inventory.items().find(item =>
        ['dirt', 'cobblestone', 'oak_planks', 'birch_planks'].includes(item.name)
    );
    if (!block) {
        await jumpForward(bot);
        return;
    }

    for (let i = 0; i < 4; i++) {
        const beforeY = bot.entity.position.y;
        const feet = bot.entity.position.floored();
        await digIfNeeded(bot, feet.offset(0, 2, 0));
        await digIfNeeded(bot, feet.offset(0, 3, 0));
        await waitForGround(bot, 1000);
        const below = bot.blockAt(feet.offset(0, -1, 0));
        if (!below) break;
        let placed = false;
        try {
            await bot.equip(block, 'hand');
            bot.setControlState('jump', true);
            const rose = await waitForRise(bot, beforeY, 0.45, 1200);
            if (!rose) throw new Error('No room to jump for pillar placement');
            const place = typeof bot._placeBlockWithOptions === 'function'
                ? bot._placeBlockWithOptions(
                    below,
                    new Vec3(0, 1, 0),
                    { forceLook: true, swingArm: 'right' }
                )
                : bot.placeBlock(below, new Vec3(0, 1, 0));
            await movement.withTimeout(
                place,
                2200,
                'Pillar placement timed out'
            );
            placed = true;
            await movement.sleep(500);
        } catch (error) {
            console.log(`[SURVIVAL] pillar placement failed: ${error.message}`);
            // A failed placement must not consume the whole survival tick.
        } finally {
            bot.clearControlStates();
        }
        console.log(
            `[SURVIVAL] pillar step y=${beforeY.toFixed(1)}->${bot.entity.position.y.toFixed(1)}`
        );
        if (!placed || bot.entity.position.y < beforeY + 0.7) break;
    }
}

async function waitForRise(bot, startY, minimumRise, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (bot.entity.position.y >= startY + minimumRise) return true;
        await movement.sleep(50);
    }
    return false;
}

async function waitForGround(bot, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (bot.entity.onGround) return true;
        await movement.sleep(50);
    }
    return false;
}

async function backAway(bot, threatPosition) {
    try {
        const dx = bot.entity.position.x - threatPosition.x;
        const dz = bot.entity.position.z - threatPosition.z;
        await bot.lookAt(bot.entity.position.offset(dx || 1, 0, dz || 1), true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        bot.setControlState('sprint', true);
        await movement.sleep(900);
    } finally {
        bot.clearControlStates();
    }
}

async function jumpForward(bot) {
    try {
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        await movement.sleep(1000);
    } finally {
        bot.clearControlStates();
    }
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

function woodUnits(inventory) {
    return Object.entries(inventory)
        .reduce((sum, [name, count]) => {
            if (name.endsWith('_log')) return sum + count;
            if (name.endsWith('_planks')) return sum + count / 4;
            if (name === 'stick') return sum + count / 8;
            return sum;
        }, 0);
}

module.exports = {
    chooseImmediateAction,
    nearestHostile,
    fightMob,
    escapePit,
    returnBase,
    waitSafe,
    sleepInBed
};
