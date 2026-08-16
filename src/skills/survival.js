const { Vec3 } = require('vec3');
const movement = require('./movement');
const mine = require('./mine');
const tools = require('./tools');
const craft = require('./craft');
const food = require('./food');
const shelter = require('./shelter');
const memory = require('./memory');
const actionControl = require('./actionControl');
const entityActions = require('./entityActions');
const blockPolicy = require('../safety/blockPolicy');

const HOSTILES = new Set([
    'zombie',
    'zombie_villager',
    'skeleton',
    'creeper',
    'spider',
    'witch',
    'drowned',
    'husk',
    'stray'
]);

const NIGHT_BLOCKED_LEVELS = new Set([
    'L9_FOOD_LOOP',
    'L11_SECURE_BED',
    'L17_ESTABLISH_WHEAT_FARM',
    'L21_STABLE_SURVIVAL'
]);

const SURFACE_WORK_LEVELS = new Set([
    'L6_CRAFT_STONE_TOOLS',
    'L7_BUILD_SAFE_SHELTER',
    'L9_FOOD_LOOP',
    'L10_STORAGE_AND_BASE_MEMORY',
    'L12_PREPARE_MINING_KIT',
    'L15_SMELT_IRON',
    'L16_CRAFT_IRON_KIT',
    'L17_ESTABLISH_WHEAT_FARM',
    'L19_SMELT_ARMOR_IRON',
    'L20_CRAFT_IRON_ARMOR',
    'L21_STABLE_SURVIVAL'
]);

const MELEE_HOSTILES = new Set([
    'zombie',
    'zombie_villager',
    'spider',
    'drowned',
    'husk'
]);
const EARLY_GAME_LEVELS = new Set([
    'L1_COLLECT_WOOD',
    'L2_CRAFT_PLANKS',
    'L3_CRAFT_TABLE',
    'L4_CRAFT_WOODEN_PICKAXE',
    'L5_COLLECT_STONE',
    'L6_CRAFT_STONE_TOOLS',
    'L7_BUILD_SAFE_SHELTER'
]);
const PLANNED_UNDERGROUND_LEVELS = new Set([
    'L5_COLLECT_STONE',
    'L13_SAFE_IRON_MINE',
    'L14_COLLECT_RAW_IRON',
    'L18_COLLECT_ARMOR_IRON'
]);
let emergencyShelterBlockedForNight = false;
let emergencyShelterPosition = null;
let emergencyShelterFailures = 0;
let daylightRefugeThreatSince = 0;
let deathRecoveryState = null;
const blockedBedsForNight = new Set();
const temporarilyIgnoredHostiles = new Map();
const corneredRangedHostiles = new Map();

// Death chunks can remain unloaded through an entire night, so their item
// despawn clocks are paused. Keep recovery eligible long enough to shelter
// until daylight and travel back safely.
const DEATH_RECOVERY_WINDOW_MS = 30 * 60 * 1000;
const MAX_STALLED_DEATH_RECOVERIES = 10;

function chooseImmediateAction(bot, observation, level = null) {
    if (!isNight(bot)) {
        emergencyShelterBlockedForNight = false;
        emergencyShelterPosition = null;
        emergencyShelterFailures = 0;
        blockedBedsForNight.clear();
    }
    const waterContactThreat = bot.entity?.isInWater ? nearestHostile(bot, 3.5) : null;
    if (
        waterContactThreat &&
        waterContactThreat.distance <= 3.2 &&
        MELEE_HOSTILES.has(waterContactThreat.name) &&
        (hasCombatWeapon(bot) || observation.health >= 12)
    ) {
        return {
            action: 'fight_mob',
            entityId: waterContactThreat.entity.id,
            reason: `${waterContactThreat.name} is attacking at contact range in water`
        };
    }
    if (needsAir(bot) || bot.entity?.isInWater) {
        return {
            action: 'escape_water',
            reason: needsAir(bot)
                ? 'Head is underwater; surface and reach dry ground'
                : 'In water during surface work; reach dry ground'
        };
    }
    if (movement.bodyIntersectsSolid(bot)) {
        return {
            action: 'escape_collision',
            reason: 'Body intersects a solid block; clear breathing space immediately'
        };
    }
    if (lacksStableFloor(bot) && !isInsideRememberedBase(bot)) {
        return {
            action: 'escape_pit',
            reason: 'Body is balanced without a stable floor; create a safe standing cell first'
        };
    }

    if (isEmergencyShelter(bot)) {
        const entranceThreat = nearestHostile(bot, 12);
        if (
            entranceThreat &&
            entranceThreat.distance <= 3.2 &&
            MELEE_HOSTILES.has(entranceThreat.name) &&
            hasCombatWeapon(bot) &&
            observation.health > 6
        ) {
            return {
                action: 'fight_mob',
                entityId: entranceThreat.entity.id,
                reason: `${entranceThreat.name} reached the refuge wall; counterattack before waiting`
            };
        }
        const blocksMorningExit = Boolean(entranceThreat && (
            entranceThreat.distance <= 3.5 ||
            ['skeleton', 'stray', 'creeper'].includes(entranceThreat.name)
        ));
        if (isNight(bot)) daylightRefugeThreatSince = 0;
        if (!isNight(bot) && blocksMorningExit && !daylightRefugeThreatSince) {
            daylightRefugeThreatSince = Date.now();
        }
        const rangedAtEntrance = ['skeleton', 'stray'].includes(entranceThreat?.name);
        const daylightWaitMs = rangedAtEntrance ? 90 * 1000 : 20 * 1000;
        const waitForDaylightThreat = !isNight(bot) && blocksMorningExit &&
            Date.now() - daylightRefugeThreatSince < daylightWaitMs;
        if (isNight(bot) || waitForDaylightThreat) {
            return {
                action: 'wait_safe',
                ms: entranceThreat ? 2000 : 3000,
                reason: entranceThreat
                    ? `Keep refuge sealed; ${entranceThreat.name} is still outside`
                    : 'Sealed emergency shelter blocks outside threats; wait for daylight'
            };
        }
        daylightRefugeThreatSince = 0;
        return {
            action: 'escape_pit',
            reason: entranceThreat
                ? `Morning arrived; open the refuge before confronting ${entranceThreat.name}`
                : 'Morning arrived and the refuge entrance is clear'
        };
    }

    if (observation.health <= 14 && observation.food < 20 && food.foodScore(observation.inventory) > 0) {
        if (observation.food >= 20) {
            return {
                action: 'wait_safe',
                ms: 1200,
                reason: 'Food is full; pause briefly for natural regeneration'
            };
        }
        return {
            action: 'eat_food',
            reason: 'Health is critical; eat before any movement or combat plan'
        };
    }

    const unarmedNightThreat = isNight(bot) && !hasCombatWeapon(bot)
        ? nearestHostile(bot, 10)
        : null;
    if (unarmedNightThreat && unarmedNightThreat.distance > 4) {
        if (!emergencyShelterBlockedForNight && !isInsideRememberedBase(bot)) {
            return {
                action: 'emergency_shelter',
                reason: `Unarmed at night; break line of sight from ${unarmedNightThreat.name}`
            };
        }
    }

    const nearbyRefugeThreat = nearestHostile(bot, 10);
    if (
        isNight(bot) &&
        isSurface(bot) &&
        memory.hasBase() &&
        !isInsideRememberedBase(bot) &&
        isNearBase(bot, 10) &&
        (!nearbyRefugeThreat || nearbyRefugeThreat.distance > 4)
    ) {
        if (emergencyShelterBlockedForNight) {
            return {
                action: 'wait_safe',
                ms: 3000,
                reason: 'Base entry and emergency refuge are blocked; hold near the base until daylight'
            };
        }
        return {
            action: 'return_base',
            reason: 'Night threat nearby; enter and secure the base first'
        };
    }

    const unfinishedNightExit = memory.getSurfaceExit();
    if (
        isNight(bot) &&
        !memory.hasBase() &&
        unfinishedNightExit &&
        !nearestHostile(bot, 12) &&
        unfinishedNightExit.y - bot.entity.position.y >= 1 &&
        unfinishedNightExit.y - bot.entity.position.y <= 4
    ) {
        return {
            action: 'emergency_shelter',
            reason: 'Finish sealing the shallow night refuge before attempting to climb out'
        };
    }

    const pitEscapeNeeded = shouldReachSurfaceForWork(bot, observation, level) ||
        shouldEscapePit(bot, observation, level);
    const trappedThreat = nearestHostile(bot, 4);
    if (
        pitEscapeNeeded &&
        trappedThreat?.name === 'creeper' &&
        trappedThreat.distance <= 3.2 &&
        Math.abs(trappedThreat.entity.position.y - bot.entity.position.y) <= 1.8
    ) {
        return {
            action: 'emergency_shelter',
            reason: 'Creeper blocks the pit exit; seal cover before opening another route'
        };
    }
    if (
        trappedThreat &&
        Math.abs(trappedThreat.entity.position.y - bot.entity.position.y) <= 1.8 &&
        trappedThreat.distance <= 3.5 &&
        hasCombatWeapon(bot)
    ) {
        if (MELEE_HOSTILES.has(trappedThreat.name) && observation.health > 8) {
            return {
                action: 'fight_mob',
                entityId: trappedThreat.id,
                reason: `Cornered by ${trappedThreat.name}; use the equipped weapon`
            };
        }
        return chooseThreatAction(bot, trappedThreat, observation.health);
    }

    const climbThreat = nearestHostile(bot, 10);
    if (
        pitEscapeNeeded &&
        (
            !climbThreat ||
            climbThreat.distance > 3.2 ||
            !shouldInterruptForThreat(bot, climbThreat)
        )
    ) {
        return {
            action: 'escape_pit',
            reason: climbThreat
                ? `Reach the surface before engaging distant ${climbThreat.name}`
                : 'Trapped below the remembered surface; finish recovery first'
        };
    }

    const hostile = nearestHostile(bot, 10);
    if (
        hostile &&
        isActionableThreat(bot, hostile) &&
        (
            !shouldReachSurfaceForWork(bot, observation, level) ||
            Math.abs(hostile.entity.position.y - bot.entity.position.y) <= 2.5 ||
            observation.health < 20
        ) &&
        (observation.health <= 18 || hostile.distance <= 7)
    ) {
        return chooseThreatAction(bot, hostile, observation.health);
    }

    const lastDeath = memory.getLastDeath();
    if (lastDeath && Date.now() - lastDeath.at < DEATH_RECOVERY_WINDOW_MS) {
        const recoveryThreat = nearestHostile(bot, 10);
        if (!hasCombatWeapon(bot) && (isNight(bot) || recoveryThreat)) {
            if (!isEmergencyShelter(bot) && !memory.hasBase()) {
                return {
                    action: 'emergency_shelter',
                    reason: 'Unarmed recovery is unsafe at night; shelter until the route is clear'
                };
            }
            if (memory.hasBase() && !isInsideRememberedBase(bot)) {
                return {
                    action: 'return_base',
                    reason: 'Unarmed recovery is unsafe; return to base before retrying'
                };
            }
            return {
                action: 'wait_safe',
                ms: 3000,
                reason: recoveryThreat
                    ? `Delay unarmed recovery while ${recoveryThreat.name} guards the route`
                    : 'Delay unarmed recovery until daylight'
            };
        }
        return {
            action: 'recover_items',
            reason: observation.health <= 10
                ? 'Recover dropped food and equipment before searching an exhausted area'
                : 'Recover dropped inventory before it despawns'
        };
    }

    if (observation.health <= 10) {
        if (food.foodScore(observation.inventory) > 0) {
            return {
                action: 'eat_food',
                reason: 'Health is critical; eat to restore natural regeneration'
            };
        }
        if (!isNight(bot)) {
            if (food.isTemporarilyUnavailable()) {
                food.shortenUnavailableCooldown(15000);
                return {
                    action: 'wait_safe',
                    ms: 5000,
                    reason: 'Food search area is exhausted; pause before scanning the next frontier'
                };
            }
            return {
                action: 'find_food',
                reason: 'Health is critical and hunger prevents regeneration'
            };
        }
        if (memory.hasBase() && !isInsideRememberedBase(bot)) {
            return {
                action: 'return_base',
                reason: 'Low health at night; return to shelter before searching for food'
            };
        }
        if (!memory.hasBase() && !isEmergencyShelter(bot)) {
            return {
                action: 'emergency_shelter',
                reason: 'Low health at night; seal a refuge until food can be found safely'
            };
        }
        return {
            action: 'wait_safe',
            ms: 3000,
            reason: 'Low health at night; remain protected until daylight'
        };
    }

    // A distant hostile above a sealed shaft cannot reach the bot yet. Finish
    // opening movement space, but never override the actionable threat above.
    if (shouldReachSurfaceForWork(bot, observation, level)) {
        return {
            action: 'escape_pit',
            reason: 'Trapped below the remembered surface; finish recovery first'
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

    if (shouldEscapePit(bot, observation, level)) {
        return {
            action: 'escape_pit',
            reason: 'Trapped in a pit; get out first'
        };
    }

    if (isNight(bot) && isSurface(bot)) {
        if (level?.id === 'L6_CRAFT_STONE_TOOLS') return null;
        if (findNearbyBed(bot, 8)) {
            return {
                action: 'sleep_bed',
                reason: 'Night and bed found; sleep'
            };
        }

        if (memory.hasBase()) {
            const base = memory.getBase();
            if (!shelter.isInsideShelter(
                bot.entity.position,
                new Vec3(base.x, base.y, base.z)
            )) {
                return {
                    action: 'return_base',
                    reason: 'Night on surface; enter the base before waiting'
                };
            }

            if (shouldPauseForNight(level)) {
                return {
                    action: 'wait_safe',
                    ms: 3000,
                    reason: 'Night and no bed; risky outside task delayed until morning'
                };
            }
        } else if (EARLY_GAME_LEVELS.has(level?.id)) {
            if (emergencyShelterBlockedForNight) {
                if (level?.id === 'L1_COLLECT_WOOD' && !preferredRecoveryBlock(bot)) {
                    return null;
                }
                return {
                    action: 'wait_safe',
                    ms: 3000,
                    reason: 'Emergency shelter failed on this terrain; hold position and monitor threats until dawn'
                };
            }
            return {
                action: 'emergency_shelter',
                reason: 'Night arrived before the first base; make a temporary refuge'
            };
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

async function recoverDeathItems(bot) {
    const actionVersion = actionControl.snapshot(bot);
    const death = memory.getLastDeath();
    if (!death) return false;
    if (Date.now() - death.at >= DEATH_RECOVERY_WINDOW_MS) {
        memory.clearLastDeath();
        deathRecoveryState = null;
        throw new Error('Dropped inventory recovery window expired');
    }

    const target = new Vec3(death.position.x, death.position.y, death.position.z);
    const recoveryThreat = nearestHostile(bot, 8);
    if (recoveryThreat && !hasCombatWeapon(bot)) {
        memory.clearLastDeath();
        deathRecoveryState = null;
        throw new Error(
            `Dropped inventory recovery abandoned near ${recoveryThreat.name}; bot is unarmed`
        );
    }
    const startingDistance = bot.entity.position.distanceTo(target);
    if (!deathRecoveryState || deathRecoveryState.deathAt !== death.at) {
        deathRecoveryState = {
            deathAt: death.at,
            bestDistance: startingDistance,
            stalledAttempts: 0
        };
    }
    const before = bot.inventory.items().reduce((sum, item) => sum + item.count, 0);
    const rememberedBase = memory.getBase();
    if (rememberedBase && bot.entity.position.distanceTo(target) > 30) {
        await shelter.returnToBase(bot);
        actionControl.assertActive(bot, actionVersion);
    }
    try {
        await movement.moveNear(bot, target, 2, 20000);
    } catch (error) {
        actionControl.assertActive(bot, actionVersion);
        console.log(`[SURVIVAL] death recovery path fallback: ${error.message}`);
    }
    actionControl.assertActive(bot, actionVersion);
    if (bot.entity.position.distanceTo(target) > 4) {
        console.log(
            `[SURVIVAL] pathfinder ended outside recovery range; ` +
            `distance=${bot.entity.position.distanceTo(target).toFixed(1)} using local traversal`
        );
        for (let attempt = 0; attempt < 5 && bot.entity.position.distanceTo(target) > 3; attempt++) {
            const threat = nearestHostile(bot, 8);
            if (threat && !hasCombatWeapon(bot)) {
                memory.clearLastDeath();
                deathRecoveryState = null;
                throw new Error(`Dropped inventory recovery interrupted by ${threat.name}`);
            }
            const moved = await movement.moveTowardSafely(bot, target, 24);
            actionControl.assertActive(bot, actionVersion);
            if (!moved) await movement.clearNearbyFoliage(bot, target, 2);
        }
    }
    actionControl.assertActive(bot, actionVersion);

    if (bot.entity.position.distanceTo(target) > 4) {
        const endingDistance = bot.entity.position.distanceTo(target);
        if (endingDistance < deathRecoveryState.bestDistance - 0.15) {
            deathRecoveryState.bestDistance = endingDistance;
            deathRecoveryState.stalledAttempts = 0;
        } else {
            deathRecoveryState.stalledAttempts += 1;
        }
        if (deathRecoveryState.stalledAttempts >= MAX_STALLED_DEATH_RECOVERIES) {
            const escaped = await movement.escapeLocalDeadEnd(
                bot,
                () => Number(bot.sorimActionVersion || 0) === actionVersion
            );
            actionControl.assertActive(bot, actionVersion);
            if (escaped) {
                deathRecoveryState.bestDistance = bot.entity.position.distanceTo(target);
                deathRecoveryState.stalledAttempts = 0;
            } else {
                deathRecoveryState.stalledAttempts = Math.floor(MAX_STALLED_DEATH_RECOVERIES / 2);
            }
        }
        await movement.sleep(750);
        throw new Error(
            `Could not reach dropped items at ${target.toString()}; ` +
            `distance=${endingDistance.toFixed(1)} best=${deathRecoveryState.bestDistance.toFixed(1)}`
        );
    }
    for (let sweep = 0; sweep < 3; sweep++) {
        actionControl.assertActive(bot, actionVersion);
        const drops = Object.values(bot.entities)
            .filter(entity => entity?.name === 'item' && entity.position.distanceTo(target) <= 10)
            .sort((left, right) =>
                left.position.distanceTo(bot.entity.position) -
                right.position.distanceTo(bot.entity.position)
            );
        for (const drop of drops) {
            await movement.moveNear(bot, drop.position, 1, 5000).catch(() => undefined);
            actionControl.assertActive(bot, actionVersion);
        }
        await movement.sleep(700);
    }
    const after = bot.inventory.items().reduce((sum, item) => sum + item.count, 0);
    actionControl.assertActive(bot, actionVersion);
    memory.clearLastDeath();
    deathRecoveryState = null;
    console.log(`[SURVIVAL] death recovery inventory=${before}->${after}`);
    return after > before;
}

async function buildEmergencyShelter(bot) {
    try {
        const result = await buildEmergencyShelterAttempt(bot);
        emergencyShelterFailures = 0;
        return result;
    } catch (error) {
        emergencyShelterFailures++;
        emergencyShelterBlockedForNight = emergencyShelterFailures >= 3;
        console.log(
            `[SURVIVAL] emergency shelter attempt failed ` +
            `${emergencyShelterFailures}/3: ${error.message}`
        );
        throw error;
    }
}

async function buildEmergencyShelterAttempt(bot) {
    if (isEmergencyShelter(bot)) {
        await waitSafe(bot, 3000);
        return;
    }
    const actionVersion = actionControl.snapshot(bot);
    let current = bot.entity.position.floored();
    const rememberedExit = memory.getSurfaceExit();
    if (!rememberedExit || current.y > rememberedExit.y) {
        memory.setSurfaceExit(current);
    }
    let surfaceExit = memory.getSurfaceExit();
    let targetBottomY = surfaceExit.y - 3;
    console.log(`[SURVIVAL] building emergency night shelter ${bot.entity.position.floored().toString()}`);

    if (!hasSkyExposure(bot) && await carveLateralNightRefuge(bot, actionVersion)) {
        emergencyShelterPosition = bot.entity.position.floored();
        if (isEmergencyShelter(bot)) {
            console.log('[SURVIVAL] underground corridor converted to a lateral night refuge');
            await waitSafe(bot, 3000);
            return;
        }
        emergencyShelterPosition = null;
    }

    if (surfaceRefugeMaterialCount(bot) >= 10 && preferredRecoveryBlock(bot)) {
        const refugeCenter = findPartialSurfaceRefugeCenter(bot, current) || (
            isSurfaceRefugeSiteSafe(bot, current)
                ? current
                : findNearbySurfaceRefugeCenter(bot, current)
        );
        if (refugeCenter) {
            let reachedRefugeCenter = true;
            if (!refugeCenter.equals(current)) {
                console.log(`[SURVIVAL] moving to surface refuge site ${refugeCenter.toString()}`);
                try {
                    await movement.moveBlock(bot, refugeCenter, 8000);
                    actionControl.assertActive(bot, actionVersion);
                    reachedRefugeCenter = bot.entity.position.floored().equals(refugeCenter);
                } catch (error) {
                    reachedRefugeCenter = false;
                    console.log(`[SURVIVAL] surface refuge site unreachable: ${error.message}`);
                }
            }
            if (reachedRefugeCenter) {
                current = occupiedFeetCell(bot);
                memory.setSurfaceExit(current);
                await buildSurfaceNightRefuge(bot, current, actionVersion);
                emergencyShelterPosition = occupiedFeetCell(bot);
                if (!isEmergencyShelter(bot)) {
                    emergencyShelterPosition = null;
                    throw new Error('Surface emergency refuge could not be sealed');
                }
                console.log('[SURVIVAL] surface emergency refuge sealed');
                await waitSafe(bot, 3000);
                return;
            }
            console.log('[SURVIVAL] falling back to a refuge at the current position');
        }
    }

    if (!isEmergencyColumnSafe(bot, current, targetBottomY)) {
        console.log(`[SURVIVAL] refuge column rejected: ${describeEmergencyColumn(bot, current, targetBottomY)}`);
        const safeColumn = findNearbyEmergencyColumn(bot, current);
        if (safeColumn) {
            console.log(`[SURVIVAL] moving to safe refuge column ${safeColumn.toString()}`);
            await movement.moveBlock(bot, safeColumn, 8000);
            actionControl.assertActive(bot, actionVersion);
            current = bot.entity.position.floored();
            memory.setSurfaceExit(current);
            emergencyShelterPosition = current.clone();
            if (isEmergencyShelter(bot)) {
                console.log('[SURVIVAL] reused naturally roofed lateral refuge');
                await waitSafe(bot, 3000);
                return;
            }
            emergencyShelterPosition = null;
            surfaceExit = memory.getSurfaceExit();
            targetBottomY = surfaceExit.y - 3;
        }
        if (!isEmergencyColumnSafe(bot, current, targetBottomY)) {
            console.log('[SURVIVAL] no safe underground refuge column; building a surface refuge');
            await buildSurfaceNightRefuge(bot, current, actionVersion);
            emergencyShelterPosition = bot.entity.position.floored();
            if (!isEmergencyShelter(bot)) {
                emergencyShelterPosition = null;
                throw new Error('Surface emergency refuge could not be sealed');
            }
            console.log('[SURVIVAL] surface emergency refuge sealed');
            await waitSafe(bot, 3000);
            return;
        }
    }

    for (let attempt = 0; attempt < 6 && bot.entity.position.y > targetBottomY + 0.1; attempt++) {
        actionControl.assertActive(bot, actionVersion);
        const feet = bot.entity.position.floored();
        const floor = bot.blockAt(feet.offset(0, -1, 0));
        const belowFloor = bot.blockAt(feet.offset(0, -2, 0));
        if (isAir(floor)) {
            const support = bot.blockAt(feet.offset(0, -3, 0));
            if (!isSafeEmergencyFloor(belowFloor, support)) {
                throw new Error('Emergency shelter has an unsafe open drop');
            }
            await waitForDescent(bot, bot.entity.position.y, 1800);
            continue;
        }
        if (!isSafeEmergencyFloor(floor, belowFloor) || !bot.canDigBlock(floor)) {
            console.log(
                `[SURVIVAL] underground refuge unsafe (${floor?.name || 'unknown'}); ` +
                'building a surface refuge'
            );
            await buildSurfaceNightRefuge(bot, current, actionVersion);
            emergencyShelterPosition = bot.entity.position.floored();
            if (!isEmergencyShelter(bot)) {
                emergencyShelterPosition = null;
                throw new Error('Surface emergency refuge could not be sealed');
            }
            console.log('[SURVIVAL] surface emergency refuge sealed');
            await waitSafe(bot, 3000);
            return;
        }
        const beforeY = bot.entity.position.y;
        await bot.lookAt(floor.position.offset(0.5, 0.5, 0.5), true);
        await mine.clearBlock(bot, floor);
        await waitForDescent(bot, beforeY, 1800);
    }
    if (bot.entity.position.y > targetBottomY + 0.1) {
        throw new Error(`Emergency shelter could not reach target depth ${targetBottomY}`);
    }

    actionControl.assertActive(bot, actionVersion);
    const feet = bot.entity.position.floored();
    const roofPosition = feet.offset(0, 2, 0);
    const roof = bot.blockAt(roofPosition);
    if (isAir(roof)) {
        let blockItem = preferredRecoveryBlock(bot, [
            'dirt', 'cobbled_deepslate', 'cobblestone', 'sandstone',
            'red_sandstone', 'terracotta'
        ]) || bot.inventory.items().find(item => item.name.endsWith('_log'));
        if (!blockItem) {
            await acquireRecoveryBlock(bot);
            blockItem = preferredRecoveryBlock(bot, [
                'dirt', 'cobbled_deepslate', 'cobblestone', 'sandstone',
                'red_sandstone', 'terracotta'
            ]) || bot.inventory.items().find(item => item.name.endsWith('_log'));
        }
        if (!blockItem && await carveLateralNightRefuge(bot, actionVersion)) {
            emergencyShelterPosition = bot.entity.position.floored();
            if (isEmergencyShelter(bot)) {
                console.log('[SURVIVAL] lateral night refuge sealed by natural stone');
                await waitSafe(bot, 3000);
                return;
            }
            emergencyShelterPosition = null;
        }
        if (!blockItem) throw new Error('Emergency shelter has no block for the roof');
        const reference = findEmergencyRoofReference(bot, roofPosition);
        if (!reference) throw new Error('Emergency shelter roof has no placement reference');
        await bot.equip(blockItem, 'hand');
        await bot.lookAt(roofPosition.offset(0.5, 0.5, 0.5), true);
        await placeEmergencyBlockTolerant(
            bot,
            reference,
            roofPosition,
            blockItem.name
        );
    }

    emergencyShelterPosition = bot.entity.position.floored();
    if (!isEmergencyShelter(bot)) {
        emergencyShelterPosition = null;
        throw new Error('Emergency shelter could not be sealed');
    }
    console.log('[SURVIVAL] emergency night shelter sealed');
    await waitSafe(bot, 3000);
}

function findPartialSurfaceRefugeCenter(bot, origin, radius = 3) {
    const buildMaterials = new Set([
        'dirt', 'cobblestone', 'cobbled_deepslate', 'sandstone',
        'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
        'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks'
    ]);
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            const center = origin.offset(dx, 0, dz);
            if (!center.equals(origin)) continue;
            if (!isPassable(bot.blockAt(center)) || !isPassable(bot.blockAt(center.offset(0, 1, 0)))) {
                continue;
            }
            if (!hasSupportedRefugeFootprint(bot, center)) continue;
            const shell = [
                new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
                new Vec3(0, 0, 1), new Vec3(0, 0, -1),
                new Vec3(1, 1, 0), new Vec3(-1, 1, 0),
                new Vec3(0, 1, 1), new Vec3(0, 1, -1),
                new Vec3(1, 2, 0), new Vec3(0, 2, 0)
            ];
            const placed = shell.reduce((count, offset) => {
                const block = bot.blockAt(center.plus(offset));
                return count + (buildMaterials.has(block?.name) ? 1 : 0);
            }, 0);
            if (placed < 2) continue;
            candidates.push({ center, placed, distance: horizontalDistance(center, origin) });
        }
    }
    candidates.sort((left, right) => right.placed - left.placed || left.distance - right.distance);
    const candidate = candidates[0];
    if (candidate) {
        console.log(
            `[SURVIVAL] resuming partial refuge center=${candidate.center.toString()} ` +
            `blocks=${candidate.placed}`
        );
    }
    return candidate?.center || null;
}

function hasSupportedRefugeFootprint(bot, center) {
    return [
        new Vec3(0, 0, 0),
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ].every(offset => {
        const feet = center.plus(offset);
        return isSafeEmergencyFloor(
            bot.blockAt(feet.offset(0, -1, 0)),
            bot.blockAt(feet.offset(0, -2, 0))
        );
    });
}

function isEmergencyColumnSafe(bot, current, targetBottomY) {
    for (let y = current.y - 1; y >= targetBottomY; y--) {
        const floor = bot.blockAt(new Vec3(current.x, y, current.z));
        const below = bot.blockAt(new Vec3(current.x, y - 1, current.z));
        if (!isSafeEmergencyFloor(floor, below) || floor.hardness === -1) return false;
    }
    return isEmergencyPocketEnclosed(bot, current, targetBottomY);
}

function isEmergencyPocketEnclosed(bot, current, targetBottomY) {
    const offsets = [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ];
    return offsets.every(offset => [0, 1].every(dy => {
        const wall = bot.blockAt(new Vec3(
            current.x + offset.x,
            targetBottomY + dy,
            current.z + offset.z
        ));
        return wall?.boundingBox === 'block' && wall.hardness !== -1;
    }));
}

function describeEmergencyColumn(bot, current, targetBottomY) {
    const layers = [];
    for (let y = current.y - 1; y >= targetBottomY; y--) {
        const floor = bot.blockAt(new Vec3(current.x, y, current.z));
        const below = bot.blockAt(new Vec3(current.x, y - 1, current.z));
        layers.push(`${y}:${floor?.name || 'unknown'}/${below?.name || 'unknown'} h=${floor?.hardness}`);
    }
    return layers.join(', ');
}

function findNearbyEmergencyColumn(bot, origin, radius = 4) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            if (dx === 0 && dz === 0) continue;
            for (let dy = 1; dy >= -1; dy--) {
                const feet = origin.offset(dx, dy, dz);
                if (!isPassable(bot.blockAt(feet)) || !isPassable(bot.blockAt(feet.offset(0, 1, 0)))) {
                    continue;
                }
                if (!isEmergencyColumnSafe(bot, feet, feet.y - 3)) continue;
                candidates.push({
                    feet,
                    distance: Math.hypot(dx, dz) + Math.abs(dy) * 0.75
                });
                break;
            }
        }
    }
    candidates.sort((left, right) => left.distance - right.distance);
    return candidates[0]?.feet || null;
}

