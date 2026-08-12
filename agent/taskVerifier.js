const memory = require('../skills/memory');
const shelter = require('../skills/shelter');
const storage = require('../skills/storage');
const colonyMemory = require('../skills/colonyMemory');
const { Vec3 } = require('vec3');

const VERIFIED_TOOLS = new Set([
    'explore', 'mine_block', 'craft_item', 'place_block', 'collect_stone',
    'craft_stone_tools', 'build_shelter', 'ensure_base', 'eat_food', 'find_food',
    'maintain_food_supply', 'care_for_animals', 'fish', 'replant_sapling',
    'fight_mob', 'fight_player', 'evade_hostile', 'emergency_shelter', 'escape_pit',
    'recover_items', 'escape_water', 'return_base', 'wait_safe',
    'execute_dynamic_skill', 'sleep_bed', 'secure_bed', 'establish_wheat_farm',
    'organize_storage', 'prepare_mining_kit', 'mine_iron', 'smelt_item',
    'craft_iron_kit', 'craft_iron_armor', 'build_blueprint', 'build_showcase',
    'ensure_shared_storage', 'deposit_shared_storage', 'withdraw_shared_storage',
    'count_shared_storage', 'build_colony_marker', 'follow_player', 'move_near'
]);

class TaskVerificationError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'TaskVerificationError';
        this.code = 'TASK_VERIFICATION_FAILED';
        this.details = details;
    }
}

function capture(bot, observation = null) {
    return {
        timestamp: Date.now(),
        inventory: { ...(observation?.inventory || countInventory(bot)) },
        position: observation?.position || vector(bot?.entity?.position),
        base: observation?.base || memory.getBase(),
        health: Number(observation?.health ?? bot?.health ?? 0),
        food: Number(observation?.food ?? bot?.food ?? 0),
        oxygen: Number(bot?.oxygenLevel ?? 20),
        isSleeping: Boolean(bot?.isSleeping),
        isDay: Boolean(bot?.time?.isDay),
        entities: captureEntities(bot),
        players: capturePlayers(bot),
        equipment: captureEquipment(bot),
        hasUsableChest: observation?.hasUsableChest ?? safe(() => storage.hasChestNearby(bot), false),
        sharedInventory: { ...(colonyMemory.load().sharedStorage?.inventory || {}) }
    };
}

