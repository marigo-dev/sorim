const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { parseCombatIntent } = require('../agent/combatIntent');
const combat = require('../skills/combat');
const movement = require('../skills/movement');
const taskVerifier = require('../agent/taskVerifier');
const actionControl = require('../skills/actionControl');

assert.deepEqual(
    parseCombatIntent('Marigo benimle savas', 'waterghost8', ['waterghost8']),
    { intent: 'combat', targetPlayer: 'waterghost8', combatMode: 'duel' }
);
assert.deepEqual(
    parseCombatIntent('Marigo olene kadar bana saldir', 'waterghost8', ['waterghost8']),
    { intent: 'combat', targetPlayer: 'waterghost8', combatMode: 'lethal' }
);
assert.deepEqual(
    parseCombatIntent('Marigo Steve oyuncusunu oldur', 'owner', ['owner', 'Steve']),
    { intent: 'combat', targetPlayer: 'Steve', combatMode: 'lethal' }
);
assert.deepEqual(
    parseCombatIntent('Marigo zombiyi oldur', 'owner', ['owner']),
    { intent: 'combat_mob', targetMob: 'zombie', combatMode: 'lethal' }
);
assert.deepEqual(
    parseCombatIntent('Marigo su yaratikla savas', 'owner', ['owner']),
    { intent: 'combat_mob', targetMob: null, combatMode: 'lethal' }
);
assert.equal(parseCombatIntent('Marigo eve don', 'owner', ['owner']), null);

const originalSleep = movement.sleep;
movement.sleep = async () => {};

(async () => {
    try {
        const lethalBot = fakeBot({ removeAfterStrikes: 2 });
        const lethal = await combat.fightPlayer(lethalBot, 'Target', { mode: 'lethal' });
        assert.equal(lethal.status, 'target_defeated');
        assert.equal(lethal.strikes, 2);

        const duelBot = fakeBot();
        const duel = await combat.fightPlayer(duelBot, 'target', { mode: 'duel' });
        assert.equal(duel.status, 'duel_complete');
        assert.equal(duel.strikes, 3);

        const criticalBot = fakeBot();
        criticalBot.health = 5;
        const critical = await combat.fightPlayer(criticalBot, 'Target', { mode: 'duel' });
        assert.equal(critical.status, 'stopped_critical');
        assert.equal(critical.strikes, 0);

        const cancelledBot = fakeBot({ cancelAfterStrikes: 1 });
        await assert.rejects(
            combat.fightPlayer(cancelledBot, 'Target', { mode: 'lethal' }),
            /Action cancelled: test stop command/
        );

        const rangedBot = fakeBot();
        rangedBot.inventory.slots.push({ name: 'bow', count: 1 }, { name: 'arrow', count: 8 });
        rangedBot.players.Target.entity.position = new Vec3(9, 64, 0);
        const ranged = await combat.chooseWeapon(rangedBot, rangedBot.players.Target.entity, 9);
        assert.equal(ranged.type, 'bow');
        assert.equal(rangedBot.heldItem.name, 'bow');

        const axeBot = fakeBot();
        axeBot.inventory.slots.push({ name: 'iron_axe', count: 1 });
        axeBot.players.Target.entity.equipment = [{ name: 'shield' }];
        const axe = await combat.chooseWeapon(axeBot, axeBot.players.Target.entity, 2);
        assert.equal(axe.type, 'melee');
        assert.equal(axe.item.name, 'iron_axe');

        const shieldBot = fakeBot();
        shieldBot.inventory.slots.push({ name: 'shield', count: 1 });
        let raisedOffhand = false;
        let lowered = false;
        shieldBot.activateItem = offhand => { raisedOffhand = offhand === true; };
        shieldBot.deactivateItem = () => { lowered = true; };
        await combat.guardRecovery(shieldBot, shieldBot.players.Target.entity, 650);
        assert.equal(raisedOffhand, true);
        assert.equal(lowered, true);

        const pursuitBot = fakeBot();
        pursuitBot.players.Target.entity.position = new Vec3(5, 64, 0);
        const controls = [];
        pursuitBot.blockAt = position => position.y <= 63
            ? { name: 'stone', boundingBox: 'block' }
            : { name: 'air', boundingBox: 'empty' };
        pursuitBot.setControlState = (name, value) => controls.push([name, value]);
        await combat.pursueTarget(pursuitBot, 'Target', pursuitBot.players.Target.entity);
        assert.equal(controls.some(([name, value]) => name === 'sprint' && value), true);

        assert.equal(taskVerifier.verify(
            { tool: 'fight_player', args: { username: 'Target', mode: 'lethal' } },
            {}, {}, { executionResult: lethal }
        ).ok, true);
        assert.equal(taskVerifier.verify(
            { tool: 'fight_player', args: { username: 'Target', mode: 'duel' } },
            {}, {}, { executionResult: duel }
        ).ok, true);
        assert.equal(taskVerifier.verify(
            { tool: 'fight_player', args: { username: 'Target', mode: 'lethal' } },
            {}, {}, { executionResult: duel }
        ).ok, false);

        console.log('Player combat intent, execution, and verification passed.');
    } finally {
        movement.sleep = originalSleep;
    }
})().catch(error => {
    movement.sleep = originalSleep;
    console.error(error);
    process.exitCode = 1;
});

function fakeBot(options = {}) {
    const target = { id: 42, username: 'Target', position: new Vec3(1.8, 64, 0), isValid: true };
    let strikes = 0;
    const bot = {
        username: 'marigo',
        health: 20,
        sorimActionVersion: 0,
        entity: { position: new Vec3(0, 64, 0) },
        players: { Target: { entity: target } },
        entities: { 42: target },
        inventory: {
            slots: [{ name: 'stone_sword', count: 1 }],
            items() { return this.slots.filter(Boolean); }
        },
        heldItem: null,
        supportFeature: feature => feature === 'attackUsesOwnPacket',
        _client: {
            write(name) {
                if (name !== 'attack') return;
                strikes++;
                if (options.cancelAfterStrikes && strikes >= options.cancelAfterStrikes) {
                    actionControl.cancel(bot, 'test stop command');
                }
                if (options.removeAfterStrikes && strikes >= options.removeAfterStrikes) {
                    target.isValid = false;
                    bot.players.Target.entity = null;
                    delete bot.entities[42];
                }
            }
        },
        async equip(item, destination) {
            if (destination === 'hand') this.heldItem = item;
        },
        async lookAt() {},
        swingArm() {},
        setControlState() {}
    };
    return bot;
}
