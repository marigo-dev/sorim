const actionControl = require('./actionControl');
const entityActions = require('./entityActions');
const movement = require('./movement');
const tools = require('./tools');

const DUEL_STRIKE_LIMIT = 3;
const LETHAL_STRIKE_LIMIT = 40;

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
    await equipCombatKit(bot);
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
                return result('stopped_critical', target.username, mode, strikes, bot.health);
            }
            throw new Error(`Lethal combat stopped at critical health ${bot.health}`);
        }

        const targetHealth = readEntityHealth(live);
        if (mode === 'duel' && targetHealth !== null && targetHealth <= criticalHealth) {
            return result('stopped_target_critical', target.username, mode, strikes, bot.health, targetHealth);
        }

        const distance = live.position.distanceTo(bot.entity.position);
        if (distance > 40) throw new Error(`Player ${target.username} escaped combat range`);
        if (distance > 3.05) {
            await movement.followPlayer(bot, target.username, { range: 2.4, durationMs: 1100 });
            continue;
        }

        await bot.lookAt(live.position.offset(0, 1.35, 0), true);
        entityActions.attack(bot, live);
        strikes++;
        console.log(`[COMBAT] strike=${strikes} target=${target.username} distance=${distance.toFixed(2)}`);
        await combatFootwork(bot, strikes);
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

async function equipCombatKit(bot) {
    await tools.equipBestWeapon(bot);
    const shield = bot.inventory?.items?.().find(item => item.name === 'shield');
    if (!shield) return;
    try {
        await bot.equip(shield, 'off-hand');
    } catch {
        // Combat remains usable on protocol variants without off-hand support.
    }
}

async function combatFootwork(bot, strikes) {
    const control = strikes % 2 === 0 ? 'left' : 'right';
    try {
        bot.setControlState('sprint', false);
        bot.setControlState(control, true);
        await movement.sleep(140);
    } finally {
        bot.setControlState(control, false);
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
    attackCooldown
};
