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