function findNearbySurfaceRefugeCenter(bot, origin, radius = 5) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = 2; dy >= -2; dy--) {
                const feet = origin.offset(dx, dy, dz);
                if (!isSurfaceRefugeSiteSafe(bot, feet)) continue;
                candidates.push({
                    feet,
                    distance: Math.hypot(dx, dz) + Math.abs(dy) * 0.75
                });
                break;
            }
        }
    }
    candidates.sort((left, right) => left.distance - right.distance);
    return candidates[0]?.feet || null;
}

function isSurfaceRefugeSiteSafe(bot, center) {
    const footprint = [
        new Vec3(0, 0, 0),
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ];
    return footprint.every(offset => {
        const feet = center.plus(offset);
        const head = feet.offset(0, 1, 0);
        const floor = feet.offset(0, -1, 0);
        const support = feet.offset(0, -2, 0);
        return isPassable(bot.blockAt(feet)) &&
            isPassable(bot.blockAt(head)) &&
            isSafeEmergencyFloor(bot.blockAt(floor), bot.blockAt(support));
    });
}

async function buildSurfaceNightRefuge(bot, center, actionVersion) {
    if (!await movement.centerInCurrentCell(bot)) {
        throw new Error('Could not center inside the emergency refuge footprint');
    }
    center = bot.entity.position.floored();
    actionControl.assertActive(bot, actionVersion);
    await prepareSurfaceRefugeMaterials(bot, center, actionVersion);
    for (const offset of [
        new Vec3(1, -1, 0), new Vec3(-1, -1, 0),
        new Vec3(0, -1, 1), new Vec3(0, -1, -1)
    ]) {
        const position = center.plus(offset);
        if (bot.blockAt(position)?.boundingBox === 'block') continue;
        const item = preferredSurfaceWallBlock(bot);
        if (!item) throw new Error('No blocks available for an emergency refuge foundation');
        const reference = findPlacementReference(bot, position);
        if (!reference) throw new Error(`No placement reference for refuge foundation ${position.toString()}`);
        await bot.equip(item, 'hand');
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await placeEmergencyBlockTolerant(bot, reference, position, item.name);
    }
    const walls = [];
    for (const offset of [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ]) {
        walls.push(center.plus(offset), center.plus(offset).offset(0, 1, 0));
    }
    const roofAnchor = center.offset(1, 2, 0);
    const roofPosition = center.offset(0, 2, 0);
    for (const position of [...walls, roofAnchor, roofPosition]) {
        actionControl.assertActive(bot, actionVersion);
        if (bot.blockAt(position)?.boundingBox === 'block') continue;
        const item = position.equals(roofPosition)
            ? preferredRecoveryBlock(bot)
            : preferredSurfaceWallBlock(bot);
        if (!item) throw new Error('No blocks available for a surface emergency refuge');
        const reference = findPlacementReference(bot, position);
        if (!reference) throw new Error(`No placement reference for refuge ${position.toString()}`);
        await bot.equip(item, 'hand');
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await placeEmergencyBlockTolerant(bot, reference, position, item.name);
    }
}

async function placeEmergencyBlockTolerant(bot, reference, position, expectedName) {
    const item = bot.inventory.items().find(entry => entry.name === expectedName);
    if (!item) throw new Error(`${expectedName} is no longer available for the refuge`);
    return craft.placeAtTolerant(bot, item, reference, position);
}

async function prepareSurfaceRefugeMaterials(bot, center, actionVersion) {
    if (surfaceRefugeMaterialCount(bot) >= 14 && preferredRecoveryBlock(bot)) return;
    const sandId = bot.registry.blocksByName.sand?.id;
    if (!sandId) return;

    for (let attempt = 0; attempt < 20 && inventoryCount(bot, 'sand') < 16; attempt++) {
        actionControl.assertActive(bot, actionVersion);
        const block = bot.findBlocks({ matching: sandId, maxDistance: 5, count: 48 })
            .map(position => bot.blockAt(position))
            .filter(candidate => candidate?.position.distanceTo(center) > 1.5)
            .filter(candidate => isAir(bot.blockAt(candidate.position.offset(0, 1, 0))))
            .filter(candidate => bot.canDigBlock(candidate))
            .filter(candidate => blockPolicy.canBreak(bot, candidate, 'terrain_recovery').allowed)
            .sort((left, right) =>
                left.position.distanceTo(bot.entity.position) -
                right.position.distanceTo(bot.entity.position)
            )[0];
        if (!block) break;
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        await movement.withTimeout(bot.dig(block), 5000, 'Timed out gathering refuge sand');
        await movement.sleep(250);
    }

    if (inventoryCount(bot, 'sand') >= 4 && inventoryCount(bot, 'sandstone') < 1) {
        await craft.craftItem(bot, 'sandstone', 1);
    }
}

