const actionControl = require('./actionControl');
const entityActions = require('./entityActions');
const movement = require('./movement');
const tools = require('./tools');

const DUEL_STRIKE_LIMIT = 3;
const LETHAL_STRIKE_LIMIT = 40;
const BOW_MIN_RANGE = 6;
const MAX_COMBAT_RANGE = 40;

async function fightPlayer(bot, requestedUsername, options = {}) {
    const mode = options.mode === 'lethal' ? 'lethal' : 'duel';
    const criticalHealth = clamp(Number(options.criticalHealth || 6), 2, 12);
    const actionVersion = actionControl.snapshot(bot);
    const target = resolvePlayer(bot, requestedUsername);
    if (!target?.entity) throw new Error(`Player ${requestedUsername} is not visible`);
    if (target.username.toLowerCase() === String(bot.username || '').toLowerCase()) {
        throw new Error('The bot cannot target itself');
    }

    const targetId = target.entity.id;
    const startedAt = Date.now();
    const deadline = startedAt + (mode === 'lethal' ? 90000 : 30000);
    const strikeLimit = mode === 'lethal' ? LETHAL_STRIKE_LIMIT : DUEL_STRIKE_LIMIT;
    let strikes = 0;
    await equipShield(bot);
    console.log(`[COMBAT] mode=${mode} target=${target.username}`);

    while (Date.now() < deadline && strikes < strikeLimit) {
        actionControl.assertActive(bot, actionVersion);
        const live = resolveLiveTarget(bot, target.username, targetId);
        if (!live || live.isValid === false) {
            if (strikes > 0) {
                return result('target_defeated', target.username, mode, strikes, bot.health);
            }
            throw new Error(`Player ${target.username} left combat range`);
        }

        if (Number(bot.health || 0) <= criticalHealth) {
            if (mode === 'duel') {
                await tacticalRetreat(bot, live, 5);
                return result('stopped_critical', target.username, mode, strikes, bot.health);
            }
            await tacticalRetreat(bot, live, 7);
            throw new Error(`Lethal combat stopped at critical health ${bot.health}`);
        }

        const targetHealth = readEntityHealth(live);
        if (mode === 'duel' && targetHealth !== null && targetHealth <= criticalHealth) {
            return result('stopped_target_critical', target.username, mode, strikes, bot.health, targetHealth);
        }

        const distance = live.position.distanceTo(bot.entity.position);
        if (distance > MAX_COMBAT_RANGE) throw new Error(`Player ${target.username} escaped combat range`);
        const strategy = await chooseWeapon(bot, live, distance);
        if (strategy.type === 'bow') {
            await fireBow(bot, live, distance);
            strikes++;
            console.log(`[COMBAT] shot=${strikes} target=${target.username} distance=${distance.toFixed(2)}`);
            await movement.sleep(350);
            continue;
        }
        if (distance > 3.05) {
            await pursueTarget(bot, target.username, live);
            continue;
        }

        await lowerShield(bot);
        await bot.lookAt(live.position.offset(0, 1.35, 0), true);
        entityActions.attack(bot, live);
        strikes++;
        console.log(`[COMBAT] strike=${strikes} weapon=${strategy.item?.name || 'hand'} target=${target.username} distance=${distance.toFixed(2)}`);
        await combatFootwork(bot, live, strikes);
        await guardRecovery(bot, live, attackCooldown(strategy.item?.name));
        await movement.sleep(attackCooldown(bot.heldItem?.name));
    }

    const remaining = resolveLiveTarget(bot, target.username, targetId);
    if (!remaining || remaining.isValid === false) {
        return result('target_defeated', target.username, mode, strikes, bot.health);
    }
    if (mode === 'duel') {
        return result('duel_complete', target.username, mode, strikes, bot.health, readEntityHealth(remaining));
    }
    throw new Error(`Player ${target.username} survived ${strikes} strike attempts`);
}

async function equipShield(bot) {
    const shield = bot.inventory?.items?.().find(item => item.name === 'shield');
    if (!shield) return;
    try {
        await bot.equip(shield, 'off-hand');
    } catch {
        // Combat remains usable on protocol variants without off-hand support.
    }
}