function verify(call, before, after, options = {}) {
    const tool = call?.tool;
    const args = call?.args || {};
    if (!tool) return failed('Missing tool call');

    if (tool === 'explore') {
        const result = options.executionResult || {};
        const moved = distanceBetween(before.position, after.position);
        if (result.cancelled) return failed('Exploration was cancelled', { moved });
        if (result.found?.position) return passed('Exploration found its requested target', { moved });
        return (result.reached || result.recovered) && moved >= 1
            ? passed(`Exploration advanced ${moved.toFixed(2)} blocks`, { moved })
            : failed('Exploration produced no target or observed movement', { moved, result });
    }

    if (tool === 'mine_block') {
        const names = inventoryNamesForBlock(args.target);
        const gained = total(after.inventory, names) - total(before.inventory, names);
        const requested = Math.max(1, Number(args.count || 1));
        return gained >= requested
            ? passed(`Collected ${gained} ${names.join('/')}`, { gained })
            : failed(`Inventory gained only ${gained}/${requested} for ${args.target}`, { gained, requested });
    }
    if (tool === 'craft_item') {
        const gained = count(after.inventory, args.item) - count(before.inventory, args.item);
        return gained >= Math.max(1, Number(args.count || 1))
            ? passed(`Crafted ${gained} ${args.item}`, { gained })
            : failed(`Expected ${args.item} inventory to increase`, { gained });
    }
    if (tool === 'place_block') {
        const block = options.executionResult;
        const visible = block?.position && options.bot?.blockAt(block.position)?.name === args.item;
        return block?.name === args.item && visible
            ? passed(`Placed and observed ${args.item}`, { position: vector(block.position) })
            : failed(`Placed ${args.item} was not observed in the world`);
    }
    if (tool === 'collect_stone') {
        const gained = count(after.inventory, 'cobblestone') - count(before.inventory, 'cobblestone');
        const requested = Math.max(1, Number(args.count || 16));
        return gained >= requested
            ? passed(`Collected ${gained} cobblestone`, { gained, requested })
            : failed(`Collected only ${gained}/${requested} cobblestone`, { gained, requested });
    }
    if (tool === 'craft_stone_tools') {
        const missing = ['stone_pickaxe', 'stone_axe', 'stone_sword'].filter(name => count(after.inventory, name) < 1);
        return missing.length === 0 ? passed('Stone tool set exists') : failed(`Missing stone tools: ${missing.join(', ')}`);
    }
    if (tool === 'return_base') {
        const base = after.base || memory.getBase();
        if (!base) return failed('No remembered base exists');
        const distance = distanceBetween(after.position, base);
        return distance <= 4 ? passed(`Reached base at distance ${distance.toFixed(2)}`, { distance }) :
            failed(`Still ${distance.toFixed(2)} blocks from base`, { distance });
    }
    if (tool === 'move_near') {
        const target = { x: Number(args.x), y: Number(args.y), z: Number(args.z) };
        const distance = distanceBetween(after.position, target);
        const accepted = Math.max(1, Number(args.range || 2)) + 1.25;
        return distance <= accepted
            ? passed(`Movement target reached within ${distance.toFixed(1)} blocks`, { distance, accepted })
            : failed(`Movement ended ${distance.toFixed(1)} blocks from target`, { distance, accepted });
    }
    if (tool === 'ensure_base' || tool === 'build_shelter') {
        const base = after.base || memory.getBase();
        if (!base) return failed('Base was not written to memory');
        const basePosition = new Vec3(base.x, base.y, base.z);
        const tablePosition = basePosition.offset(1, 0, 1);
        const hasInteriorTable = options.bot?.blockAt(tablePosition)?.name === 'crafting_table';
        if (!hasInteriorTable) return failed('Base has no verified interior crafting table');
        const shellScore = options.executionResult?.shellScore ?? safe(
            () => shelter.scoreShelterShell(options.bot, base),
            0
        );
        return shellScore >= shelter.SHELL_TARGET
            ? passed(`Base remembered and shell validated ${shellScore}/${shelter.SHELL_TARGET}`, { shellScore })
            : failed(`Base shell validation failed ${shellScore}/${shelter.SHELL_TARGET}`, { shellScore });
    }
    if (tool === 'organize_storage') {
        const deposited = options.executionResult?.deposited || {};
        const depositedCount = Object.values(deposited).reduce((sum, value) => sum + Number(value || 0), 0);
        if (depositedCount > 0 && after.hasUsableChest) {
            return passed(`Deposited ${depositedCount} items into chest`, { deposited });
        }
        const beforeDepositable = storage.deposableInventory(before.inventory);
        if (Object.keys(beforeDepositable).length === 0 && after.hasUsableChest) {
            return passed('Storage is ready; there were no excess items to deposit', { deposited: {} });
        }
        return failed('No inventory transfer into a usable chest was confirmed', { deposited });
    }
    if (tool === 'eat_food') {
        const foodBefore = Number(options.beforeObservation?.food ?? 20);
        const foodAfter = Number(options.afterObservation?.food ?? foodBefore);
        return foodAfter > foodBefore ? passed(`Food increased ${foodBefore}->${foodAfter}`) : failed('Food level did not increase');
    }
    if (tool === 'fight_mob') {
        const target = options.bot?.entities?.[args.entityId];
        return !target || target.isValid === false
            ? passed('Hostile entity was removed from the world', { entityId: args.entityId })
            : failed('Hostile entity is still alive', { entityId: args.entityId });
    }
    if (tool === 'fight_player') {
        const result = options.executionResult || {};
        const mode = args.mode === 'lethal' ? 'lethal' : 'duel';
        const accepted = mode === 'lethal'
            ? ['target_defeated']
            : ['target_defeated', 'duel_complete', 'stopped_critical', 'stopped_target_critical'];
        return accepted.includes(result.status)
            ? passed(`Player combat finished with ${result.status}`, result)
            : failed(`Player combat did not reach a valid ${mode} outcome`, result);
    }
    if (tool === 'evade_hostile') {
        const beforeTarget = before.entities?.[args.entityId];
        const afterTarget = after.entities?.[args.entityId];
        const beforeDistance = beforeTarget ? distanceBetween(before.position, beforeTarget.position) : Infinity;
        const afterDistance = afterTarget ? distanceBetween(after.position, afterTarget.position) : Infinity;
        return !afterTarget || afterDistance >= 12 || afterDistance >= beforeDistance + 3
            ? passed(`Hostile separation changed ${formatDistance(beforeDistance)}->${formatDistance(afterDistance)}`, { beforeDistance, afterDistance })
            : failed('Evade did not create safe separation', { beforeDistance, afterDistance });
    }
    if (tool === 'emergency_shelter') {
        const sheltered = safe(() => require('../skills/survival').isEmergencyShelter(options.bot), false);
        return sheltered ? passed('Emergency shelter geometry is sealed') : failed('Emergency shelter was not verified');
    }
    if (tool === 'escape_pit') {
        const rise = Number(after.position?.y || 0) - Number(before.position?.y || 0);
        const moved = distanceBetween(before.position, after.position);
        const stillTrapped = safe(() => require('../skills/survival').isInPit(options.bot), true);
        const surfaceExit = memory.getSurfaceExit();
        const reachedExit = surfaceExit && Number(after.position?.y || 0) >= Number(surfaceExit.y) - 0.1;
        return !stillTrapped || reachedExit
            ? passed(`Pit exit verified after moving ${moved.toFixed(2)} blocks with ${rise.toFixed(2)} Y gain`, { rise, moved, reachedExit })
            : failed('Bot moved but remains inside pit geometry', { rise, moved, stillTrapped });
    }
    if (tool === 'recover_items') {
        const gained = inventoryTotal(after.inventory) - inventoryTotal(before.inventory);
        return options.executionResult === true && gained > 0
            ? passed(`Recovered ${gained} dropped items`, { gained })
            : failed('Dropped-item recovery was not confirmed', { gained });
    }
    if (tool === 'escape_water') {
        const needsAir = safe(() => require('../skills/survival').needsAir(options.bot), true);
        return !needsAir && after.oxygen > 0
            ? passed(`Reached breathable water state with oxygen ${after.oxygen}`, { oxygen: after.oxygen })
            : failed('Bot still needs air after water escape', { oxygenBefore: before.oxygen, oxygenAfter: after.oxygen });
    }
    if (tool === 'wait_safe') {
        const requested = Math.max(0, Number(args.ms || 1000));
        const elapsed = after.timestamp - before.timestamp;
        return options.executionResult?.status === 'waited' && elapsed >= Math.max(0, requested - 100)
            ? passed(`Waited ${elapsed}ms`, { elapsed, requested })
            : failed('Safe wait duration was not confirmed', { elapsed, requested });
    }
    if (tool === 'execute_dynamic_skill') {
        const result = options.executionResult || {};
        const assertions = Array.isArray(result.assertions) ? result.assertions : [];
        return result.status === 'verified' && result.skillId === args.skillId &&
            assertions.length > 0 && assertions.every(assertion => assertion.ok)
            ? passed(`Dynamic skill ${args.skillId} passed ${assertions.length} world assertions`, result)
            : failed(`Dynamic skill ${args.skillId} did not produce verified world state`, result);
    }
    if (tool === 'secure_bed') {
        const bed = findNearbyBed(options.bot, 16);
        return bed
            ? passed(`Bed exists in world at ${bed.position.toString()}`, { position: vector(bed.position) })
            : failed('No placed bed was found near the bot');
    }
    if (tool === 'sleep_bed') {
        return after.isDay && !after.isSleeping
            ? passed('Sleep completed and world time is daytime')
            : failed('Sleep did not advance the world to daytime', { isDay: after.isDay, isSleeping: after.isSleeping });
    }
    if (tool === 'find_food') {
        const gained = totalByPredicate(after.inventory, isEdible) -
            totalByPredicate(before.inventory, isEdible);
        const moved = distanceBetween(before.position, after.position);
        const result = options.executionResult || {};
        if (gained > 0) return passed(`Food inventory increased by ${gained}`, { gained, result });
        if (moved >= 2 && ['searched', 'unavailable'].includes(result.status)) {
            return passed(`Food search moved ${moved.toFixed(2)} blocks`, { moved, result });
        }
        return failed('Food search produced no inventory or exploration progress', { gained, moved, result });
    }
    if (tool === 'maintain_food_supply') {
        const foodBefore = totalByPredicate(before.inventory, isEdible);
        const foodAfter = totalByPredicate(after.inventory, isEdible);
        const minimum = args.minimum == null ? 0 : Math.max(1, Number(args.minimum || 1));
        const result = options.executionResult || {};
        if (minimum > 0) {
            return foodAfter >= minimum
                ? passed(`Food reserve reached ${foodAfter}/${minimum}`, { result, foodAfter, minimum })
                : failed(`Food reserve is only ${foodAfter}/${minimum}`, { result, foodBefore, foodAfter, minimum });
        }
        if (foodAfter >= 16 || foodAfter > foodBefore) {
            return passed(`Food reserve changed ${foodBefore}->${foodAfter}`, { result });
        }
        if (result.status === 'farm_expanded' && Number(result.planted || 0) > 0) {
            return passed(`Food farm expanded by ${result.planted} crops`, result);
        }
        const growing = safe(() => require('../skills/homestead').growingCropCount(options.bot), 0);
        return result.status === 'crops_growing' && growing > 0
            ? passed(`Verified ${growing} growing food crops`, { growing })
            : failed('Food maintenance changed neither reserve nor farm state', { result, foodBefore, foodAfter });
    }
    if (tool === 'fish') {
        const gained = totalByPredicate(after.inventory, isFish) - totalByPredicate(before.inventory, isFish);
        return gained > 0 ? passed(`Caught ${gained} fish`, { gained }) : failed('Fish inventory did not increase');
    }
    if (tool === 'establish_wheat_farm') {
        const result = options.executionResult || {};
        const ready = safe(() => require('../skills/homestead').hasFarm(options.bot), false);
        return result.planted >= 6 && result.capacity >= 6 && ready
            ? passed(`Hydrated farm validated with ${result.planted} planted crops`, result)
            : failed('Farm world state did not reach six planted hydrated plots', result);
    }
    if (tool === 'care_for_animals') {
        const result = options.executionResult || {};
        const feedSpent = totalByPredicate(before.inventory, isAnimalFeed) -
            totalByPredicate(after.inventory, isAnimalFeed);
        return result.fed >= 2 && feedSpent >= 2
            ? passed(`Fed ${result.fed} ${result.species}`, { ...result, feedSpent })
            : failed('Animal feeding was not confirmed by interaction and inventory change', { ...result, feedSpent });
    }
    if (tool === 'mine_iron') {
        const gained = count(after.inventory, 'raw_iron') - count(before.inventory, 'raw_iron');
        return gained > 0 ? passed(`Mined ${gained} raw iron`, { gained }) : failed('Raw iron did not increase');
    }
    if (tool === 'smelt_item') {
        const output = args.output;
        const gained = count(after.inventory, output) - count(before.inventory, output);
        return output && gained >= Math.max(1, Number(args.count || 1))
            ? passed(`Smelted ${gained} ${output}`, { gained, output })
            : failed(`Smelting did not increase ${output || 'the requested output'}`, { gained, output });
    }
    if (tool === 'prepare_mining_kit') {
        const inventory = after.inventory || {};
        const hasPickaxe = count(inventory, 'stone_pickaxe') + count(inventory, 'iron_pickaxe') > 0;
        const support = count(inventory, 'cobblestone') + count(inventory, 'dirt');
        const furnaceReady = count(inventory, 'furnace') > 0 || safe(() => Boolean(options.bot.findBlock({
            matching: options.bot.registry.blocksByName.furnace?.id,
            maxDistance: 16
        })), false);
        return hasPickaxe && count(inventory, 'torch') >= 16 && support >= 16 && furnaceReady
            ? passed('Mining kit has pickaxe, furnace, torches, and support blocks')
            : failed('Mining kit remains incomplete', { hasPickaxe, torches: count(inventory, 'torch'), support, furnaceReady });
    }
    if (tool === 'craft_iron_kit') {
        const missing = ['iron_pickaxe', 'iron_sword', 'iron_axe', 'shield']
            .filter(name => count(after.inventory, name) < 1 && !after.equipment.includes(name));
        return missing.length === 0 ? passed('Full iron tool kit exists') : failed(`Missing iron kit: ${missing.join(', ')}`);
    }
    if (tool === 'craft_iron_armor') {
        const armor = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
        const missing = armor.filter(name => count(after.inventory, name) < 1 && !after.equipment.includes(name));
        return missing.length === 0 ? passed('Full iron armor exists or is equipped') : failed(`Missing iron armor: ${missing.join(', ')}`);
    }
    if (tool === 'build_blueprint') {
        const result = options.executionResult || {};
        return result.verified && String(result.name).toLowerCase() === String(args.name).toLowerCase() && result.matched === result.expected
            ? passed(`Blueprint ${result.name} verified ${result.matched}/${result.expected}`, result)
            : failed('Blueprint world blocks were not fully verified', result);
    }
    if (tool === 'build_showcase') {
        const result = options.executionResult || {};
        return result.verified && result.verifiedBlueprints === result.expectedBlueprints
            ? passed(`Showcase verified ${result.verifiedBlueprints} blueprints`, result)
            : failed('Showcase world blocks were not fully verified', result);
    }
    if (tool === 'replant_sapling') {
        const spent = totalByPredicate(before.inventory, name => name.endsWith('_sapling')) -
            totalByPredicate(after.inventory, name => name.endsWith('_sapling'));
        const block = options.executionResult;
        const visible = block?.position && block.name?.endsWith('_sapling') &&
            options.bot?.blockAt(block.position)?.name === block.name;
        return spent > 0 && visible
            ? passed('A sapling left inventory and exists in world state', { spent, position: vector(block.position) })
            : failed('No planted sapling was verified in world state', { spent });
    }
    if (tool === 'deposit_shared_storage') {
        const moved = count(before.inventory, args.item) - count(after.inventory, args.item);
        const stored = count(after.sharedInventory, args.item) - count(before.sharedInventory, args.item);
        const result = Number(options.executionResult || 0);
        return moved > 0 && stored > 0 && result > 0
            ? passed(`Deposited ${Math.min(moved, stored, result)} ${args.item} into shared storage`, { moved, stored, result })
            : failed(`Shared deposit was not confirmed for ${args.item}`, { moved, stored, result });
    }
    if (tool === 'withdraw_shared_storage') {
        const gained = count(after.inventory, args.item) - count(before.inventory, args.item);
        const storedDelta = count(before.sharedInventory, args.item) - count(after.sharedInventory, args.item);
        const result = Number(options.executionResult || 0);
        return gained > 0 && storedDelta > 0 && result > 0
            ? passed(`Withdrew ${Math.min(gained, storedDelta, result)} ${args.item} from shared storage`, { gained, storedDelta, result })
            : failed(`Shared withdrawal was not confirmed for ${args.item}`, { gained, storedDelta, result });
    }
    if (tool === 'ensure_shared_storage') {
        const block = options.executionResult;
        return block?.name === 'chest'
            ? passed('Shared storage chest exists in the world', { position: vector(block.position) })
            : failed('Shared storage did not return a world chest block');
    }
    if (tool === 'count_shared_storage') {
        const result = options.executionResult || {};
        return sameCounts(result, after.sharedInventory)
            ? passed('Shared storage inventory count confirmed', { inventory: result })
            : failed('Shared storage inventory count did not match memory', { expected: after.sharedInventory, result });
    }
    if (tool === 'build_colony_marker') {
        const placed = Number(options.executionResult || 0);
        const project = colonyMemory.load().projects.find(entry => entry.id === 'survival_marker');
        return placed > 0 && project && ['partial', 'complete'].includes(project.status)
            ? passed(`Colony marker placed ${placed} validated blocks`, { placed, projectStatus: project.status })
            : failed('Colony marker world state was not confirmed', { placed });
    }
    if (tool === 'follow_player') {
        const result = options.executionResult || {};
        const target = after.players?.[args.username];
        const distance = target ? distanceBetween(after.position, target.position) : Number(result.distance ?? Infinity);
        const accepted = Math.max(2, Number(args.range || 3)) + 1.5;
        return ['near', 'tracking'].includes(result.status) && distance <= accepted
            ? passed(`Following ${args.username} within ${distance.toFixed(2)} blocks`, { distance, accepted })
            : failed(`Follow target was not reached within ${accepted} blocks`, { distance, result });
    }
    return failed(`Tool ${tool} has no task verification contract`);
}