function preferredSurfaceWallBlock(bot) {
    return preferredRecoveryBlock(bot) ||
        bot.inventory.items().find(item => item.name === 'sand') ||
        null;
}

function surfaceRefugeMaterialCount(bot) {
    const stable = [
        'dirt', 'cobbled_deepslate', 'cobblestone', 'sandstone',
        'oak_planks', 'birch_planks'
    ].reduce((sum, name) => sum + inventoryCount(bot, name), 0);
    return stable + inventoryCount(bot, 'sand');
}

function inventoryCount(bot, name) {
    return bot.inventory.items()
        .filter(item => item.name === name)
        .reduce((sum, item) => sum + item.count, 0);
}

function isEmergencyShelter(bot) {
    if (!bot.entity) return false;
    const surfaceExit = memory.getSurfaceExit();
    if (!surfaceExit) return false;
    if (emergencyShelterPosition) {
        if (bot.entity.position.distanceTo(emergencyShelterPosition) > 2.5) return false;
    } else {
        const horizontal = Math.hypot(
            bot.entity.position.x - surfaceExit.x,
            bot.entity.position.z - surfaceExit.z
        );
        const depth = surfaceExit.y - bot.entity.position.y;
        if (horizontal > 3 || depth < -1 || depth > 6) return false;
    }
    if (memory.hasBase() && isNearBase(bot, 6)) return false;
    const feet = bot.entity.position.floored();
    const roof = bot.blockAt(feet.offset(0, 2, 0));
    if (roof?.boundingBox !== 'block') return false;
    const wallOffsets = [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ];
    const solidWalls = wallOffsets.reduce((count, offset) => {
        const lower = bot.blockAt(feet.plus(offset));
        const upper = bot.blockAt(feet.plus(offset).offset(0, 1, 0));
        return count + Number(lower?.boundingBox === 'block') + Number(upper?.boundingBox === 'block');
    }, 0);
    return solidWalls >= 6;
}

function isSafeEmergencyFloor(floor, belowFloor) {
    const unsafe = new Set([
        'air', 'cave_air', 'void_air', 'water', 'lava',
        'sand', 'red_sand', 'gravel', 'powder_snow', 'magma_block'
    ]);
    const unsupportedFoliage = block =>
        block?.name?.endsWith('_leaves') || block?.name?.endsWith('_log');
    return Boolean(
        floor?.boundingBox === 'block' &&
        belowFloor?.boundingBox === 'block' &&
        !unsupportedFoliage(floor) &&
        !unsupportedFoliage(belowFloor) &&
        !unsafe.has(floor.name) &&
        !unsafe.has(belowFloor.name)
    );
}

