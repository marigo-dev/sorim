const memory = require('../skills/memory');
const shelter = require('../skills/shelter');
const storage = require('../skills/storage');
const colonyMemory = require('../skills/colonyMemory');
const { Vec3 } = require('vec3');

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
        hasUsableChest: observation?.hasUsableChest ?? safe(() => storage.hasChestNearby(bot), false),
        sharedInventory: { ...(colonyMemory.load().sharedStorage?.inventory || {}) }
    };
}

function verify(call, before, after, options = {}) {
    const tool = call?.tool;
    const args = call?.args || {};
    if (!tool) return failed('Missing tool call');

    if (tool === 'mine_block') {
        const names = inventoryNamesForBlock(args.target);
        const gained = total(after.inventory, names) - total(before.inventory, names);
        return gained > 0
            ? passed(`Collected ${gained} ${names.join('/')}`, { gained })
            : failed(`Inventory did not gain a drop for ${args.target}`, { gained });
    }
    if (tool === 'craft_item') {
        const gained = count(after.inventory, args.item) - count(before.inventory, args.item);
        return gained >= Math.max(1, Number(args.count || 1))
            ? passed(`Crafted ${gained} ${args.item}`, { gained })
            : failed(`Expected ${args.item} inventory to increase`, { gained });
    }
    if (tool === 'collect_stone') {
        const gained = count(after.inventory, 'cobblestone') - count(before.inventory, 'cobblestone');
        return gained > 0 ? passed(`Collected ${gained} cobblestone`, { gained }) : failed('Cobblestone did not increase');
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
        const tablePosition = basePosition.offset(1, 0, 0);
        const hasInteriorTable = options.bot?.blockAt(tablePosition)?.name === 'crafting_table';
        if (!hasInteriorTable) return failed('Base has no verified interior crafting table');
        const shellScore = options.executionResult?.shellScore ?? safe(
            () => shelter.scoreShelterShell(options.bot, base),
            0
        );
        return shellScore >= 18
            ? passed(`Base remembered and shell validated ${shellScore}/22`, { shellScore })
            : failed(`Base shell validation failed ${shellScore}/22`, { shellScore });
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
    if (tool === 'secure_bed') {
        const bed = findNearbyBed(options.bot, 16);
        return bed
            ? passed(`Bed exists in world at ${bed.position.toString()}`, { position: vector(bed.position) })
            : failed('No placed bed was found near the bot');
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
    if (tool === 'replant_sapling') {
        const spent = totalByPredicate(before.inventory, name => name.endsWith('_sapling')) -
            totalByPredicate(after.inventory, name => name.endsWith('_sapling'));
        return spent > 0 ? passed('A sapling left inventory for planting', { spent }) : failed('No sapling was planted');
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
    if (tool === 'build_colony_marker') {
        const placed = Number(options.executionResult || 0);
        const project = colonyMemory.load().projects.find(entry => entry.id === 'survival_marker');
        return placed > 0 && project && ['partial', 'complete'].includes(project.status)
            ? passed(`Colony marker placed ${placed} validated blocks`, { placed, projectStatus: project.status })
            : failed('Colony marker world state was not confirmed', { placed });
    }
    return passed(`Tool ${tool} completed without an exception`, { fallback: true });
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

function countInventory(bot) {
    const result = {};
    for (const item of bot?.inventory?.items?.() || bot?.inventory?.slots?.filter(Boolean) || []) {
        result[item.name] = (result[item.name] || 0) + item.count;
    }
    return result;
}

function vector(position) {
    return position ? { x: Number(position.x), y: Number(position.y), z: Number(position.z) } : null;
}

function distanceBetween(left, right) {
    if (!left || !right) return Infinity;
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
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

module.exports = { capture, verify, TaskVerificationError };