async function chooseWeapon(bot, target, distance) {
    const items = inventoryItems(bot);
    const bow = items.find(item => item.name === 'bow');
    if (distance >= BOW_MIN_RANGE && bow && hasArrow(items) && hasLineOfSight(bot, target)) {
        await bot.equip(bow, 'hand');
        return { type: 'bow', item: bow };
    }

    const shielded = targetUsesShield(target);
    const preferredNames = shielded
        ? weaponNames('_axe').concat(weaponNames('_sword'))
        : weaponNames('_sword').concat(weaponNames('_axe'));
    const weapon = preferredNames.map(name => items.find(item => item.name === name)).find(Boolean);
    if (weapon) await bot.equip(weapon, 'hand');
    else await tools.equipBestWeapon(bot);
    return { type: 'melee', item: weapon || bot.heldItem || null, shieldedTarget: shielded };
}

async function pursueTarget(bot, username, target) {
    const distance = target.position.distanceTo(bot.entity.position);
    if (distance <= 8 && safeForwardStep(bot, target.position)) {
        try {
            await bot.lookAt(target.position.offset(0, 1.2, 0), true);
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
            bot.setControlState('jump', frontBlocked(bot));
            await movement.sleep(450);
            return;
        } finally {
            bot.setControlState('forward', false);
            bot.setControlState('sprint', false);
            bot.setControlState('jump', false);
        }
    }
    await movement.followPlayer(bot, username, { range: 2.4, durationMs: 1100 });
}

async function fireBow(bot, target, distance) {
    const velocity = target.velocity || { x: 0, y: 0, z: 0 };
    const lead = Math.min(1.2, distance / 18);
    const aim = target.position.offset(
        Number(velocity.x || 0) * lead,
        1.35 + Math.min(1.1, distance * 0.018),
        Number(velocity.z || 0) * lead
    );
    await lowerShield(bot);
    await bot.lookAt(aim, true);
    bot.activateItem(false);
    await movement.sleep(clamp(650 + distance * 18, 700, 1100));
    const liveAim = target.position.offset(0, 1.35 + Math.min(1.1, distance * 0.018), 0);
    await bot.lookAt(liveAim, true);
    bot.deactivateItem();
}

async function combatFootwork(bot, target, strikes) {
    const control = strikes % 2 === 0 ? 'left' : 'right';
    if (!safeStrafeStep(bot, target.position, control)) return;
    try {
        bot.setControlState('sprint', false);
        bot.setControlState(control, true);
        await movement.sleep(140);
    } finally {
        bot.setControlState(control, false);
    }
}

async function guardRecovery(bot, target, cooldownMs) {
    if (!hasShield(bot) || target.position.distanceTo(bot.entity.position) > 4.5) {
        await movement.sleep(Math.min(300, cooldownMs));
        return;
    }
    try {
        bot.activateItem(true);
        await movement.sleep(Math.min(420, Math.max(180, cooldownMs - 150)));
    } finally {
        bot.deactivateItem();
    }
}

async function lowerShield(bot) {
    try {
        bot.deactivateItem();
    } catch {
        // No active item use.
    }
}

async function tacticalRetreat(bot, target, desiredDistance) {
    const origin = bot.entity.position.floored();
    const dx = origin.x - target.position.x;
    const dz = origin.z - target.position.z;
    const length = Math.max(0.1, Math.hypot(dx, dz));
    const candidates = [desiredDistance, Math.max(3, desiredDistance - 2)].map(distance =>
        origin.offset(Math.round(dx / length * distance), 0, Math.round(dz / length * distance))
    ).filter(position => isSafeStand(bot, position));
    if (candidates[0]) {
        try {
            await movement.moveNear(bot, candidates[0], 1, 4500);
            return;
        } catch {
            movement.stop(bot);
        }
    }
    const fallback = origin.offset(Math.round(dx / length), 0, Math.round(dz / length));
    if (!isSafeStand(bot, fallback)) {
        movement.stop(bot);
        return;
    }
    try {
        await bot.lookAt(target.position.offset(0, 1.2, 0), true);
        bot.setControlState('back', true);
        bot.setControlState('sprint', true);
        await movement.sleep(550);
    } finally {
        bot.setControlState('back', false);
        bot.setControlState('sprint', false);
    }
}