function findEmergencyRoofReference(bot, position) {
    const references = [
        { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
        { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
        { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
        { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) }
    ];
    for (const candidate of references) {
        const block = bot.blockAt(position.plus(candidate.offset));
        if (block?.boundingBox === 'block') return { block, face: candidate.face };
    }
    return null;
}

async function waitForDescent(bot, startY, timeoutMs) {
    movement.stop(bot);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (bot.entity.position.y <= startY - 0.7) return true;
        await movement.sleep(50);
    }
    emergencyShelterBlockedForNight = true;
    throw new Error('Bot did not descend into the emergency shelter');
}

function chooseThreatAction(bot, hostile, health = bot.health) {
    const ranged = ['skeleton', 'stray'].includes(hostile.name);
    if (hostile.name === 'creeper') {
        if (hasCombatWeapon(bot) && health > 12 && hostile.distance >= 3.4) {
            return {
                action: 'fight_mob',
                entityId: hostile.id,
                reason: 'Armed and healthy; use controlled hit-and-retreat attacks on creeper'
            };
        }
        return {
            action: 'evade_hostile',
            entityId: hostile.id,
            reason: 'Creeper in blast range; create distance immediately'
        };
    }
    if (
        ranged &&
        isNight(bot) &&
        !memory.hasBase() &&
        hostile.distance > 3.2 &&
        !emergencyShelterBlockedForNight &&
        preferredRecoveryBlock(bot)
    ) {
        return {
            action: 'emergency_shelter',
            reason: `No base or shield; block line of sight from ${hostile.name}`
        };
    }
    if (
        !hasCombatWeapon(bot) &&
        hostile.distance > 3.5 &&
        memory.hasBase() &&
        !isInsideRememberedBase(bot) &&
        isNearBase(bot, 24)
    ) {
        return {
            action: 'return_base',
            reason: `Unarmed near ${hostile.name}; take cover inside the nearby base`
        };
    }
    if (
        ranged &&
        hostile.distance > 3.5 &&
        memory.hasBase() &&
        !isInsideRememberedBase(bot) &&
        isNearBase(bot, 24)
    ) {
        return {
            action: 'return_base',
            reason: `Ranged threat ${hostile.name}; take cover inside the nearby base`
        };
    }
    if (
        ranged &&
        !hasCombatWeapon(bot) &&
        (hostile.distance <= 7 || health < 18)
    ) {
        return {
            action: 'evade_hostile',
            entityId: hostile.id,
            reason: `Unarmed in arrow range; break line of sight from ${hostile.name}`
        };
    }
    if (ranged && !hasCombatWeapon(bot) && isNight(bot) && !memory.hasBase()) {
        return {
            action: 'emergency_shelter',
            reason: `No weapon or base; break line of sight from ${hostile.name}`
        };
    }
    if (
        ranged &&
        isNight(bot) &&
        !hasShield(bot) &&
        armorScore(bot) === 0 &&
        health <= 16 &&
        !memory.hasBase() &&
        !emergencyShelterBlockedForNight &&
        preferredRecoveryBlock(bot)
    ) {
        return {
            action: 'emergency_shelter',
            reason: `Low health without armor; block line of sight from ${hostile.name}`
        };
    }
    const canFightBareHanded = canFightUnarmed(bot, hostile, health);
    const rangedWithoutProtection = ranged && !hasShield(bot) && armorScore(bot) === 0;
    if (
        ranged &&
        hasCombatWeapon(bot) &&
        hostile.distance <= 8 &&
        health > 10 &&
        (corneredRangedHostiles.get(hostile.id) || 0) > Date.now()
    ) {
        return {
            action: 'fight_mob',
            entityId: hostile.id,
            reason: `Retreat is blocked; counterattack nearby ${hostile.name}`
        };
    }
    if (rangedWithoutProtection && hostile.distance > 3.2) {
        return {
            action: 'evade_hostile',
            entityId: hostile.id,
            reason: `No shield or armor; break line of sight from ${hostile.name}`
        };
    }
    const shouldEvade = (
        (!hasCombatWeapon(bot) && !canFightBareHanded) ||
        health <= 8 ||
        (armorScore(bot) === 0 && health <= 18) ||
        (rangedWithoutProtection && health <= 14)
    );
    return {
        action: shouldEvade ? 'evade_hostile' : 'fight_mob',
        entityId: hostile.id,
        reason: shouldEvade
            ? `Unsafe fight; evade ${hostile.name}`
            : `Threat nearby: ${hostile.name}`
    };
}

function shouldInterruptForThreat(bot, hostile) {
    if (!hostile) return false;
    if (!isActionableThreat(bot, hostile)) return false;
    const verticalDistance = Math.abs(
        (hostile.entity?.position?.y ?? bot.entity.position.y) - bot.entity.position.y
    );
    if (
        verticalDistance > 1.8 &&
        !['skeleton', 'stray', 'witch'].includes(hostile.name)
    ) return false;
    if (['skeleton', 'stray'].includes(hostile.name)) {
        if (hostile.distance <= 5) return true;
        if (hostile.distance <= 7) return true;
        return bot.health < 20 && hostile.distance <= 12;
    }
    if (hostile.name === 'creeper') return hostile.distance <= 8;
    return hostile.distance <= (hasCombatWeapon(bot) ? 10 : 6);
}

function isActionableThreat(bot, hostile) {
    if (isInsideRememberedBase(bot) && hostile.distance > 3) return false;
    if (hostile.distance <= 3.2 && hostile.name !== 'creeper') return true;
    if (hostile.distance <= 2.6) return true;
    return hasEntityLineOfSight(bot, hostile.entity);
}

function hasEntityLineOfSight(bot, entity) {
    if (typeof bot.canSeeEntity !== 'function') return true;
    try {
        return bot.canSeeEntity(entity) !== false;
    } catch {
        return true;
    }
}

function isInsideRememberedBase(bot) {
    const base = memory.getBase();
    if (!base || !bot.entity?.position) return false;
    return shelter.isInsideShelter(
        bot.entity.position,
        new Vec3(base.x, base.y, base.z)
    );
}

function isNearBase(bot, range) {
    const base = memory.getBase();
    if (!base) return false;
    const dx = bot.entity.position.x - base.x;
    const dy = bot.entity.position.y - base.y;
    const dz = bot.entity.position.z - base.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= range;
}

function shouldEscapePit(bot, observation, level = null) {
    if (memory.hasBase() && isNearBase(bot, 5)) return false;
    if (shelter.isBuildingNear(bot)) return false;
    if (isNight(bot) && isEmergencyShelter(bot)) return false;
    const constructionBase = memory.getConstructionBase();
    if (
        level?.id === 'L7_BUILD_SAFE_SHELTER' &&
        constructionBase &&
        bot.entity.position.y >= constructionBase.y - 0.1 &&
        (
            hasSkyExposure(bot) ||
            horizontalDistance(bot.entity.position, constructionBase) <= 5
        )
    ) return false;
    const surfaceExit = memory.getSurfaceExit();
    if (surfaceExit && bot.entity.position.y >= surfaceExit.y - 0.1) return false;
    if (
        level?.id === 'L7_BUILD_SAFE_SHELTER' &&
        !memory.hasBase() &&
        surfaceExit &&
        bot.entity.position.y < surfaceExit.y - 0.1
    ) {
        return true;
    }
    if (
        level?.id === 'L7_BUILD_SAFE_SHELTER' &&
        !memory.hasBase() &&
        hasNearbySurfaceRise(bot, 2) &&
        !hasOpenSurfaceRunway(bot)
    ) {
        return true;
    }
    if (!isInPit(bot)) return false;
    if (level?.id === 'L7_BUILD_SAFE_SHELTER' && !memory.hasBase()) return true;

    const hurtAndTrapped = observation.health < 14;
    if (hurtAndTrapped) return true;
    if (PLANNED_UNDERGROUND_LEVELS.has(level?.id)) return false;

    const hasEnoughStoneForNextStep = (observation.inventory.cobblestone || 0) >= 16 &&
        !memory.hasBase();
    if (hasEnoughStoneForNextStep) return false;

    return true;
}

function shouldReachSurfaceForWork(bot, observation, level) {
    if (
        isNight(bot) &&
        isEmergencyShelter(bot) &&
        level?.id !== 'L6_CRAFT_STONE_TOOLS'
    ) return false;
    if (PLANNED_UNDERGROUND_LEVELS.has(level?.id)) return false;
    const constructionBase = memory.getConstructionBase();
    if (
        level?.id === 'L7_BUILD_SAFE_SHELTER' &&
        constructionBase
    ) {
        if (bot.entity.position.y < constructionBase.y - 0.1) return true;
        if (
            hasSkyExposure(bot) ||
            horizontalDistance(bot.entity.position, constructionBase) <= 5
        ) return false;
        return true;
    }
    const surfaceExit = memory.getSurfaceExit();
    if (
        surfaceExit &&
        EARLY_GAME_LEVELS.has(level?.id) &&
        bot.entity.position.y < surfaceExit.y - 0.1
    ) {
        return true;
    }
    if (
        surfaceExit &&
        EARLY_GAME_LEVELS.has(level?.id) &&
        !hasSkyExposure(bot) &&
        !hasOpenSurfaceRunway(bot)
    ) {
        return true;
    }
    if (
        level?.id === 'L7_BUILD_SAFE_SHELTER' &&
        !memory.hasBase() &&
        /reach|path|stuck|movement|target/i.test(observation.lastError || '') &&
        hasNearbySurfaceRise(bot, 2) &&
        !hasOpenSurfaceRunway(bot)
    ) {
        return true;
    }
    // Valleys and hills can be well below the base Y while still being open
    // surface terrain. Height alone must never trigger shaft recovery there.
    if (hasSkyExposure(bot)) return false;
    const base = memory.getBase();
    if (
        base &&
        SURFACE_WORK_LEVELS.has(level?.id) &&
        bot.entity.position.y < base.y - 0.1 &&
        isInPit(bot)
    ) {
        return true;
    }

    if (level?.id === 'L7_BUILD_SAFE_SHELTER' && !memory.hasBase()) {
        if (shelter.isBuildingNear(bot)) return false;
        if (!isSurface(bot)) return true;
        if (surfaceExit) return bot.entity.position.y < surfaceExit.y - 0.1;
        return bot.entity.position.y < 55;
    }
    if (bot.entity.position.y >= 58) return false;
    if (
        level?.id === 'L21_STABLE_SURVIVAL' &&
        woodUnits(observation.inventory) < 2
    ) {
        return true;
    }
    return false;
}

function hasNearbySurfaceRise(bot, minimumRise) {
    const origin = bot.entity.position.floored();
    return findNearbyExits(bot, origin)
        .some(position => position.y >= origin.y + minimumRise);
}

function hasOpenSurfaceRunway(bot, length = 3) {
    const origin = occupiedFeetCell(bot);
    return [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ].some(direction => {
        for (let step = 1; step <= length; step++) {
            const feet = origin.offset(direction.x * step, 0, direction.z * step);
            const floor = bot.blockAt(feet.offset(0, -1, 0));
            if (
                !isPassable(bot.blockAt(feet)) ||
                !isPassable(bot.blockAt(feet.offset(0, 1, 0))) ||
                floor?.boundingBox !== 'block' ||
                ['water', 'lava'].includes(floor?.name)
            ) return false;
        }
        return true;
    });
}

async function fightMob(bot, entityId) {
    const entity = bot.entities[entityId] || nearestHostile(bot, 10)?.entity;
    if (!entity) return;

    const targetName = entityName(entity);
    console.log(`[SURVIVAL] fighting ${targetName}`);
    const weapon = await tools.equipBestWeapon(bot);
    if (!weapon) {
        await fightUnarmedDefensively(bot, entity);
        return;
    }

    if (targetName === 'creeper') {
        await fightCreeperSafely(bot, entity);
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

    const deadline = Date.now() + 30000;
    let strikes = 0;
    let approachFailures = 0;
    while (strikes < 12 && bot.health > 0 && Date.now() < deadline) {
        const liveEntity = bot.entities[entity.id];
        if (!liveEntity || liveEntity.isValid === false) return;

        const name = entityName(liveEntity);
        if (name === 'creeper') {
            await retreatFromThreat(bot, liveEntity, 4);
            return;
        }

        const distance = liveEntity.position.distanceTo(bot.entity.position);
        if (distance > 12) return;
        if (
            distance > 3.1 &&
            (bot.health <= 8 || (armorScore(bot) === 0 && bot.health <= 16))
        ) {
            await retreatFromThreat(bot, liveEntity, 8, 14);
            return;
        }
        if (distance > 3.1) {
            const approached = await approachMeleeThreat(bot, liveEntity.position);
            approachFailures = approached ? 0 : approachFailures + 1;
            if (approachFailures >= 2) {
                throw new Error(`Could not reach ${name}; combat approach abandoned`);
            }
            continue;
        }
        await bot.lookAt(liveEntity.position.offset(0, 1.2, 0), true);
        entityActions.attack(bot, liveEntity);
        strikes++;
        console.log(`[SURVIVAL] melee strike=${strikes} distance=${distance.toFixed(1)}`);
        await backAway(bot, liveEntity.position, 1200);
        await movement.sleep(650);
    }

    const remaining = bot.entities[entity.id];
    if (remaining && remaining.isValid !== false) {
        throw new Error(`Combat target survived ${strikes} confirmed strike attempts`);
    }
}

async function fightCreeperSafely(bot, entity) {
    const actionVersion = actionControl.snapshot(bot);
    for (let strike = 0; strike < 8 && bot.health > 12; strike++) {
        actionControl.assertActive(bot, actionVersion);
        const live = bot.entities[entity.id];
        if (!live || live.isValid === false) {
            console.log('[SURVIVAL] creeper cleared');
            return;
        }
        let distance = live.position.distanceTo(bot.entity.position);
        if (distance < 3.25) {
            const escaped = await retreatFromThreat(bot, live, 6, 6);
            if (!escaped) throw new Error('Creeper retreat path blocked');
            await movement.sleep(700);
            continue;
        }
        if (distance > 3.8) {
            const approached = await approachMeleeThreat(bot, live.position);
            if (!approached) throw new Error('Could not reach creeper attack range');
            distance = live.position.distanceTo(bot.entity.position);
        }
        if (distance > 3.9) continue;
        await bot.lookAt(live.position.offset(0, 1.1, 0), true);
        entityActions.attack(bot, live);
        console.log(`[SURVIVAL] creeper strike=${strike + 1} distance=${distance.toFixed(1)}`);
        const retreated = await retreatFromThreat(bot, live, 8, 6.5);
        if (!retreated) throw new Error('Could not reset creeper fuse after strike');
        await movement.sleep(800);
    }
    const remaining = bot.entities[entity.id];
    if (remaining && remaining.isValid !== false) {
        await retreatFromThreat(bot, remaining, 10, 12);
        throw new Error('Creeper survived safe strike budget');
    }
}

async function approachMeleeThreat(bot, targetPosition) {
    const before = bot.entity.position.clone();
    try {
        await movement.moveNear(bot, targetPosition.floored(), 2.4, 4000);
    } catch (error) {
        movement.stop(bot);
        console.log(`[SURVIVAL] combat path fallback: ${error.message}`);
        await movement.moveTowardSafely(bot, targetPosition, 6);
    }
    movement.stop(bot);
    return horizontalDistance(before, bot.entity.position) >= 0.5 ||
        bot.entity.position.distanceTo(targetPosition) <= 3.1;
}

function isFrontObstacle(bot) {
    const yaw = bot.entity.yaw;
    const dx = Math.round(-Math.sin(yaw));
    const dz = Math.round(-Math.cos(yaw));
    const feet = bot.entity.position.floored().offset(dx, 0, dz);
    return bot.blockAt(feet)?.boundingBox === 'block';
}

async function fightUnarmedDefensively(bot, entity) {
    const actionVersion = actionControl.snapshot(bot);
    console.log(`[SURVIVAL] defensive unarmed combat against ${entityName(entity)}`);

    for (let strike = 0; strike < 24 && bot.health > 0; strike++) {
        actionControl.assertActive(bot, actionVersion);
        const liveEntity = bot.entities[entity.id];
        if (!liveEntity || liveEntity.isValid === false) {
            console.log('[SURVIVAL] unarmed threat cleared');
            return;
        }

        const distance = liveEntity.position.distanceTo(bot.entity.position);
        if (bot.health <= 8 || nearbyHostileCount(bot, 8) > 1) {
            if (await retreatFromThreat(bot, liveEntity, 10, 14)) return;
        }
        if (distance > 7) return;
        if (distance > 3.25) {
            await movement.sleep(180);
            continue;
        }

        await bot.lookAt(liveEntity.position.offset(0, 1.1, 0), true);
        entityActions.attack(bot, liveEntity);
        await movement.sleep(180);
        await backAway(bot, liveEntity.position, 950);
        await movement.sleep(300);
    }
}

async function evadeHostile(bot, entityId) {
    const entity = bot.entities[entityId] || nearestHostile(bot, 12)?.entity;
    if (!entity) return;
    console.log(`[SURVIVAL] evading ${entityName(entity)}`);
    const actionVersion = actionControl.snapshot(bot);
    const deadline = Date.now() + 25000;
    const origin = bot.entity.position.clone();
    const startingHealth = bot.health;

    try {
        for (let attempt = 0; attempt < 10 && bot.health > 0 && Date.now() < deadline; attempt++) {
            actionControl.assertActive(bot, actionVersion);
            const liveEntity = bot.entities[entity.id];
            if (!liveEntity || liveEntity.isValid === false) return;
            const distance = liveEntity.position.distanceTo(bot.entity.position);
            if (distance >= 16) return;

            if (distance <= 6) {
                if (distance <= 3.2 && MELEE_HOSTILES.has(entityName(liveEntity)) && bot.health > 6) {
                    await bot.lookAt(liveEntity.position.offset(0, 1.1, 0), true);
                    entityActions.attack(bot, liveEntity);
                    await movement.sleep(250);
                }
                const before = bot.entity.position.clone();
                await backAway(bot, liveEntity.position, 650);
                if (
                    liveEntity.position.distanceTo(bot.entity.position) <= 3.2 &&
                    horizontalDistance(before, bot.entity.position) < 0.35
                ) {
                    await bot.lookAt(liveEntity.position.offset(0, 1.1, 0), true);
                    entityActions.attack(bot, liveEntity);
                    await movement.sleep(250);
                }
                continue;
            }

            const target = findSafeRetreatPosition(bot, liveEntity.position);
            if (target) {
                try {
                    await movement.moveNear(bot, target, 1, 3000);
                    continue;
                } catch {
                    movement.stop(bot);
                }
            }
            await backAway(bot, liveEntity.position, 650);
        }
    } finally {
        movement.stop(bot);
        const liveEntity = bot.entities[entity.id];
        if (liveEntity?.position && liveEntity.isValid !== false) {
            const ranged = ['skeleton', 'stray', 'witch'].includes(entityName(liveEntity));
            const distance = liveEntity.position.distanceTo(bot.entity.position);
            const moved = bot.entity.position.distanceTo(origin);
            const tookDamage = bot.health < startingHealth - 0.01;
            const visible = hasEntityLineOfSight(bot, liveEntity);
            if (
                ranged && distance <= 5 && moved < 1.2 &&
                hasCombatWeapon(bot) && bot.health > 10
            ) {
                corneredRangedHostiles.set(entity.id, Date.now() + 15000);
                console.log('[SURVIVAL] retreat is blocked; allow a close ranged counterattack');
            }
            if (
                ranged && distance < 16 && moved < 1.2 && visible &&
                preferredRecoveryBlock(bot) && !isEmergencyShelter(bot)
            ) {
                console.log(`[SURVIVAL] ranged retreat stalled; placing immediate cover`);
                const covered = await buildImmediateRangedCover(bot, liveEntity);
                if (covered) {
                    await waitSafe(bot, 1500);
                    if (!tookDamage && distance > 7) {
                        temporarilyIgnoredHostiles.set(entity.id, Date.now() + 15000);
                        console.log(
                            `[SURVIVAL] ranged cover holds; resuming recovery for 15s ` +
                            `(distance=${distance.toFixed(1)})`
                        );
                    }
                }
            } else if (
                !ranged && distance < 16 && moved < 0.8 &&
                !tookDamage && (!visible || distance > 4)
            ) {
                temporarilyIgnoredHostiles.set(entity.id, Date.now() + 20000);
                console.log(
                    `[SURVIVAL] ${entityName(liveEntity)} is unreachable; ignoring it for 20s ` +
                    `(distance=${distance.toFixed(1)} moved=${moved.toFixed(1)})`
                );
            }
        }
    }
    console.log('[SURVIVAL] evade window ended; returning control to the planner');
}

async function buildImmediateRangedCover(bot, entity) {
    if (!entity?.position || !bot.entity?.position) return false;
    movement.stop(bot);
    const origin = bot.entity.position.floored();
    const deltaX = entity.position.x - bot.entity.position.x;
    const deltaZ = entity.position.z - bot.entity.position.z;
    const dx = Math.abs(deltaX) >= Math.abs(deltaZ) ? Math.sign(deltaX) : 0;
    const dz = dx === 0 ? Math.sign(deltaZ) : 0;
    if (dx === 0 && dz === 0) return false;

    const lower = origin.offset(dx, 0, dz);
    let placed = 0;
    for (const position of [lower, lower.offset(0, 1, 0)]) {
        if (bot.blockAt(position)?.boundingBox === 'block') {
            placed++;
            continue;
        }
        const item = preferredSurfaceWallBlock(bot);
        const reference = findPlacementReference(bot, position);
        if (!item || !reference) break;
        try {
            await bot.equip(item, 'hand');
            await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
            await placeEmergencyBlockTolerant(bot, reference, position, item.name);
            if (bot.blockAt(position)?.boundingBox === 'block') placed++;
        } catch (error) {
            console.log(`[SURVIVAL] immediate cover placement failed: ${error.message}`);
            break;
        }
    }
    if (placed >= 2) {
        console.log(`[SURVIVAL] immediate ranged cover ready at ${lower.toString()}`);
        return true;
    }
    return false;
}

async function emergencyCreeperDodge(bot, entity) {
    if (!entity?.position || entity.isValid === false) return false;
    console.log('[SURVIVAL] immediate creeper dodge');
    await backAway(bot, entity.position, 1300);
    return entity.isValid === false || entity.position.distanceTo(bot.entity.position) >= 8;
}

function needsAir(bot) {
    if (!bot.entity) return false;
    const feet = bot.entity.position.floored();
    const head = bot.blockAt(feet.offset(0, 1, 0));
    const headSubmerged = ['water', 'bubble_column'].includes(head?.name);
    const oxygenFalling = Number.isFinite(bot.oxygenLevel) && bot.oxygenLevel < 20;
    return Boolean(bot.entity.isInWater && (headSubmerged || oxygenFalling));
}

function shouldInterruptForWater(bot, activeToolName = null) {
    if (activeToolName === 'escape_water') return false;
    return needsAir(bot) || Boolean(bot.entity?.isInWater);
}

async function escapeWater(bot) {
    movement.resyncCollision(bot);
    const actionVersion = actionControl.snapshot(bot);
    let shore = null;
    let deadline = Date.now() + 14000;
    movement.stop(bot);
    console.log(
        `[SURVIVAL] escaping water oxygen=${bot.oxygenLevel ?? 'unknown'} ` +
        `position=${bot.entity.position.floored().toString()}`
    );

    try {
        if (!await surfaceFromDepth(bot, actionVersion)) {
            console.log('[SURVIVAL] vertical water ascent stalled; deferring shoreline navigation');
            return;
        }
        await releaseWaterWallContact(bot, actionVersion);

        shore = findNearestDryStand(bot, 16);
        if (shore && bot.entity.isInWater) {
            const cell = bot.entity.position.floored();
            const centered = new Vec3(cell.x + 0.5, bot.entity.position.y, cell.z + 0.5);
            await swimHorizontalSegment(bot, centered, 1400, actionVersion, 0.12);
            shore = findNearestDryStand(bot, 16) || shore;
        }
        if (shore) logWaterExitGeometry(bot, shore);
        if (shore && await wadeToDryStand(bot, shore, actionVersion)) {
            console.log(`[SURVIVAL] shallow-water exit complete at ${bot.entity.position.floored().toString()}`);
            return;
        }
        if (shore) {
            try {
                console.log(`[SURVIVAL] pathfinding water exit ${shore.toString()}`);
                await movement.moveOutOfWater(bot, shore, 7000);
                actionControl.assertActive(bot, actionVersion);
                if (isStableDryStand(bot)) {
                    console.log(`[SURVIVAL] pathfinder water exit complete at ${bot.entity.position.floored().toString()}`);
                    return;
                }
            } catch (error) {
                movement.stop(bot);
                console.log(`[SURVIVAL] water path fallback: ${error.message}`);
            }
            if (await climbExistingWaterStep(bot, shore, actionVersion) && isStableDryStand(bot)) return;
            if (await buildWaterEscapeStep(bot, shore) && isStableDryStand(bot)) return;
        }
        const openedBank = !shore && await clearWaterCollisionFace(bot, actionVersion);
        if (openedBank) {
            await enterClearedWaterBank(bot, openedBank, actionVersion);
            if (isStableDryStand(bot)) return;
            const newShore = findNearestDryStand(bot, 8);
            if (newShore && await wadeToDryStand(bot, newShore, actionVersion, 3500)) return;
        }
        await releaseWaterWallContact(bot, actionVersion);
        deadline = Date.now() + 14000;
        shore = findNearestDryStand(bot, 16) || shore;
        if (shore) {
            if (await climbAlignedShoreFace(bot, shore, actionVersion)) {
                console.log(`[SURVIVAL] aligned water exit complete at ${bot.entity.position.floored().toString()}`);
                return;
            }
            if (await createDryWaterPocket(bot, shore, actionVersion)) return;
        }
        let shoreApproachStartedAt = Date.now();
        let shoreApproachOrigin = bot.entity.position.clone();
        let redirectedShore = false;
        let drySince = null;
        if (shore) await beginSwimToward(bot, shore);
        const knownLand = !shore ? rememberedDryDirection(bot) : null;
        if (knownLand) {
            console.log(`[SURVIVAL] no nearby shore; swimming toward known land ${knownLand.toString()}`);
            await beginSwimToward(bot, knownLand);
        }

        while (Date.now() < deadline && bot.health > 0) {
            actionControl.assertActive(bot, actionVersion);
            const dry = isStableDryStand(bot);
            drySince = dry ? (drySince || Date.now()) : null;
            const reachedShore = drySince && Date.now() - drySince >= 500 && (
                !shore || horizontalDistance(bot.entity.position, shore) <= 2.5
            );
            if (reachedShore) {
                console.log(
                    `[SURVIVAL] water escape complete oxygen=${bot.oxygenLevel ?? 'unknown'} ` +
                    `position=${bot.entity.position.floored().toString()}`
                );
                return;
            }
            if (
                shore &&
                !redirectedShore &&
                Date.now() - shoreApproachStartedAt >= 1800 &&
                horizontalDistance(bot.entity.position, shoreApproachOrigin) < 0.35
            ) {
                bot.clearControlStates();
                const alternate = findDryStandCandidates(bot, 16)
                    .find(candidate => !candidate.equals(shore));
                redirectedShore = true;
                if (alternate) {
                    shore = alternate;
                    shoreApproachOrigin = bot.entity.position.clone();
                    shoreApproachStartedAt = Date.now();
                    await beginSwimToward(bot, shore);
                }
            }
            await movement.sleep(100);
        }
    } finally {
        bot.clearControlStates();
        movement.stop(bot);
    }

    if (bot.entity.isInWater) {
        if (shore) {
            const climbedStep = await climbExistingWaterStep(bot, shore, actionVersion);
            if (climbedStep && isStableDryStand(bot)) return;
            const steppedOut = await buildWaterEscapeStep(bot, shore);
            if (steppedOut && isStableDryStand(bot)) return;
            const alternatives = findDryStandCandidates(bot, 16)
                .filter(candidate => !candidate.equals(shore))
                .slice(0, 4);
            for (const candidate of [shore, ...alternatives]) {
                console.log(`[SURVIVAL] trying direct water exit ${candidate.toString()}`);
                if (await swimToDryStand(bot, candidate, 2600, actionVersion)) return;
            }
        }
        const rememberedExit = memory.getSurfaceExit() || memory.getBase();
        if (rememberedExit && rememberedExit.y > bot.entity.position.y + 0.5) {
            console.log('[SURVIVAL] horizontal water escape stalled; opening a vertical exit');
            const exit = new Vec3(
                Math.floor(bot.entity.position.x),
                rememberedExit.y,
                Math.floor(bot.entity.position.z)
            );
            await climbEmergencyShaft(bot, exit, actionVersion);
        }
    }
}

async function surfaceFromDepth(bot, actionVersion, timeoutMs = 10000) {
    if (!bot.entity.isInWater) return true;
    const startY = bot.entity.position.y;
    const stalledAscentAt = Date.now() + 1200;
    const deathEpoch = Number(bot.sorimDeathEpoch || 0);
    const minimumPulseUntil = Date.now() + 1600;
    const deadline = Date.now() + timeoutMs;
    console.log(`[SURVIVAL] surfacing before navigation y=${startY.toFixed(2)}`);
    bot.clearControlStates();
    try {
        while (
            Date.now() < deadline &&
            bot.entity.isInWater &&
            (needsAir(bot) || Date.now() < minimumPulseUntil) &&
            bot.health > 0
        ) {
            actionControl.assertActive(bot, actionVersion);
            const verticalStalled = Date.now() >= stalledAscentAt &&
                bot.entity.position.y < startY + 0.3;
            const escapeHeading = verticalStalled ? rememberedDryDirection(bot) : null;
            if (escapeHeading) {
                const dx = escapeHeading.x - bot.entity.position.x;
                const dz = escapeHeading.z - bot.entity.position.z;
                await bot.look(Math.atan2(-dx, -dz), -1.1, true);
            } else {
                await bot.look(bot.entity.yaw, -Math.PI / 2 + 0.08, true);
            }
            bot.setControlState('jump', true);
            // Jump alone is preferred in open water. If it produces no rise,
            // forward+up clears overhangs that trap the body below a bank.
            bot.setControlState('forward', Boolean(escapeHeading));
            bot.setControlState('sprint', false);
            await movement.sleep(100);
        }
    } finally {
        bot.clearControlStates();
    }
    const survivedAttempt = bot.health > 0 && Number(bot.sorimDeathEpoch || 0) === deathEpoch;
    const surfaced = survivedAttempt && (
        !needsAir(bot) || bot.entity.position.y >= startY + 0.6
    );
    console.log(
        `[SURVIVAL] vertical ascent surfaced=${surfaced} ` +
        `y=${bot.entity.position.y.toFixed(2)} delta=${(bot.entity.position.y - startY).toFixed(2)}`
    );
    return surfaced;
}

async function wadeToDryStand(bot, shore, actionVersion, timeoutMs = 6500) {
    if (needsAir(bot)) return false;
    const started = bot.entity.position.clone();
    let progressAnchor = started.clone();
    let lastProgressAt = Date.now();
    const deadline = Date.now() + timeoutMs;
    console.log(`[SURVIVAL] wading toward shore ${shore.toString()}`);
    bot.clearControlStates();
    try {
        while (Date.now() < deadline && bot.health > 0) {
            actionControl.assertActive(bot, actionVersion);
            if (isStableDryStand(bot)) return true;
            await bot.lookAt(shore.offset(0.5, 0.8, 0.5), true);
            bot.setControlState('forward', true);
            bot.setControlState('sprint', false);
            const obstacle = movement.frontObstacle(bot, shore);
            const nearBank = horizontalDistance(bot.entity.position, shore) <= 1.8;
            // Keep upward swimming pressure all the way to shore. Releasing
            // jump at the surface makes the bot sink before it reaches a bank.
            bot.setControlState('jump', Boolean(bot.entity.isInWater) || (nearBank && obstacle === 'step'));
            if (horizontalDistance(progressAnchor, bot.entity.position) >= 0.3) {
                progressAnchor = bot.entity.position.clone();
                lastProgressAt = Date.now();
            } else if (Date.now() - lastProgressAt >= 1400) {
                break;
            }
            await movement.sleep(100);
        }
    } finally {
        bot.clearControlStates();
    }
    if (horizontalDistance(bot.entity.position, shore) <= 2.1) {
        await movement.stepUpToward(bot, shore);
        if (isStableDryStand(bot)) return true;
    }
    console.log(
        `[SURVIVAL] shallow-water wade moved=` +
        `${horizontalDistance(started, bot.entity.position).toFixed(2)}`
    );
    return isStableDryStand(bot);
}

async function clearWaterCollisionFace(bot, actionVersion) {
    const position = bot.entity.position;
    const origin = position.floored();
    const fractionX = position.x - origin.x;
    const fractionZ = position.z - origin.z;
    const contacts = [];
    if (fractionX <= 0.32) contacts.push(new Vec3(-1, 0, 0));
    if (fractionX >= 0.68) contacts.push(new Vec3(1, 0, 0));
    if (fractionZ <= 0.32) contacts.push(new Vec3(0, 0, -1));
    if (fractionZ >= 0.68) contacts.push(new Vec3(0, 0, 1));

    let cleared = null;
    for (const direction of contacts) {
        const block = bot.blockAt(origin.plus(direction));
        if (
            block?.boundingBox !== 'block' ||
            !bot.canDigBlock(block) ||
            !blockPolicy.canBreak(bot, block, 'terrain_recovery').allowed
        ) continue;
        actionControl.assertActive(bot, actionVersion);
        console.log(`[SURVIVAL] clearing water collision face ${block.name} ${block.position.toString()}`);
        try {
            await mine.clearBlock(bot, block);
            await movement.sleep(350);
            cleared = block.position.clone();
        } catch (error) {
            console.log(`[SURVIVAL] collision face could not be cleared: ${error.message}`);
        }
    }
    return cleared;
}

async function enterClearedWaterBank(bot, position, actionVersion) {
    const target = position.offset(0.5, 0.1, 0.5);
    const before = bot.entity.position.clone();
    const deadline = Date.now() + 2200;
    console.log(`[SURVIVAL] entering cleared water bank ${position.toString()}`);
    bot.clearControlStates();
    try {
        while (Date.now() < deadline && horizontalDistance(bot.entity.position, target) > 0.35) {
            actionControl.assertActive(bot, actionVersion);
            await bot.lookAt(target.offset(0, 0.7, 0), true);
            bot.setControlState('forward', true);
            bot.setControlState('jump', false);
            bot.setControlState('sprint', false);
            await movement.sleep(100);
        }
    } finally {
        bot.clearControlStates();
    }
    const moved = horizontalDistance(before, bot.entity.position);
    console.log(`[SURVIVAL] cleared-bank entry moved=${moved.toFixed(2)}`);
    return moved >= 0.35;
}

async function releaseWaterWallContact(bot, actionVersion) {
    const origin = bot.entity.position.floored();
    const directions = [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ];
    const candidates = directions
        .map(direction => {
            const position = origin.plus(direction);
            const feet = bot.blockAt(position);
            const head = bot.blockAt(position.offset(0, 1, 0));
            const floor = bot.blockAt(position.offset(0, -1, 0));
            if (
                !['water', 'bubble_column'].includes(feet?.name) ||
                !isPassable(head) ||
                floor?.boundingBox !== 'block'
            ) return null;
            const solidNeighbors = directions.filter(offset =>
                bot.blockAt(position.plus(offset))?.boundingBox === 'block'
            ).length;
            return { position, solidNeighbors };
        })
        .filter(Boolean)
        .sort((left, right) => left.solidNeighbors - right.solidNeighbors);
    if (!candidates.length) return false;

    const target = candidates[0].position.offset(0.5, 0.15, 0.5);
    const before = bot.entity.position.clone();
    actionControl.assertActive(bot, actionVersion);
    bot.clearControlStates();
    console.log(`[SURVIVAL] releasing water wall contact toward ${candidates[0].position.toString()}`);
    try {
        await bot.lookAt(target.offset(0, 0.7, 0), true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', false);
        await movement.sleep(1100);
    } finally {
        bot.clearControlStates();
    }
    const moved = horizontalDistance(before, bot.entity.position);
    console.log(`[SURVIVAL] water wall release moved=${moved.toFixed(2)}`);
    return moved >= 0.35;
}

async function climbExistingWaterStep(bot, shore, actionVersion) {
    const origin = bot.entity.position.floored();
    const directions = [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ].sort((left, right) => {
        const leftDistance = horizontalDistance(origin.plus(left), shore);
        const rightDistance = horizontalDistance(origin.plus(right), shore);
        return leftDistance - rightDistance;
    });

    for (const direction of directions) {
        const floorPosition = origin.plus(direction);
        const floor = bot.blockAt(floorPosition);
        const stand = floorPosition.offset(0, 1, 0);
        if (
            floor?.boundingBox !== 'block' ||
            !isPassable(bot.blockAt(stand)) ||
            !isPassable(bot.blockAt(stand.offset(0, 1, 0)))
        ) continue;

        actionControl.assertActive(bot, actionVersion);
        console.log(`[SURVIVAL] climbing existing water step ${floorPosition.toString()}`);
        if (await movement.stepUpToward(bot, stand)) return true;
    }
    return false;
}

async function createDryWaterPocket(bot, shore, actionVersion) {
    const item = preferredRecoveryBlock(bot);
    const approach = findWaterApproachCell(bot, shore);
    if (!item || !approach) {
        console.log(`[SURVIVAL] dry pocket unavailable item=${item?.name || 'none'} approach=${approach?.toString() || 'none'}`);
        return false;
    }
    const bank = shore.offset(0, -1, 0);
    const dx = bank.x - approach.x;
    const dz = bank.z - approach.z;
    if (Math.abs(dx) + Math.abs(dz) !== 1) {
        console.log(`[SURVIVAL] dry pocket rejected non-cardinal approach=${approach.toString()} bank=${bank.toString()}`);
        return false;
    }
    const backSeal = bank.offset(dx, 0, dz);
    const bankBlock = bot.blockAt(bank);
    const backBlock = bot.blockAt(backSeal);
    if (['water', 'bubble_column'].includes(backBlock?.name)) {
        const floor = bot.blockAt(backSeal.offset(0, -1, 0));
        const reference = floor?.boundingBox === 'block'
            ? { block: floor, face: new Vec3(0, 1, 0) }
            : (bankBlock?.boundingBox === 'block'
                ? { block: bankBlock, face: new Vec3(dx, 0, dz) }
                : null);
        if (!reference) return false;
        try {
            actionControl.assertActive(bot, actionVersion);
            await bot.equip(item, 'hand');
            await bot.lookAt(backSeal.offset(0.5, 0.5, 0.5), true);
            await craft.placeAtTolerant(
                bot,
                item,
                reference,
                backSeal
            );
        } catch (error) {
            console.log(`[SURVIVAL] rear water seal unavailable: ${error.message}`);
            return false;
        }
    }

    if (!bankBlock || bankBlock.boundingBox !== 'block' || !bot.canDigBlock(bankBlock)) {
        console.log(
            `[SURVIVAL] dry pocket bank rejected block=${bankBlock?.name || 'none'} ` +
            `box=${bankBlock?.boundingBox || 'none'} canDig=${Boolean(bankBlock && bot.canDigBlock(bankBlock))}`
        );
        return false;
    }
    try {
        console.log(`[SURVIVAL] creating dry water pocket at ${bank.toString()}`);
        await mine.clearBlock(bot, bankBlock);
        const entered = await swimHorizontalSegment(
            bot,
            bank.offset(0.5, 0, 0.5),
            2200,
            actionVersion,
            0.22
        );
        if (!entered) return false;

        const frontFloor = bot.blockAt(approach.offset(0, -1, 0));
        const freshItem = preferredRecoveryBlock(bot);
        if (!freshItem || frontFloor?.boundingBox !== 'block') return false;
        await bot.equip(freshItem, 'hand');
        await bot.lookAt(approach.offset(0.5, 0.5, 0.5), true);
        await craft.placeAtTolerant(
            bot,
            freshItem,
            { block: frontFloor, face: new Vec3(0, 1, 0) },
            approach
        );
        await movement.sleep(1800);
        if (!bot.entity.isInWater) {
            console.log(`[SURVIVAL] dry water pocket complete ${bank.toString()}`);
            return true;
        }
    } catch (error) {
        console.log(`[SURVIVAL] dry water pocket failed: ${error.message}`);
    } finally {
        bot.clearControlStates();
    }
    return false;
}

async function climbAlignedShoreFace(bot, shore, actionVersion) {
    const approach = findWaterApproachCell(bot, shore);
    if (!approach) return false;
    const approachCenter = approach.offset(0.5, 0, 0.5);
    const shoreCenter = shore.offset(0.5, 0, 0.5);
    const bankDx = Math.sign(shoreCenter.x - approachCenter.x);
    const bankDz = Math.sign(shoreCenter.z - approachCenter.z);
    bot.clearControlStates();
    try {
        const backOff = new Vec3(
            bot.entity.position.x - bankDx * 0.45,
            bot.entity.position.y,
            bot.entity.position.z - bankDz * 0.45
        );
        await swimHorizontalSegment(bot, backOff, 650, actionVersion, 0.16);

        const parallel = Math.abs(bankDx) > 0
            ? new Vec3(bot.entity.position.x, bot.entity.position.y, approachCenter.z)
            : new Vec3(approachCenter.x, bot.entity.position.y, bot.entity.position.z);
        const aligned = await swimHorizontalSegment(bot, parallel, 1000, actionVersion, 0.14);
        if (!aligned) return false;

        bot.clearControlStates();
        const dx = shoreCenter.x - bot.entity.position.x;
        const dz = shoreCenter.z - bot.entity.position.z;
        await bot.look(Math.atan2(-dx, -dz), 0.65, true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        bot.setControlState('sprint', true);
        const climbDeadline = Date.now() + 2200;
        while (Date.now() < climbDeadline) {
            actionControl.assertActive(bot, actionVersion);
            if (isStableDryStand(bot)) return true;
            await movement.sleep(50);
        }
    } finally {
        bot.clearControlStates();
    }
    return isStableDryStand(bot);
}

async function swimHorizontalSegment(bot, target, timeoutMs, actionVersion, range) {
    const deadline = Date.now() + timeoutMs;
    bot.clearControlStates();
    while (Date.now() < deadline) {
        actionControl.assertActive(bot, actionVersion);
        const dx = target.x - bot.entity.position.x;
        const dz = target.z - bot.entity.position.z;
        if (Math.hypot(dx, dz) <= range) {
            bot.clearControlStates();
            return true;
        }
        await bot.look(Math.atan2(-dx, -dz), 0, true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        await movement.sleep(50);
    }
    bot.clearControlStates();
    return horizontalDistance(bot.entity.position, target) <= range + 0.08;
}

function findWaterApproachCell(bot, shore) {
    const candidates = [];
    for (const direction of [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ]) {
        for (const yOffset of [0, -1]) {
            const position = shore.plus(direction).offset(0, yOffset, 0);
            if (!['water', 'bubble_column'].includes(bot.blockAt(position)?.name)) continue;
            candidates.push(position);
        }
    }
    candidates.sort((left, right) =>
        horizontalDistance(left.offset(0.5, 0, 0.5), bot.entity.position) -
        horizontalDistance(right.offset(0.5, 0, 0.5), bot.entity.position)
    );
    return candidates[0] || null;
}

async function beginSwimToward(bot, shore) {
    await bot.lookAt(shore.offset(0.5, 0.9, 0.5), true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', false);
    bot.setControlState('jump', true);
}

function rememberedDryDirection(bot) {
    const remembered = memory.getBase() || memory.getConstructionBase() || memory.getSurfaceExit();
    if (!remembered) return null;
    const origin = bot.entity.position;
    const dx = remembered.x + 0.5 - origin.x;
    const dz = remembered.z + 0.5 - origin.z;
    const length = Math.hypot(dx, dz);
    if (length < 1) return null;
    const distance = Math.min(32, length);
    return new Vec3(
        origin.x + dx / length * distance,
        origin.y,
        origin.z + dz / length * distance
    );
}

async function swimToDryStand(bot, shore, timeoutMs, actionVersion) {
    const start = bot.entity.position.clone();
    const deadline = Date.now() + timeoutMs;
    try {
        await beginSwimToward(bot, shore);
        while (Date.now() < deadline && bot.health > 0) {
            actionControl.assertActive(bot, actionVersion);
            if (isStableDryStand(bot)) return true;
            if (horizontalDistance(bot.entity.position, shore) <= 1.1) {
                await bot.lookAt(shore.offset(0.5, 1.4, 0.5), true);
            }
            if (
                Date.now() + 900 >= deadline &&
                horizontalDistance(bot.entity.position, start) < 0.25
            ) break;
            await movement.sleep(100);
        }
    } finally {
        bot.clearControlStates();
    }
    return isStableDryStand(bot);
}

async function buildWaterEscapeStep(bot, shore) {
    const origin = bot.entity.position.floored();
    const targetFloor = [
        origin.offset(1, 0, 0), origin.offset(-1, 0, 0),
        origin.offset(0, 0, 1), origin.offset(0, 0, -1)
    ]
        .filter(position => {
            const water = bot.blockAt(position);
            const support = bot.blockAt(position.offset(0, -1, 0));
            return ['water', 'bubble_column'].includes(water?.name) &&
                support?.boundingBox === 'block' &&
                isPassable(bot.blockAt(position.offset(0, 1, 0))) &&
                isPassable(bot.blockAt(position.offset(0, 2, 0)));
        })
        .sort((left, right) =>
            horizontalDistance(left, shore) - horizontalDistance(right, shore)
        )[0];
    if (!targetFloor) return false;
    const targetBlock = bot.blockAt(targetFloor);
    const reference = bot.blockAt(targetFloor.offset(0, -1, 0));
    const stand = targetFloor.offset(0, 1, 0);
    const head = bot.blockAt(stand.offset(0, 1, 0));
    const item = preferredRecoveryBlock(bot);
    if (
        !item ||
        !['water', 'bubble_column'].includes(targetBlock?.name) ||
        reference?.boundingBox !== 'block' ||
        !isPassable(bot.blockAt(stand)) ||
        !isPassable(head)
    ) return false;

    try {
        console.log(`[SURVIVAL] placing water escape step ${targetFloor.toString()}`);
        await craft.placeAtTolerant(
            bot,
            item,
            { block: reference, face: new Vec3(0, 1, 0) },
            targetFloor
        );
        await movement.sleep(250);
        try {
            await movement.moveBlock(bot, stand, 4000);
        } catch {
            movement.stop(bot);
            await bot.lookAt(stand.offset(0.5, 1.2, 0.5), true);
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            await movement.sleep(1400);
            movement.stop(bot);
        }
        return bot.entity.position.y >= stand.y - 0.2;
    } catch (error) {
        movement.stop(bot);
        console.log(`[SURVIVAL] water escape step unavailable: ${error.message}`);
        return false;
    }
}

function isStableDryStand(bot) {
    const feet = bot.entity.position.floored();
    const feetBlock = bot.blockAt(feet);
    const head = bot.blockAt(feet.offset(0, 1, 0));
    const floor = bot.blockAt(feet.offset(0, -1, 0));
    const dryFloor = floor?.boundingBox === 'block' &&
        !['water', 'lava', 'magma_block'].includes(floor.name);
    const settled = bot.entity.onGround || Math.abs(bot.entity.velocity?.y || 0) < 0.05;
    return !bot.entity.isInWater && isAir(feetBlock) && isAir(head) && dryFloor && settled;
}

function lacksStableFloor(bot) {
    if (
        !bot.entity || bot.entity.onGround !== true || bot.entity.isInWater ||
        Math.abs(bot.entity.velocity?.y || 0) > 0.08
    ) {
        return false;
    }
    const feet = bot.entity.position.floored();
    const current = bot.blockAt(feet);
    const floor = bot.blockAt(feet.offset(0, -1, 0));
    if (floor?.boundingBox === 'block') return false;
    if (current?.boundingBox !== 'block') return true;
    const shapeTop = highestCollisionTop(current);
    const localY = bot.entity.position.y - feet.y;
    return shapeTop <= 0 || localY < shapeTop - 0.08;
}

async function carveWaterlineExit(bot, shore) {
    if (shore.y <= bot.entity.position.y + 0.45) return null;
    const origin = bot.entity.position.floored();
    const target = shore.offset(0, -1, 0);
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const steps = Math.max(1, Math.max(Math.abs(dx), Math.abs(dz)));
    let lowerStand = target.distanceTo(bot.entity.position) <= 4.5 ? target : null;
    if (!lowerStand) {
        for (let step = 1; step <= steps; step++) {
            const cell = new Vec3(
                origin.x + Math.round(dx * step / steps),
                origin.y,
                origin.z + Math.round(dz * step / steps)
            );
            if (bot.blockAt(cell)?.boundingBox === 'block') {
                lowerStand = cell;
                break;
            }
        }
    }
    if (!lowerStand) return null;
    const bank = bot.blockAt(lowerStand);
    const head = bot.blockAt(lowerStand.offset(0, 1, 0));
    const floor = bot.blockAt(lowerStand.offset(0, -1, 0));
    const naturalBank = new Set([
        'dirt', 'grass_block', 'sand', 'red_sand', 'gravel', 'clay',
        'stone', 'andesite', 'diorite', 'granite'
    ]);
    if (
        !bank ||
        !naturalBank.has(bank.name) ||
        !isAir(head) ||
        floor?.boundingBox !== 'block' ||
        !bot.canDigBlock(bank) ||
        !blockPolicy.canBreak(bot, bank, 'terrain_recovery').allowed
    ) return null;

    console.log(`[SURVIVAL] opening waterline exit ${bank.position.toString()}`);
    await bot.lookAt(bank.position.offset(0.5, 0.5, 0.5), true);
    await movement.withTimeout(bot.dig(bank), 12000, 'Timed out opening waterline exit');
    await movement.sleep(400);
    return isPassable(bot.blockAt(lowerStand)) ? lowerStand : null;
}

function findNearestDryStand(bot, radius) {
    return findDryStandCandidates(bot, radius)[0] || null;
}

function logWaterExitGeometry(bot, shore) {
    const origin = bot.entity.position.floored();
    const cells = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const column = [];
            for (let dy = -1; dy <= 2; dy++) {
                const position = origin.offset(dx, dy, dz);
                column.push(`${position.y}:${bot.blockAt(position)?.name || 'unknown'}`);
            }
            cells.push(`${origin.x + dx},${origin.z + dz}=[${column.join('|')}]`);
        }
    }
    console.log(
        `[SURVIVAL] water geometry pos=${bot.entity.position.toString()} shore=${shore.toString()} ` +
        cells.join(' ')
    );
}

function findDryStandCandidates(bot, radius) {
    const origin = bot.entity.position.floored();
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            if (Math.hypot(dx, dz) < 1 || Math.hypot(dx, dz) > radius) continue;
            for (let dy = -2; dy <= 4; dy++) {
                const position = origin.offset(dx, dy, dz);
                const feet = bot.blockAt(position);
                const head = bot.blockAt(position.offset(0, 1, 0));
                const floor = bot.blockAt(position.offset(0, -1, 0));
                if (!isAir(feet) || !isAir(head) || floor?.boundingBox !== 'block') continue;
                if (['water', 'lava', 'magma_block'].includes(floor.name)) continue;
                if (Math.abs(position.y - origin.y) > 1) continue;
                if (!hasWaterApproach(bot, position)) continue;
                candidates.push(position);
            }
        }
    }
    return candidates.sort((left, right) => {
        const leftScore = horizontalDistance(left, origin) + Math.max(0, left.y - origin.y) * 12;
        const rightScore = horizontalDistance(right, origin) + Math.max(0, right.y - origin.y) * 12;
        return leftScore - rightScore;
    });
}

function hasWaterApproach(bot, stand) {
    return [
        new Vec3(1, 0, 0),
        new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1),
        new Vec3(0, 0, -1)
    ].some(direction => {
        const besideFeet = bot.blockAt(stand.plus(direction));
        const besideFloor = bot.blockAt(stand.offset(direction.x, -1, direction.z));
        return ['water', 'bubble_column'].includes(besideFeet?.name) ||
            ['water', 'bubble_column'].includes(besideFloor?.name);
    });
}

function hasCombatWeapon(bot) {
    const items = typeof bot.inventory?.items === 'function'
        ? bot.inventory.items()
        : (bot.inventory?.slots || []).filter(Boolean);
    return items.some(item => /_(sword|axe)$/.test(item.name));
}

function canFightUnarmed(bot, hostile, health = bot.health) {
    return Boolean(
        hostile &&
        ['zombie', 'zombie_villager', 'husk'].includes(hostile.name) &&
        hostile.distance <= 6 &&
        health >= 16 &&
        nearbyHostileCount(bot, 7) <= 1
    );
}

function nearbyHostileCount(bot, radius) {
    return Object.values(bot.entities || {})
        .filter(entity => isHostileEntity(entity, bot))
        .filter(entity => entity.position?.distanceTo(bot.entity.position) <= radius)
        .length;
}

function findSafeRetreatPosition(bot, threatPosition) {
    const origin = bot.entity.position.floored();
    const dx = origin.x - threatPosition.x;
    const dz = origin.z - threatPosition.z;
    const length = Math.hypot(dx, dz) || 1;
    const away = { x: dx / length, z: dz / length };
    const currentThreatDistance = bot.entity.position.distanceTo(threatPosition);
    const candidates = [];

    for (const angle of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
        const directionX = away.x * Math.cos(angle) - away.z * Math.sin(angle);
        const directionZ = away.x * Math.sin(angle) + away.z * Math.cos(angle);
        for (const distance of [12, 9, 6]) {
            for (const dy of [2, 1, 0, -1]) {
                const position = new Vec3(
                    Math.round(origin.x + directionX * distance),
                    origin.y + dy,
                    Math.round(origin.z + directionZ * distance)
                );
                const feet = bot.blockAt(position);
                const head = bot.blockAt(position.offset(0, 1, 0));
                const floor = bot.blockAt(position.offset(0, -1, 0));
                if (!isAir(feet) || !isAir(head) || floor?.boundingBox !== 'block') continue;
                const threatDistance = position.offset(0.5, 0, 0.5).distanceTo(threatPosition);
                if (threatDistance < currentThreatDistance + 4) continue;
                if (!hasSafeRetreatCorridor(bot, origin, position)) continue;
                candidates.push({ position, threatDistance });
            }
        }
    }

    return candidates.sort((left, right) => right.threatDistance - left.threatDistance)[0]?.position || null;
}

function hasSafeRetreatCorridor(bot, origin, target) {
    const distance = horizontalDistance(origin, target);
    const samples = Math.max(1, Math.ceil(distance));
    let previousY = origin.y;

    for (let index = 1; index <= samples; index++) {
        const progress = index / samples;
        const x = Math.round(origin.x + (target.x - origin.x) * progress);
        const z = Math.round(origin.z + (target.z - origin.z) * progress);
        const expectedY = Math.round(origin.y + (target.y - origin.y) * progress);
        const standY = findRetreatStandY(bot, x, z, expectedY);
        if (standY === null || previousY - standY > 1 || standY < origin.y - 1) return false;
        previousY = standY;
    }
    return true;
}

function findRetreatStandY(bot, x, z, expectedY) {
    for (const feetY of [expectedY, expectedY + 1, expectedY - 1]) {
        const feet = bot.blockAt(new Vec3(x, feetY, z));
        const head = bot.blockAt(new Vec3(x, feetY + 1, z));
        const floor = bot.blockAt(new Vec3(x, feetY - 1, z));
        if (!isAir(feet) || !isAir(head) || floor?.boundingBox !== 'block') continue;
        if (['water', 'lava', 'magma_block', 'powder_snow'].includes(floor.name)) continue;
        return feetY;
    }
    return null;
}

async function handleRangedThreat(bot, entity, weapon) {
    const hasShieldEquipped = hasShield(bot);
    const hasArmor = armorScore(bot) >= 2;
    const actionVersion = actionControl.snapshot(bot);
    const deadline = Date.now() + 30000;
    let strikes = 0;
    let stalledApproaches = 0;

    if (hasShieldEquipped) await equipShield(bot);

    while (bot.health > 0 && Date.now() < deadline && strikes < 12) {
        actionControl.assertActive(bot, actionVersion);
        const liveEntity = bot.entities[entity.id];
        if (!liveEntity || liveEntity.isValid === false) {
            console.log('[SURVIVAL] ranged threat cleared');
            return;
        }

        const distance = liveEntity.position.distanceTo(bot.entity.position);
        if (bot.health <= 14 && !hasShieldEquipped && distance > 5) {
            await retreatFromThreat(bot, liveEntity, 10, 15);
            return;
        }

        if (!weapon && !hasShieldEquipped && !hasArmor) {
            await retreatFromThreat(bot, liveEntity, 4);
            return;
        }

        if (!hasShieldEquipped && !hasArmor && distance > 5) {
            await retreatFromThreat(bot, liveEntity, 6, 14);
            return;
        }

        if (distance > 16) {
            console.log(`[SURVIVAL] ranged threat disengaged distance=${distance.toFixed(1)}`);
            return;
        }

        if (distance > 3.4) {
            const before = bot.entity.position.clone();
            await strafeApproach(bot, liveEntity.position);
            const moved = bot.entity.position.distanceTo(before);
            if (moved < 0.35) stalledApproaches++;
            else stalledApproaches = 0;

            if (stalledApproaches >= 2) {
                try {
                    await movement.moveNear(bot, liveEntity.position.floored(), 2, 4500);
                    stalledApproaches = 0;
                } catch (error) {
                    movement.stop(bot);
                    if (!isActionableThreat(bot, {
                        entity: liveEntity,
                        distance,
                        name: entityName(liveEntity)
                    })) {
                        console.log('[SURVIVAL] ranged threat is behind cover; resuming work');
                        return;
                    }
                    throw new Error(`Could not reach visible ranged threat: ${error.message}`);
                }
            }
            continue;
        }

        await bot.lookAt(liveEntity.position.offset(0, 1.25, 0), true);
        entityActions.attack(bot, liveEntity);
        strikes++;
        console.log(`[SURVIVAL] ranged target strike=${strikes} distance=${distance.toFixed(1)}`);
        await backAway(bot, liveEntity.position, 700);
        await movement.sleep(650);
    }

    const remaining = bot.entities[entity.id];
    if (
        remaining &&
        remaining.isValid !== false &&
        remaining.position.distanceTo(bot.entity.position) <= 16 &&
        isActionableThreat(bot, {
            entity: remaining,
            distance: remaining.position.distanceTo(bot.entity.position),
            name: entityName(remaining)
        })
    ) {
        throw new Error(`Ranged combat unresolved after ${strikes} strike attempts`);
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

function hasShield(bot) {
    return bot.inventory.items().some(item => item.name === 'shield');
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

async function retreatFromThreat(bot, entity, steps, safeDistance = 9) {
    const origin = bot.entity.position.clone();
    for (let i = 0; i < steps; i++) {
        const liveEntity = bot.entities[entity.id];
        await backAway(bot, liveEntity?.position || entity.position);
        if (!liveEntity || liveEntity.position.distanceTo(bot.entity.position) > safeDistance) return true;
    }
    return horizontalDistance(origin, bot.entity.position) >= 2;
}

async function escapePit(bot) {
    resyncSolidCollision(bot);
    const actionVersion = actionControl.snapshot(bot);
    const origin = bot.entity.position.floored();
    console.log(`[SURVIVAL] escaping pit ${origin.toString()}`);
    if (isEmergencyShelter(bot) && !isNight(bot)) {
        const rememberedSurface = memory.getSurfaceExit();
        const isShallowSurfaceRefuge = !rememberedSurface ||
            bot.entity.position.y >= rememberedSurface.y - 1.5;
        if (isShallowSurfaceRefuge) {
            await openSurfaceRefugeExit(bot, actionVersion);
            return;
        }
        emergencyShelterPosition = null;
        console.log(
            `[SURVIVAL] deep refuge detected; climbing toward surface y=${rememberedSurface.y}`
        );
    }
    await ensureEmergencyPickaxe(bot);
    actionControl.assertActive(bot, actionVersion);

    const rememberedSurface = memory.getSurfaceExit();
    const constructionBase = memory.getConstructionBase();
    if (
        rememberedSurface &&
        constructionBase &&
        bot.entity.position.y >= rememberedSurface.y - 0.1 &&
        bot.entity.position.y < constructionBase.y - 0.1 &&
        !hasSkyExposure(bot)
    ) {
        console.log(
            `[SURVIVAL] opening final construction-level staircase ` +
            `y=${bot.entity.position.y.toFixed(1)}->${constructionBase.y}`
        );
        if (await carveEscapeStaircase(bot, constructionBase, actionVersion)) return;
        if (await carveRunUpEscape(bot, constructionBase, actionVersion)) return;
        const climbed = await climbEmergencyShaft(bot, constructionBase, actionVersion);
        if (climbed) return;
    }

    const savedMineRoute = memory.getMineRoute();
    const routeRelevant = isMineRouteRelevant(bot.entity.position, savedMineRoute);
    const mineRoute = routeRelevant ? savedMineRoute : [];
    if (savedMineRoute.length > 1 && !routeRelevant) {
        console.log('[SURVIVAL] ignoring stale mine route; using local pit recovery');
        memory.clearMineRoute();
    }
    if (mineRoute.length > 1) {
        const reached = await followMineRoute(bot, mineRoute, actionVersion);
        if (reached) {
            memory.clearMineRoute();
            if (memory.hasBase()) memory.clearSurfaceExit();
            return;
        }
        const fallbackExit = memory.getSurfaceExit();
        const rise = fallbackExit ? fallbackExit.y - bot.entity.position.y : Infinity;
        if (fallbackExit && rise > 0 && rise <= 12 && hasRecoveryBlock(bot)) {
            console.log('[SURVIVAL] saved route blocked; switching to local step recovery');
            memory.clearMineRoute();
            if (await carveEscapeStaircase(bot, fallbackExit, actionVersion)) return;
            if (await carveRunUpEscape(bot, fallbackExit, actionVersion)) return;
            const localExit = new Vec3(
                Math.floor(bot.entity.position.x),
                fallbackExit.y,
                Math.floor(bot.entity.position.z)
            );
            const climbed = await climbEmergencyShaft(bot, localExit, actionVersion);
            if (climbed && memory.hasBase()) memory.clearSurfaceExit();
            return;
        }
    }

    const surfaceExit = memory.getSurfaceExit();
    if (surfaceExit) {
        const exit = new Vec3(surfaceExit.x, surfaceExit.y, surfaceExit.z);
        if (
            bot.entity.position.y >= exit.y - 0.1 &&
            !hasSkyExposure(bot) &&
            await carveHorizontalEscape(bot, actionVersion, constructionBase)
        ) {
            return;
        }
        if (exit.y > bot.entity.position.y + 0.5) {
            if (await carveRunUpEscape(bot, exit, actionVersion)) return;
        }
        if (!routeRelevant && shouldUseLocalRecoveryShaft(bot, exit)) {
            const carved = await carveEscapeStaircase(bot, null, actionVersion);
            if (carved) return;
            const stepTarget = new Vec3(
                Math.floor(bot.entity.position.x),
                Math.min(exit.y, Math.floor(bot.entity.position.y) + 4),
                Math.floor(bot.entity.position.z)
            );
            const climbed = await climbEmergencyShaft(bot, stepTarget, actionVersion);
            if (bot.entity.position.y >= exit.y - 0.1) {
                if (memory.hasBase()) memory.clearSurfaceExit();
            }
            if (!climbed) {
                console.log('[SURVIVAL] local staircase and shaft recovery deferred');
            }
            return;
        }
        if (shouldUseEmergencyShaft(
            bot.entity.position,
            exit,
            memory.hasBase(),
            mineRoute.length
        )) {
            const reached = await climbEmergencyShaft(bot, exit, actionVersion);
            if (reached) {
                if (memory.hasBase()) memory.clearSurfaceExit();
                return;
            }
            console.log('[SURVIVAL] vertical shaft climb incomplete; carving a side exit');
            if (await carveHorizontalEscape(bot, actionVersion)) return;
        }
        const reached = await climbTowardSurfaceExit(
            bot,
            exit,
            actionVersion
        );
        if (reached) {
            memory.clearMineRoute();
            if (memory.hasBase()) memory.clearSurfaceExit();
            return;
        }
    }

    const base = memory.getBase();
    if (base && mineRoute.length === 0 && shouldUseShallowBaseShaft(bot.entity.position, base)) {
        const localExit = new Vec3(
            Math.floor(bot.entity.position.x),
            base.y,
            Math.floor(bot.entity.position.z)
        );
        const reached = await climbEmergencyShaft(bot, localExit, actionVersion);
        if (reached) return;
    }
    const needsPurposefulClimb = base && bot.entity.position.y < base.y - 3;
    const needsLocalRise = hasNearbySurfaceRise(bot, 2) && !hasOpenSurfaceRunway(bot);
    let hasStepBlocks = hasRecoveryBlock(bot);
    if (needsPurposefulClimb && !hasStepBlocks) {
        await acquireRecoveryBlock(bot);
        hasStepBlocks = hasRecoveryBlock(bot);
    }
    if ((!needsPurposefulClimb || !hasStepBlocks) && !needsLocalRise) {
        const exits = findNearbyExits(bot, origin);
        for (const exit of exits.slice(0, 8)) {
            actionControl.assertActive(bot, actionVersion);
            try {
                const before = bot.entity.position.clone();
                await movement.moveNear(bot, exit, 1, 1800);
                const raised = bot.entity.position.y > before.y + 0.5;
                const escaped = !isInPit(bot);
                if (raised || (!needsPurposefulClimb && escaped)) return;
            } catch {
                // Try next exit.
            }
        }
    }

    const climbTarget = surfaceExit || (base ? new Vec3(base.x, base.y, base.z) : null);
    if (await carveRunUpEscape(bot, climbTarget, actionVersion)) return;
    const carved = await carveEscapeStaircase(bot, climbTarget, actionVersion);
    if (carved) return;
    if (needsPurposefulClimb) {
        console.log('[SURVIVAL] staircase step deferred until the next world update');
        return;
    }
    await pillarUp(bot);
}

async function escapeSolidCollision(bot) {
    const actionVersion = actionControl.snapshot(bot);
    movement.stop(bot);
    const collisions = movement.bodyCollisionBlocks(bot);
    if (collisions.length === 0) return true;
    console.log(
        `[SURVIVAL] clearing body collision blocks=${collisions.map(block => block.name).join(',')}`
    );
    for (const block of collisions) {
        actionControl.assertActive(bot, actionVersion);
        const current = bot.blockAt(block.position);
        if (!current || current.boundingBox !== 'block') continue;
        if (!bot.canDigBlock(current)) continue;
        await mine.clearBlock(bot, current);
        await movement.sleep(100);
    }
    movement.resyncCollision(bot);
    if (movement.bodyIntersectsSolid(bot)) {
        throw new Error('Solid body collision remained after emergency clearing');
    }
    console.log('[SURVIVAL] body collision cleared');
    return true;
}

async function openSurfaceRefugeExit(bot, actionVersion) {
    const feet = bot.entity.position.floored();
    const threat = nearestHostile(bot, 12);
    const offsets = [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ].sort((left, right) => {
        if (!threat) return 0;
        const leftDistance = feet.plus(left).distanceTo(threat.entity.position);
        const rightDistance = feet.plus(right).distanceTo(threat.entity.position);
        return rightDistance - leftDistance;
    });
    const exitOffset = offsets.find(offset => {
        const lower = bot.blockAt(feet.plus(offset));
        const upper = bot.blockAt(feet.plus(offset).offset(0, 1, 0));
        return lower?.boundingBox === 'block' && upper?.boundingBox === 'block' &&
            bot.canDigBlock(lower) && bot.canDigBlock(upper);
    });
    if (!exitOffset) throw new Error('Emergency refuge has no breakable two-block exit');

    for (const position of [
        feet.plus(exitOffset).offset(0, 1, 0),
        feet.plus(exitOffset)
    ]) {
        actionControl.assertActive(bot, actionVersion);
        const block = bot.blockAt(position);
        if (!block || block.boundingBox !== 'block') continue;
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await mine.clearBlock(bot, block);
        if (bot.blockAt(position)?.boundingBox === 'block') {
            throw new Error(`Refuge exit block remained at ${position.toString()}`);
        }
        await movement.sleep(200);
    }
    const openedCell = feet.plus(exitOffset);
    await movement.moveTowardDirectly(bot, openedCell.offset(0.5, 0, 0.5), 1200);
    if (!bot.entity.position.floored().equals(openedCell)) {
        try {
            await bot.lookAt(openedCell.offset(0.5, 0.6, 0.5), true);
            bot.setControlState('forward', true);
            await movement.sleep(700);
        } finally {
            bot.clearControlStates();
        }
    }
    emergencyShelterPosition = null;
    const rememberedExit = memory.getSurfaceExit();
    if (
        hasSkyExposure(bot) ||
        (rememberedExit && bot.entity.position.y >= rememberedExit.y - 0.1)
    ) {
        memory.clearSurfaceExit();
    }
    console.log(`[SURVIVAL] opened morning refuge exit toward ${exitOffset.toString()}`);
}

async function ensureEmergencyPickaxe(bot) {
    if (bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))) return;
    const plankCount = bot.inventory.items()
        .filter(item => item.name.endsWith('_planks'))
        .reduce((sum, item) => sum + item.count, 0);
    const stickCount = inventoryCount(bot, 'stick');
    if (plankCount < 3 || stickCount < 2) return;
    try {
        console.log('[SURVIVAL] crafting emergency wooden pickaxe for pit recovery');
        await craft.craftItem(bot, 'wooden_pickaxe', 1);
    } catch (error) {
        console.log(`[SURVIVAL] emergency pickaxe unavailable: ${error.message}`);
    }
}

async function carveRunUpEscape(bot, surfaceExit, actionVersion) {
    const origin = bot.entity.position.floored();
    const directions = escapeDirections(origin, surfaceExit);

    if (await carveCompactEscapeStep(bot, origin, directions, actionVersion)) {
        return true;
    }

    for (const direction of directions) {
        actionControl.assertActive(bot, actionVersion);
        const runway = origin.offset(direction.x * 2, 0, direction.z * 2);
        const step = origin.offset(direction.x * 3, 1, direction.z * 3);
        let opened = true;

        for (let distance = 1; distance <= 2; distance++) {
            const stand = origin.offset(direction.x * distance, 0, direction.z * distance);
            await clearStandSpace(bot, stand);
            await digIfNeeded(bot, stand.offset(0, 2, 0));
            if (!isAir(bot.blockAt(stand)) || !isAir(bot.blockAt(stand.offset(0, 1, 0)))) {
                opened = false;
                break;
            }
            const floorPosition = stand.offset(0, -1, 0);
            const floorReady = await ensureStepFloor(bot, floorPosition);
            const floor = bot.blockAt(floorPosition);
            if (!floorReady || !floor || floor.boundingBox !== 'block' || ['water', 'lava'].includes(floor.name)) {
                opened = false;
                break;
            }
        }
        if (!opened) continue;

        await clearStandSpace(bot, step);
        await digIfNeeded(bot, step.offset(0, 2, 0));
        if (!isAir(bot.blockAt(step)) || !isAir(bot.blockAt(step.offset(0, 1, 0)))) {
            continue;
        }
        const floorReady = await ensureStepFloor(bot, step.offset(0, -1, 0));
        if (!floorReady) continue;

        console.log(
            `[SURVIVAL] opened run-up ramp runway=${runway.toString()} step=${step.toString()}`
        );

        try {
            await movement.moveBlock(bot, runway, 4500);
        } catch {
            await walkOpenedCorridor(bot, runway.offset(0.5, 0, 0.5), actionVersion);
        }
        if (horizontalDistance(bot.entity.position, runway.offset(0.5, 0, 0.5)) > 0.9) {
            continue;
        }

        const beforeY = bot.entity.position.y;
        let climbed = await finishSafeAscent(bot, step);
        if (!climbed) {
            try {
                await movement.moveBlock(bot, step, 4500);
            } catch {
                climbed = await finishSafeAscent(bot, step);
            }
        }
        climbed ||= bot.entity.position.y >= beforeY + 0.7;
        console.log(
            `[SURVIVAL] run-up ramp target=${step.toString()} ` +
            `position=${bot.entity.position.floored().toString()} climbed=${climbed}`
        );
        if (climbed) return true;
    }
    return false;
}

async function carveCompactEscapeStep(bot, origin, directions, actionVersion) {
    for (const direction of directions) {
        actionControl.assertActive(bot, actionVersion);
        const step = origin.offset(direction.x, 1, direction.z);
        const floor = bot.blockAt(step.offset(0, -1, 0));
        if (
            floor?.boundingBox !== 'block' ||
            ['water', 'lava', 'magma_block'].includes(floor.name)
        ) continue;

        await clearStandSpace(bot, step);
        if (!isAir(bot.blockAt(step)) || !isAir(bot.blockAt(step.offset(0, 1, 0)))) {
            continue;
        }
        const beforeY = bot.entity.position.y;
        const climbed = await finishSafeAscent(bot, step);
        if (climbed || bot.entity.position.y >= beforeY + 0.7) {
            console.log(
                `[SURVIVAL] compact escape step=${step.toString()} ` +
                `position=${bot.entity.position.floored().toString()}`
            );
            return true;
        }
    }
    return false;
}

async function carveHorizontalEscape(bot, actionVersion, preferredTarget = null) {
    const origin = bot.entity.position.floored();
    const directions = [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ];
    if (preferredTarget) {
        directions.sort((left, right) =>
            horizontalDistance(origin.plus(left), preferredTarget) -
            horizontalDistance(origin.plus(right), preferredTarget)
        );
    }
    for (const direction of directions) {
        actionControl.assertActive(bot, actionVersion);
        let safe = true;
        await digIfNeeded(bot, origin);
        await digIfNeeded(bot, origin.offset(0, 1, 0));
        for (let distance = 1; distance <= 3; distance++) {
            const feet = origin.offset(direction.x * distance, 0, direction.z * distance);
            const floor = bot.blockAt(feet.offset(0, -1, 0));
            if (!floor || floor.boundingBox !== 'block' || ['water', 'lava'].includes(floor.name)) {
                safe = false;
                break;
            }
            const feetClear = await digIfNeeded(bot, feet);
            const headClear = await digIfNeeded(bot, feet.offset(0, 1, 0));
            if (!feetClear || !headClear) {
                safe = false;
                break;
            }
        }
        if (!safe) continue;
        const target = origin
            .offset(direction.x * 3, 0, direction.z * 3)
            .offset(0.5, 0, 0.5);
        const moved = await walkOpenedCorridor(bot, target, actionVersion);
        if (bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) >= 1.5) {
            console.log(`[SURVIVAL] horizontal pit exit reached ${bot.entity.position.floored().toString()}`);
            return true;
        }
        console.log(`[SURVIVAL] opened pit corridor did not move the bot moved=${moved.toFixed(2)}`);
    }
    return false;
}

async function walkOpenedCorridor(bot, target, actionVersion) {
    const start = bot.entity.position.clone();
    const deadline = Date.now() + 3500;
    movement.stop(bot);
    try {
        await bot.lookAt(target.offset(0, 1.2, 0), true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', false);
        bot.setControlState('jump', false);
        while (Date.now() < deadline) {
            actionControl.assertActive(bot, actionVersion);
            if (horizontalDistance(bot.entity.position, start) >= 2.2) break;
            await movement.sleep(50);
        }
    } finally {
        movement.stop(bot);
    }
    return horizontalDistance(bot.entity.position, start);
}

async function climbEmergencyShaft(bot, exit, actionVersion) {
    actionControl.assertActive(bot, actionVersion);
    const feet = bot.entity.position.floored();
    for (let y = feet.y + 1; y <= exit.y + 1; y++) {
        await digIfNeeded(bot, new Vec3(feet.x, y, feet.z));
    }
    await pillarUp(bot, exit.y);
    await movement.sleep(500);
    const reached = bot.entity.position.y >= exit.y - 0.1;
    console.log(
        `[SURVIVAL] emergency shaft exit targetY=${exit.y} ` +
        `positionY=${bot.entity.position.y.toFixed(1)} reached=${reached}`
    );
    return reached;
}

function resyncSolidCollision(bot) {
    return movement.resyncCollision(bot);
}

async function followMineRoute(bot, route, actionVersion) {
    let index = nearestMineRouteIndex(bot, route);
    console.log(`[SURVIVAL] following saved mine route from index=${index}`);
    for (; index >= 0; index--) {
        actionControl.assertActive(bot, actionVersion);
        const target = new Vec3(route[index].x, route[index].y, route[index].z);
        const climbing = target.y > bot.entity.position.y + 0.45;
        let reached = climbing && await finishSafeAscent(bot, target);
        if (climbing && !reached) {
            reached = await syncRecoveryStep(bot, target);
        }
        if (!reached && !climbing) {
            try {
                await movement.moveBlock(bot, target, 2200);
            } catch {
                movement.stop(bot);
            }
        }
        reached ||= isAtMineRouteStand(bot, target);
        if (!reached) {
            console.log(`[SURVIVAL] saved mine route step incomplete ${target.toString()}`);
            return false;
        }
    }

    const entry = new Vec3(route[0].x, route[0].y, route[0].z);
    const reached = isAtMineRouteStand(bot, entry);
    if (reached) console.log(`[SURVIVAL] saved mine route exit reached ${entry.toString()}`);
    return reached;
}

function isAtMineRouteStand(bot, target) {
    const center = target.offset(0.5, 0, 0.5);
    return bot.entity.position.y >= target.y - 0.15 &&
        bot.entity.position.y <= target.y + 0.65 &&
        horizontalDistance(bot.entity.position, center) <= 0.6;
}

function nearestMineRouteIndex(bot, route) {
    let bestIndex = route.length - 1;
    let bestDistance = Infinity;
    route.forEach((position, index) => {
        const distance = bot.entity.position.distanceTo(
            new Vec3(position.x, position.y, position.z)
        );
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });
    return bestIndex;
}

function isMineRouteRelevant(position, route, maxDistance = 8) {
    if (!Array.isArray(route) || route.length < 2) return false;
    return route.some(point => position.distanceTo(
        new Vec3(point.x + 0.5, point.y, point.z + 0.5)
    ) <= maxDistance);
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
        if (!isAir(bot.blockAt(next)) || !isAir(bot.blockAt(next.offset(0, 1, 0)))) {
            continue;
        }
        const floorReady = await ensureStepFloor(bot, floor);

        let climbed = floorReady && await finishSafeAscent(bot, next);
        if (!climbed) {
            try {
                await movement.moveBlock(bot, next, 3500);
            } catch {
                climbed = await finishSafeAscent(bot, next);
            }
        }

        if (!climbed && bot.entity.position.y < beforeY + 0.7 && floorReady) {
            await syncRecoveryStep(bot, next);
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
    for (let i = 0; i < 8; i++) {
        actionControl.assertActive(bot, actionVersion);
        const current = bot.entity.position.floored();
        if (current.y >= exit.y && horizontalDistance(current, exit) <= 4 && isSurface(bot)) {
            console.log(`[SURVIVAL] reached surface exit area ${current.toString()}`);
            return true;
        }

        const dx = Math.abs(exit.x - current.x) >= Math.abs(exit.z - current.z)
            ? Math.sign(exit.x - current.x)
            : 0;
        const dz = dx === 0 ? Math.sign(exit.z - current.z) : 0;
        const horizontal = current.offset(dx || 1, 0, dz);
        const next = current.y < exit.y
            ? horizontal.offset(0, 1, 0)
            : horizontal;

        await clearStandSpace(bot, next);
        const floorReady = await ensureStepFloor(bot, next.offset(0, -1, 0));

        let climbed = floorReady && next.y > current.y && await finishSafeAscent(bot, next);
        if (!climbed) {
            try {
                await movement.moveBlock(bot, next, 3500);
            } catch {
                movement.stop(bot);
                climbed = await finishSafeAscent(bot, next);
            }
        }

        if (!climbed && bot.entity.position.floored().equals(current) && floorReady) {
            await syncRecoveryStep(bot, next);
        }

        console.log(
            `[SURVIVAL] exit step target=${next.toString()} ` +
            `position=${bot.entity.position.floored().toString()}`
        );

        if (bot.entity.position.floored().equals(current)) return false;
    }
    return false;
}

function horizontalDistance(left, right) {
    return Math.hypot(left.x - right.x, left.z - right.z);
}

function shouldUseEmergencyShaft(position, exit, hasBase, routeLength) {
    const rise = exit.y - position.y;
    return !hasBase &&
        routeLength === 0 &&
        rise > 0 &&
        rise <= 6;
}

function shouldUseLocalRecoveryShaft(bot, exit) {
    const rise = exit.y - bot.entity.position.y;
    const routeIsFarAway = horizontalDistance(bot.entity.position, exit) > 8;
    return rise > 3 && routeIsFarAway && hasRecoveryBlock(bot);
}

function shouldUseShallowBaseShaft(position, base) {
    const rise = base.y - position.y;
    return rise > 0 && rise <= 3;
}

async function clearStandSpace(bot, position) {
    await digIfNeeded(bot, position);
    await digIfNeeded(bot, position.offset(0, 1, 0));
    await digIfNeeded(bot, position.offset(0, 2, 0));
}

async function ensureStepFloor(bot, position) {
    const floor = bot.blockAt(position);
    if (floor?.boundingBox === 'block') return true;
    const item = preferredRecoveryBlock(bot);
    if (!item) return false;

    const reference = findPlacementReference(bot, position);
    if (!reference) return false;
    try {
        await bot.equip(item, 'hand');
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(reference.block, reference.face);
        await movement.sleep(150);
        return bot.blockAt(position)?.boundingBox === 'block';
    } catch {
        return bot.blockAt(position)?.boundingBox === 'block';
    }
}

function hasRecoveryBlock(bot) {
    return bot.inventory.items().some(item =>
        [
            'dirt', 'cobblestone', 'sandstone', 'red_sandstone', 'terracotta',
            'oak_planks', 'birch_planks', 'sand', 'gravel'
        ].includes(item.name)
    );
}

function preferredRecoveryBlock(bot, priority = [
    'dirt', 'cobbled_deepslate', 'cobblestone', 'sandstone', 'red_sandstone',
    'terracotta', 'oak_planks', 'birch_planks', 'sand', 'gravel'
]) {
    const items = bot.inventory.items();
    for (const name of priority) {
        const item = items.find(entry => entry.name === name);
        if (item) return item;
    }
    return items.find(item => item.name.endsWith('_planks')) || null;
}

async function acquireRecoveryBlock(bot) {
    const nearbyDrop = Object.values(bot.entities || {})
        .filter(entity => entity.name === 'item' && entity.position)
        .filter(entity => entity.position.distanceTo(bot.entity.position) <= 6)
        .filter(entity => entity.position.y >= bot.entity.position.y - 0.5)
        .sort((left, right) =>
            left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position)
        )[0];

    if (nearbyDrop) {
        try {
            await movement.moveNear(bot, nearbyDrop.position, 1, 2500);
        } catch {
            movement.stop(bot);
        }
        await movement.sleep(400);
        if (hasRecoveryBlock(bot)) return true;
    }

    const origin = bot.entity.position.floored();
    const hasPickaxe = bot.inventory.items().some(item => item.name.endsWith('_pickaxe'));
    const candidatePositions = [];
    for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
            for (let dy = 2; dy >= 0; dy--) {
                candidatePositions.push(origin.offset(dx, dy, dz));
            }
        }
    }
    const candidate = candidatePositions
        .sort((left, right) =>
            left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position)
        )
        .map(position => bot.blockAt(position))
        .find(block =>
            block &&
            [
                'stone', 'deepslate', 'dirt', 'cobblestone', 'sandstone',
                'red_sandstone', 'terracotta'
            ].includes(block.name) &&
            (hasPickaxe || !['stone', 'deepslate'].includes(block.name)) &&
            block.position.distanceTo(bot.entity.position.offset(0, 1.4, 0)) <= 4.5 &&
            bot.canDigBlock(block)
        );
    if (!candidate) return false;

    console.log(`[SURVIVAL] mining recovery block ${candidate.name} ${candidate.position.toString()}`);
    const expectedDrop = candidate.name === 'stone' ? 'cobblestone' : candidate.name;
    try {
        await mine.mineSpecificBlock(bot, candidate, expectedDrop);
    } catch (error) {
        console.log(`[SURVIVAL] recovery block delayed: ${error.message}`);
    }
    await movement.sleep(700);
    const drop = Object.values(bot.entities || {})
        .filter(entity => entity.name === 'item' && entity.position)
        .filter(entity => entity.position.distanceTo(bot.entity.position) <= 4)
        .filter(entity => entity.position.y >= bot.entity.position.y - 0.5)
        .sort((left, right) =>
            left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position)
        )[0];
    if (drop) {
        try {
            await movement.moveNear(bot, drop.position, 1, 2500);
        } catch {
            movement.stop(bot);
        }
        await movement.sleep(400);
    }
    return hasRecoveryBlock(bot);
}