function supports(tool) {
    return VERIFIED_TOOLS.has(tool);
}

function inventoryNamesForBlock(target) {
    if (target === 'any_log') return ['*_log'];
    const map = {
        stone: ['cobblestone'],
        coal_ore: ['coal'],
        deepslate_coal_ore: ['coal'],
        iron_ore: ['raw_iron'],
        deepslate_iron_ore: ['raw_iron']
    };
    return map[target] || [target];
}

function total(inventory, names) {
    return names.reduce((sum, name) => name.startsWith('*')
        ? sum + totalByPredicate(inventory, itemName => itemName.endsWith(name.slice(1)))
        : sum + count(inventory, name), 0);
}

function totalByPredicate(inventory, predicate) {
    return Object.entries(inventory || {}).filter(([name]) => predicate(name))
        .reduce((sum, [, amount]) => sum + Number(amount || 0), 0);
}

function count(inventory, name) {
    return Number(inventory?.[name] || 0);
}

function sameCounts(left, right) {
    const names = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
    return [...names].every(name => count(left, name) === count(right, name));
}

function countInventory(bot) {
    const result = {};
    for (const item of bot?.inventory?.items?.() || bot?.inventory?.slots?.filter(Boolean) || []) {
        result[item.name] = (result[item.name] || 0) + item.count;
    }
    return result;
}