function resolvePlayer(bot, requestedUsername) {
    const wanted = String(requestedUsername || '').toLowerCase();
    const entry = Object.entries(bot.players || {})
        .find(([username]) => username.toLowerCase() === wanted);
    return entry ? { username: entry[0], entity: entry[1]?.entity || null } : null;
}

function resolveLiveTarget(bot, username, entityId) {
    return resolvePlayer(bot, username)?.entity || bot.entities?.[entityId] || null;
}

function readEntityHealth(entity) {
    const value = Number(entity?.health);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function attackCooldown(itemName) {
    return String(itemName || '').endsWith('_axe') ? 1050 : 650;
}

function weaponNames(suffix) {
    return ['netherite', 'diamond', 'iron', 'stone', 'wooden'].map(tier => `${tier}${suffix}`);
}

function inventoryItems(bot) {
    return bot.inventory?.items?.() || bot.inventory?.slots?.filter(Boolean) || [];
}

function hasArrow(items) {
    return items.some(item => ['arrow', 'spectral_arrow', 'tipped_arrow'].includes(item.name));
}

function hasShield(bot) {
    return inventoryItems(bot).some(item => item.name === 'shield');
}

function targetUsesShield(target) {
    return (target?.equipment || []).some(item => item?.name === 'shield');
}

function hasLineOfSight(bot, target) {
    if (typeof bot.canSeeEntity !== 'function') return true;
    try {
        return bot.canSeeEntity(target);
    } catch {
        return true;
    }
}

function safeForwardStep(bot, targetPosition) {
    const origin = bot.entity.position;
    const dx = targetPosition.x - origin.x;
    const dz = targetPosition.z - origin.z;
    const length = Math.max(0.1, Math.hypot(dx, dz));
    return isSafeStand(bot, origin.floored().offset(Math.round(dx / length), 0, Math.round(dz / length)));
}

function safeStrafeStep(bot, targetPosition, control) {
    const origin = bot.entity.position;
    const dx = targetPosition.x - origin.x;
    const dz = targetPosition.z - origin.z;
    const length = Math.max(0.1, Math.hypot(dx, dz));
    const sign = control === 'left' ? -1 : 1;
    return isSafeStand(bot, origin.floored().offset(
        Math.round(-dz / length * sign),
        0,
        Math.round(dx / length * sign)
    ));
}

function isSafeStand(bot, position) {
    const feet = bot.blockAt?.(position);
    const head = bot.blockAt?.(position.offset(0, 1, 0));
    const floor = bot.blockAt?.(position.offset(0, -1, 0));
    const names = [feet?.name, head?.name, floor?.name];
    return isPassable(feet) && isPassable(head) && floor?.boundingBox === 'block' &&
        !names.some(name => ['lava', 'fire', 'soul_fire', 'cactus', 'magma_block'].includes(name));
}

function isPassable(block) {
    return !block || ['air', 'cave_air', 'void_air'].includes(block.name) || block.boundingBox === 'empty';
}

function frontBlocked(bot) {
    const yaw = bot.entity.yaw;
    const dx = Math.round(-Math.sin(yaw));
    const dz = Math.round(-Math.cos(yaw));
    return bot.blockAt(bot.entity.position.floored().offset(dx, 0, dz))?.boundingBox === 'block';
}

function result(status, username, mode, strikes, botHealth, targetHealth = null) {
    return { status, username, mode, strikes, botHealth, targetHealth };
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

module.exports = {
    fightPlayer,
    resolvePlayer,
    readEntityHealth,
    attackCooldown,
    chooseWeapon,
    targetUsesShield,
    isSafeStand,
    pursueTarget,
    guardRecovery,
    tacticalRetreat
};