async function carveLateralNightRefuge(bot, actionVersion) {
    const origin = bot.entity.position.floored();
    for (const direction of [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ]) {
        const target = origin.plus(direction);
        const feet = bot.blockAt(target);
        const head = bot.blockAt(target.offset(0, 1, 0));
        const floor = bot.blockAt(target.offset(0, -1, 0));
        const roof = bot.blockAt(target.offset(0, 2, 0));
        if (
            feet?.boundingBox !== 'block' ||
            head?.boundingBox !== 'block' ||
            floor?.boundingBox !== 'block' ||
            roof?.boundingBox !== 'block' ||
            !bot.canDigBlock(feet) ||
            !bot.canDigBlock(head)
        ) continue;

        console.log(`[SURVIVAL] carving lateral night refuge ${target.toString()}`);
        actionControl.assertActive(bot, actionVersion);
        await mine.clearBlock(bot, head);
        actionControl.assertActive(bot, actionVersion);
        await mine.clearBlock(bot, feet);
        actionControl.assertActive(bot, actionVersion);
        await movement.walkToward(bot, target.offset(0.5, 0, 0.5), {
            durationMs: 1800,
            arrivalRange: 0.2
        });
        if (!bot.entity.position.floored().equals(target)) {
            try {
                await bot.lookAt(target.offset(0.5, 0.6, 0.5), true);
                bot.setControlState('forward', true);
                await movement.sleep(750);
            } finally {
                bot.clearControlStates();
            }
        }
        if (bot.entity.position.floored().equals(target)) {
            return true;
        }
    }
    return false;
}

