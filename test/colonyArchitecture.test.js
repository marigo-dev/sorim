const assert = require('node:assert/strict');

const ColonyBlackboard = require('../agent/colonyBlackboard');
const ColonyScheduler = require('../agent/colonyScheduler');
const ColonyBrain = require('../agent/colonyBrain');
const CharacterRegistry = require('../characters/characterRegistry');
const { createColonyBodyTree } = require('../agent/behaviorTree/colonyBodyTree');

let now = 1000;
let state = { leases: {}, workOrders: [], characters: {} };
const store = {
    load: () => JSON.parse(JSON.stringify(state)),
    save: value => { state = JSON.parse(JSON.stringify(value)); }
};

const characters = new CharacterRegistry(store, {
    now: () => new Date(now).toISOString()
});
characters.ensureDefaults();
const mico = characters.resolveAddress('Miço, bugün odun toplar mısın?');
assert.equal(mico.username, 'Bot_Mico');
assert.equal(characters.resolveAddress('Herkes buraya gelsin'), null);
assert.equal(characters.byUsername('bot_mico').shortName, 'Mico');

const blackboard = new ColonyBlackboard({ now: () => now, agentTtlMs: 5000 });
blackboard.publish('citizen_mico', {
    health: 20,
    food: 10,
    position: { x: 0, y: 64, z: 0 },
    inventory: { oak_log: 4, dirt: 2 },
    nearbyMobs: [{ name: 'zombie', distance: 7 }],
    base: null
}, { username: 'Bot_Mico', profession: 'lumberjack' });
blackboard.publish('citizen_mira', {
    health: 18,
    food: 20,
    position: { x: 4, y: 64, z: 0 },
    inventory: { cobblestone: 8 },
    base: { x: 0, y: 64, z: 0 }
}, { username: 'Bot_Mira', profession: 'miner' });
assert.deepEqual(blackboard.snapshot().shortages.hungryAgents, ['citizen_mico']);
assert.deepEqual(blackboard.snapshot().shortages.agentsWithoutBase, ['citizen_mico']);
assert.equal(blackboard.snapshot().totals.cobblestone, 8);

const scheduler = new ColonyScheduler(store, { now: () => now, leaseTtlMs: 5000 });
const brain = new ColonyBrain({ scheduler, blackboard, now: () => now, minimumPlanIntervalMs: 1 });

(async () => {
    const bodyDecision = await createColonyBodyTree().tick({
        safetyCall: { tool: 'escape_water', args: {} },
        workCall: { tool: 'mine_block', args: { target: 'any_log' } }
    });
    assert.equal(bodyDecision.value.source, 'safety');

    let guardedState = { leases: {}, workOrders: [] };
    const guardedStore = {
        load: () => JSON.parse(JSON.stringify(guardedState)),
        save: value => { guardedState = JSON.parse(JSON.stringify(value)); }
    };
    const guardedBoard = new ColonyBlackboard({ now: () => now });
    guardedBoard.publish('mico', { inventory: { bread: 8 }, base: { x: 0, y: 64, z: 0 }, position: { x: 0, y: 64, z: 0 } }, { profession: 'lumberjack' });
    guardedBoard.publish('mira', { inventory: { bread: 8 }, base: { x: 0, y: 64, z: 0 }, position: { x: 1, y: 64, z: 0 } }, { profession: 'miner' });
    const guardedBrain = new ColonyBrain({
        scheduler: new ColonyScheduler(guardedStore, { now: () => now }),
        blackboard: guardedBoard,
        now: () => now,
        minimumPlanIntervalMs: 1,
        planWithLlm: async () => ({ orders: [{
            tool: 'prepare_mining_kit', args: {}, priority: 80,
            professions: ['lumberjack'], reason: 'wrong model assignment', dedupeKey: 'kit'
        }] })
    });
    const guardedPlan = await guardedBrain.plan({ force: true });
    assert.deepEqual(guardedPlan.created[0].professions, ['miner']);

    const plan = await brain.plan({ force: true });
    assert.ok(plan.created.some(order => order.dedupeKey === 'stock:cobblestone'));
    assert.ok(plan.created.some(order => order.dedupeKey === 'stock:logs'));
    assert.ok(plan.created.some(order => order.dedupeKey === 'colony:food_emergency'));

    scheduler.enqueue({
        id: 'exclusive_tree',
        tool: 'mine_block',
        args: { target: 'oak_log' },
        professions: ['lumberjack'],
        reservations: [{ key: 'tree:10,64,10' }],
        priority: 100
    });
    const duplicate = scheduler.enqueue({
        id: 'duplicate_tree',
        dedupeKey: 'exclusive_tree_resource',
        tool: 'mine_block',
        args: { target: 'oak_log' },
        priority: 99
    });
    const duplicateAgain = scheduler.enqueue({
        id: 'duplicate_tree_second',
        dedupeKey: 'llm_changed_its_label',
        tool: 'mine_block',
        args: { target: 'oak_log' },
        priority: 99
    });
    assert.equal(duplicateAgain.id, duplicate.id);
    const assigned = scheduler.dispatch({ id: 'citizen_mico', profession: 'lumberjack', status: 'running' });
    assert.equal(assigned.order.id, 'exclusive_tree');
    const otherWork = scheduler.dispatch({ id: 'citizen_other', profession: 'lumberjack', status: 'running' });
    assert.notEqual(otherWork?.order.id, 'exclusive_tree');
    assert.equal(state.leases['work:exclusive_tree'].owner, 'citizen_mico');
    assert.equal(state.leases['resource:tree:10,64,10'].owner, 'citizen_mico');

    now = 3000;
    assert.equal(scheduler.heartbeat('exclusive_tree', 'citizen_mico').expiresAt, 8000);
    assert.equal(scheduler.disconnect('citizen_mico'), 1);
    const reassigned = scheduler.dispatch({ id: 'citizen_replacement', profession: 'lumberjack', status: 'running' });
    assert.equal(reassigned.order.id, 'exclusive_tree');
    assert.equal(reassigned.order.assignedTo, 'citizen_replacement');

    const complete = scheduler.complete('exclusive_tree', 'citizen_replacement', { gained: 6 });
    assert.equal(complete.status, 'complete');
    assert.equal(complete.evidence.gained, 6);
    assert.equal(state.leases['work:exclusive_tree'], undefined);
    assert.equal(state.leases['resource:tree:10,64,10'], undefined);

    const cancelled = scheduler.cancel(otherWork.order.id, 'test cleanup');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(state.leases[`work:${otherWork.order.id}`], undefined);

    console.log('Central blackboard, brain, scheduler failover, reservations, and Mico routing passed.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