function inventoryTotal(inventory) {
    return Object.values(inventory || {}).reduce((sum, amount) => sum + Number(amount || 0), 0);
}

function captureEntities(bot) {
    const result = {};
    for (const entity of Object.values(bot?.entities || {})) {
        if (!entity?.id || !entity.position || entity === bot.entity) continue;
        result[entity.id] = {
            name: entity.name || entity.username || entity.type,
            position: vector(entity.position)
        };
    }
    return result;
}

function capturePlayers(bot) {
    const result = {};
    for (const [username, entry] of Object.entries(bot?.players || {})) {
        if (entry?.entity?.position) result[username] = { position: vector(entry.entity.position) };
    }
    return result;
}

function captureEquipment(bot) {
    return (bot?.entity?.equipment || []).map(item => item?.name).filter(Boolean);
}

function vector(position) {
    return position ? { x: Number(position.x), y: Number(position.y), z: Number(position.z) } : null;
}

function distanceBetween(left, right) {
    if (!left || !right) return Infinity;
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function formatDistance(value) {
    return Number.isFinite(value) ? value.toFixed(2) : 'unavailable';
}

function isFish(name) {
    return ['cod', 'salmon', 'tropical_fish', 'pufferfish'].includes(name);
}

function isEdible(name) {
    return [
        'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton',
        'cooked_chicken', 'cooked_cod', 'cooked_salmon', 'beef',
        'porkchop', 'mutton', 'chicken', 'cod', 'salmon', 'apple',
        'carrot', 'potato', 'baked_potato'
    ].includes(name);
}

function isAnimalFeed(name) {
    return ['wheat', 'carrot', 'potato', 'beetroot', 'wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'dandelion'].includes(name);
}

function findNearbyBed(bot, maxDistance) {
    if (!bot?.registry?.blocksByName || typeof bot.findBlocks !== 'function') return null;
    const ids = Object.values(bot.registry.blocksByName)
        .filter(block => block.name.endsWith('_bed'))
        .map(block => block.id);
    if (ids.length === 0) return null;
    return bot.findBlocks({ matching: ids, maxDistance, count: 8 })
        .map(position => bot.blockAt(position))
        .find(Boolean) || null;
}

function passed(reason, details = {}) {
    return { ok: true, reason, details };
}

function failed(reason, details = {}) {
    return { ok: false, reason, details };
}

function safe(fn, fallback) {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

module.exports = { capture, verify, supports, TaskVerificationError };