async function syncRecoveryStep(bot, next) {
    const feet = bot.blockAt(next);
    const head = bot.blockAt(next.offset(0, 1, 0));
    if (!isAir(feet) || !isAir(head)) return false;
    const climbed = await movement.stepUpToward(bot, next);
    if (!climbed) await movement.walkToward(bot, next, { durationMs: 1000 });
    const reached = bot.entity.position.distanceTo(next.offset(0.5, 0, 0.5)) <= 1.2;
    console.log(`[SURVIVAL] physical recovery step ${next.toString()} reached=${reached}`);
    return reached;
}

async function finishSafeAscent(bot, next) {
    const current = bot.entity.position.floored();
    await digIfNeeded(bot, current.offset(0, 2, 0));
    const feet = bot.blockAt(next);
    const head = bot.blockAt(next.offset(0, 1, 0));
    const floor = bot.blockAt(next.offset(0, -1, 0));
    if (!isAir(feet) || !isAir(head) || floor?.boundingBox !== 'block') return false;

    const beforeY = bot.entity.position.y;
    const center = next.offset(0.5, 0, 0.5);
    const horizontal = Math.hypot(
        bot.entity.position.x - center.x,
        bot.entity.position.z - center.z
    );
    if (horizontal > 2.2 || next.y < beforeY + 0.45 || next.y > beforeY + 1.6) return false;

    for (let attempt = 1; attempt <= 2 && !isAtMineRouteStand(bot, next); attempt++) {
        movement.stop(bot);
        if (attempt === 2) {
            const currentCenter = bot.entity.position.floored().offset(0.5, 0, 0.5);
            await movement.walkToward(bot, currentCenter, { durationMs: 350 });
        }
        try {
            primeGroundedJump(bot);
            await bot.lookAt(new Vec3(center.x, beforeY + 1.2, center.z), true);
            bot.setControlState('sprint', false);
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            const riseDeadline = Date.now() + 800;
            while (
                Date.now() < riseDeadline &&
                bot.entity.position.y < next.y - 0.22
            ) {
                await movement.sleep(25);
            }
            if (bot.entity.position.y >= next.y - 0.22) {
                bot.setControlState('jump', false);
            }
            const deadline = Date.now() + 1500;
            while (Date.now() < deadline) {
                if (isAtMineRouteStand(bot, next)) break;
                await movement.sleep(50);
            }
        } finally {
            movement.stop(bot);
        }
        await waitForGround(bot, 700);
    }
    const reached = isAtMineRouteStand(bot, next);
    console.log(`[SURVIVAL] direct ascent target=${next.toString()} reached=${reached}`);
    return reached;
}

