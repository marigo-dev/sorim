const { Vec3 } = require('vec3');
const movement = require('./movement');
const tools = require('./tools');
const food = require('./food');
const shelter = require('./shelter');
const memory = require('./memory');

const HOSTILES = new Set([
    'zombie',
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

function chooseImmediateAction(bot, observation, level = null) {
    const hostile = nearestHostile(bot, 8);
    if (hostile && (observation.health <= 16 || hostile.distance <= 4)) {
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

    if (observation.food <= 8 && food.foodScore(observation.inventory) === 0) {
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
    if (!isInPit(bot)) return false;

    const hurtAndTrapped = observation.health < 14;
    if (hurtAndTrapped) return true;

    const hasEnoughStoneForNextStep = (observation.inventory.cobblestone || 0) >= 16 &&
        !memory.hasBase();
    if (hasEnoughStoneForNextStep) return false;

    return bot.entity.position.y < 50;
}

function shouldReachSurfaceForWork(bot, observation, level) {
    if (bot.entity.position.y >= 58) return false;
    if (level?.id === 'L7_BUILD_SAFE_SHELTER' && !memory.hasBase()) return true;
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

    console.log(`[SURVIVAL] fighting ${entity.name}`);
    await tools.equipBestWeapon(bot);
    for (let i = 0; i < 10 && entity.isValid !== false && bot.health > 0; i++) {
        const distance = entity.position.distanceTo(bot.entity.position);
        if (entity.name === 'creeper' && distance < 4) {
            await backAway(bot, entity.position);
            continue;
        }
        if (distance > 3.2) {
            await movement.moveNear(bot, entity.position, 2, 5000);
        }
        bot.attack(entity);
        await movement.sleep(550);
    }
}

async function escapePit(bot) {
    const origin = bot.entity.position.floored();
    console.log(`[SURVIVAL] escaping pit ${origin.toString()}`);

    const exits = findNearbyExits(bot, origin);
    for (const exit of exits) {
        try {
            await movement.moveNear(bot, exit, 1, 5000);
            return;
        } catch {
            // Try next exit.
        }
    }

    await pillarUp(bot);
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
        .filter(entity => HOSTILES.has(entity.name))
        .filter(entity => entity.position && entity.position.distanceTo(bot.entity.position) <= radius)
        .map(entity => ({
            id: entity.id,
            name: entity.name,
            distance: entity.position.distanceTo(bot.entity.position),
            entity
        }))
        .sort((a, b) => a.distance - b.distance)[0] || null;
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
    const head = bot.blockAt(position.offset(0, 2, 0));
    if (!isAir(head)) return true;

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
                    exits.push(position);
                }
            }
        }
    }
    return exits.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin));
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
        const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        if (!below) break;
        try {
            await bot.equip(block, 'hand');
            bot.setControlState('jump', true);
            await movement.sleep(350);
            await bot.placeBlock(below, new Vec3(0, 1, 0));
            await movement.sleep(250);
        } catch {
            await jumpForward(bot);
        } finally {
            bot.clearControlStates();
        }
    }
}

async function backAway(bot, threatPosition) {
    try {
        const dx = bot.entity.position.x - threatPosition.x;
        const dz = bot.entity.position.z - threatPosition.z;
        await bot.lookAt(bot.entity.position.offset(dx || 1, 0, dz || 1), true);
        bot.setControlState('back', true);
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
    fightMob,
    escapePit,
    returnBase,
    waitSafe,
    sleepInBed
};