async function digIfNeeded(bot, position) {
    const block = bot.blockAt(position);
    if (!block || isPassable(block)) return true;
    if (!bot.canDigBlock(block)) return false;
    try {
        await mine.clearBlock(bot, block);
    } catch (error) {
        try {
            bot.stopDigging();
        } catch {
            // Dig state may already be clear.
        }
        console.log(`[SURVIVAL] could not clear ${block.name} at ${position.toString()}: ${error.message}`);
        return false;
    }
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
        if (isAir(bot.blockAt(position))) return true;
        await movement.sleep(50);
    }
    console.log(`[SURVIVAL] block remained after dig ${block.name} at ${position.toString()}`);
    return false;
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
    const actionVersion = actionControl.snapshot(bot);
    const moved = await shelter.returnToBase(bot, actionVersion);
    actionControl.assertActive(bot, actionVersion);
    if (moved) return { status: 'inside_base' };
    if (isNight(bot) && !isEmergencyShelter(bot)) {
        console.log('[SURVIVAL] base entry failed at night; sealing a temporary refuge.');
        await buildEmergencyShelter(bot);
        return { status: 'emergency_refuge' };
    }
    throw new Error('Could not enter the remembered base');
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
        await movement.sleep(500);
        if (!isNight(bot)) {
            console.log('[SURVIVAL] sleep confirmed by morning clock update');
            return;
        }
        console.log(`[SURVIVAL] could not sleep in bed: ${error.message}`);
        blockBedForNight(bot, bed.position);
        await waitSafe(bot, 3000);
    }
}

function nearestHostile(bot, radius) {
    const now = Date.now();
    return Object.values(bot.entities || {})
        .filter(entity => isHostileEntity(entity, bot))
        .filter(entity => entity.position && entity.position.distanceTo(bot.entity.position) <= radius)
        .map(entity => ({
            id: entity.id,
            name: entityName(entity),
            distance: entity.position.distanceTo(bot.entity.position),
            entity
        }))
        .filter(threat => threat.distance <= 1.8 || hasEntityLineOfSight(bot, threat.entity))
        .filter(threat => {
            const ignoredUntil = temporarilyIgnoredHostiles.get(threat.id) || 0;
            if (ignoredUntil <= now) {
                temporarilyIgnoredHostiles.delete(threat.id);
                return true;
            }
            return threat.distance <= 2.6 && hasEntityLineOfSight(bot, threat.entity);
        })
        .sort((a, b) => a.distance - b.distance)[0] || null;
}

function isHostileEntity(entity, bot) {
    const name = entityName(entity);
    if (name === 'spider' && !isNight(bot)) return false;
    return HOSTILES.has(name);
}

function entityName(entity) {
    return String(entity.name || entity.displayName || entity.type || 'unknown')
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
        .filter(block => !blockedBedsForNight.has(positionKey(block.position)))
        .sort((a, b) =>
            a.position.distanceTo(bot.entity.position) -
            b.position.distanceTo(bot.entity.position)
    )[0] || null;
}

function positionKey(position) {
    return `${position.x},${position.y},${position.z}`;
}

function blockBedForNight(bot, position) {
    blockedBedsForNight.add(positionKey(position));
    for (const offset of [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ]) {
        const neighbor = bot.blockAt(position.plus(offset));
        if (neighbor?.name?.endsWith('_bed')) {
            blockedBedsForNight.add(positionKey(neighbor.position));
        }
    }
}

function isSurface(bot) {
    const feet = bot.entity.position.floored();
    const feetBlock = bot.blockAt(feet);
    const headBlock = bot.blockAt(feet.offset(0, 1, 0));
    const skyLight = Math.max(
        Number(feetBlock?.skyLight ?? -1),
        Number(headBlock?.skyLight ?? -1)
    );
    if (skyLight >= 0) return skyLight >= 10;
    return bot.entity.position.y >= 58;
}

function hasSkyExposure(bot) {
    const feet = bot.entity.position.floored();
    const feetBlock = bot.blockAt(feet);
    const headBlock = bot.blockAt(feet.offset(0, 1, 0));
    const skyLight = Math.max(
        Number(feetBlock?.skyLight ?? -1),
        Number(headBlock?.skyLight ?? -1)
    );
    return skyLight >= 10;
}

function isInPit(bot) {
    const position = occupiedFeetCell(bot);
    const neighbors = [
        [1, 0], [-1, 0], [0, 1], [0, -1]
    ].map(([dx, dz]) => {
        const feet = bot.blockAt(position.offset(dx, 0, dz));
        const body = bot.blockAt(position.offset(dx, 1, dz));
        return { feet, body };
    });
    if (neighbors.some(({ feet, body }) => isPassable(feet) && isPassable(body))) return false;
    if (neighbors.some(({ feet, body }) => isFoliage(feet) || isFoliage(body))) return false;
    return true;
}

function occupiedFeetCell(bot) {
    const position = bot.entity.position.floored();
    const current = bot.blockAt(position);
    const above = bot.blockAt(position.offset(0, 1, 0));
    if (current?.boundingBox !== 'block' || !isPassable(above)) return position;

    const shapeTop = highestCollisionTop(current);
    const localY = bot.entity.position.y - position.y;
    if (shapeTop > 0 && localY >= shapeTop - 0.08) {
        return position.offset(0, 1, 0);
    }
    return position;
}

function highestCollisionTop(block) {
    const shapes = Array.isArray(block?.shapes) ? block.shapes : [];
    if (shapes.length === 0) return block?.boundingBox === 'block' ? 1 : 0;
    return shapes.reduce((top, shape) =>
        Array.isArray(shape) && Number.isFinite(shape[4])
            ? Math.max(top, shape[4])
            : top, 0);
}

function isFoliage(block) {
    const name = block?.name || '';
    return name.endsWith('_leaves') || [
        'leaf_litter', 'short_grass', 'tall_grass', 'fern', 'large_fern',
        'vine', 'snow', 'moss_carpet'
    ].includes(name);
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

async function pillarUp(bot, targetY = Infinity) {
    if (!hasRecoveryBlock(bot)) {
        await jumpForward(bot);
        return;
    }

    const maxSteps = Number.isFinite(targetY)
        ? Math.min(16, Math.max(4, Math.ceil(targetY - bot.entity.position.y) + 2))
        : 4;
    for (let i = 0; i < maxSteps; i++) {
        if (bot.entity.position.y >= targetY - 0.1) break;
        const block = preferredRecoveryBlock(bot);
        if (!block) break;
        const beforeY = bot.entity.position.y;
        const feet = bot.entity.position.floored();
        await digIfNeeded(bot, feet.offset(0, 1, 0));
        await digIfNeeded(bot, feet.offset(0, 2, 0));
        await digIfNeeded(bot, feet.offset(0, 3, 0));
        await waitForGround(bot, 1000);
        const below = bot.blockAt(feet.offset(0, -1, 0));
        if (!below) break;
        let placed = false;
        try {
            await bot.equip(block, 'hand');
            primeGroundedJump(bot);
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
            // A jump briefly rises almost two blocks. Judge recovery from the
            // settled standing position, not that airborne peak.
            await movement.sleep(700);
            await waitForGround(bot, 1000);
        } catch (error) {
            if (bot.entity.position.y >= beforeY + 0.7) {
                placed = true;
            }
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

async function backAway(bot, threatPosition, durationMs = 900) {
    try {
        const deadline = Date.now() + durationMs;
        let redirects = 0;
        await lookTowardSafeRetreat(bot, threatPosition);
        while (Date.now() < deadline) {
            if (isUnsafeRetreatTrajectory(bot)) {
                if (redirects++ >= 2 || !await lookTowardSafeRetreat(bot, threatPosition)) {
                    console.log('[SURVIVAL] retreat stopped at unsafe drop or liquid');
                    break;
                }
                continue;
            }
            bot.setControlState('forward', true);
            bot.setControlState('jump', canRetreatJump(bot));
            bot.setControlState('sprint', true);
            await movement.sleep(100);
        }
    } finally {
        bot.clearControlStates();
    }
}

async function lookTowardSafeRetreat(bot, threatPosition) {
    const target = findSafeRetreatTarget(bot, threatPosition);
    if (!target) return false;
    await bot.lookAt(target.offset(0.5, 0.8, 0.5), true);
    return true;
}

function findSafeRetreatTarget(bot, threatPosition) {
    const origin = bot.entity.position.floored();
    const awayX = origin.x + 0.5 - threatPosition.x;
    const awayZ = origin.z + 0.5 - threatPosition.z;
    const baseAngle = Math.atan2(awayZ, awayX);
    const currentDistance = bot.entity.position.distanceTo(threatPosition);

    return [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]
        .map(offset => {
            const angle = baseAngle + offset;
            const dx = Math.cos(angle);
            const dz = Math.sin(angle);
            let safeSteps = 0;
            for (let step = 1; step <= 7; step++) {
                const position = new Vec3(
                    Math.round(origin.x + dx * step),
                    origin.y,
                    Math.round(origin.z + dz * step)
                );
                const feet = bot.blockAt(position);
                const head = bot.blockAt(position.offset(0, 1, 0));
                const floor = bot.blockAt(position.offset(0, -1, 0));
                if (['water', 'lava', 'powder_snow'].includes(feet?.name)) break;
                if (['water', 'lava'].includes(head?.name)) break;
                if (floor?.boundingBox !== 'block') break;
                safeSteps = step;
            }
            const target = new Vec3(
                Math.round(origin.x + dx * safeSteps),
                origin.y,
                Math.round(origin.z + dz * safeSteps)
            );
            return {
                target,
                safeSteps,
                threatGain: target.distanceTo(threatPosition) - currentDistance
            };
        })
        .filter(candidate => candidate.safeSteps >= 2 && candidate.threatGain > 0.5)
        .sort((left, right) =>
            right.safeSteps - left.safeSteps || right.threatGain - left.threatGain
        )[0]?.target || null;
}

function isUnsafeRetreatTrajectory(bot) {
    const yaw = bot.entity.yaw;
    const dx = Math.round(-Math.sin(yaw));
    const dz = Math.round(-Math.cos(yaw));
    const feet = bot.entity.position.floored();
    for (let distance = 1; distance <= 2; distance++) {
        const front = feet.offset(dx * distance, 0, dz * distance);
        const frontFeet = bot.blockAt(front);
        const frontHead = bot.blockAt(front.offset(0, 1, 0));
        if (['water', 'lava', 'powder_snow'].includes(frontFeet?.name)) return true;
        if (['water', 'lava'].includes(frontHead?.name)) return true;
        let supported = false;
        for (let depth = 1; depth <= 2; depth++) {
            const floor = bot.blockAt(front.offset(0, -depth, 0));
            if (floor?.boundingBox === 'block' && floor.name !== 'magma_block') {
                supported = true;
                break;
            }
        }
        if (!supported) return true;
    }
    return false;
}

function canRetreatJump(bot) {
    const yaw = bot.entity.yaw;
    const dx = Math.round(-Math.sin(yaw));
    const dz = Math.round(-Math.cos(yaw));
    const feet = bot.entity.position.floored();
    const obstacle = bot.blockAt(feet.offset(dx, 0, dz));
    if (obstacle?.boundingBox !== 'block') return false;
    const landing = feet.offset(dx * 2, 0, dz * 2);
    const landingFeet = bot.blockAt(landing);
    const landingHead = bot.blockAt(landing.offset(0, 1, 0));
    const landingFloor = bot.blockAt(landing.offset(0, -1, 0));
    return isAir(landingFeet) && isAir(landingHead) && landingFloor?.boundingBox === 'block';
}

async function jumpForward(bot) {
    try {
        await waitForGround(bot, 700);
        primeGroundedJump(bot);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        bot.setControlState('sprint', true);
        await movement.sleep(1800);
    } finally {
        bot.clearControlStates();
    }
}

function primeGroundedJump(bot) {
    const feet = bot.entity.position.floored();
    const floor = bot.blockAt(feet.offset(0, -1, 0));
    const nearBlockTop = Math.abs(bot.entity.position.y - feet.y) < 0.12;
    const verticalSpeed = Math.abs(bot.entity.velocity?.y || 0);
    if (floor?.boundingBox === 'block' && nearBlockTop && verticalSpeed < 0.08) {
        bot.entity.onGround = true;
    }
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

function isPassable(block) {
    const name = block?.name || '';
    if (['lava', 'fire', 'soul_fire', 'powder_snow'].includes(name)) return false;
    return isAir(block) || ['water', 'bubble_column'].includes(name) || block?.boundingBox === 'empty';
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
    escapeSolidCollision,
    recoverDeathItems,
    chooseThreatAction,
    canFightUnarmed,
    shouldInterruptForThreat,
    nearestHostile,
    fightMob,
    evadeHostile,
    emergencyCreeperDodge,
    needsAir,
    shouldInterruptForWater,
    escapeWater,
    findNearestDryStand,
    buildEmergencyShelter,
    isEmergencyShelter,
    lacksStableFloor,
    isSurfaceRefugeSiteSafe,
    isUnsafeForwardStep: isUnsafeRetreatTrajectory,
    canRetreatJump,
    findSafeRetreatPosition,
    shouldUseEmergencyShaft,
    shouldUseShallowBaseShaft,
    isMineRouteRelevant,
    isInPit,
    escapePit,
    returnBase,
    waitSafe,
    sleepInBed
};
