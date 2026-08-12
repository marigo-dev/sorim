const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');

const EventStream = require('../perception/eventStream');
const stateBuilder = require('../perception/stateBuilder');
const Blackboard = require('../agent/blackboard');
const persistentMemory = require('../agent/persistentMemory');
const TaskQueue = require('../agent/taskQueue');
const ProfessionManager = require('../professions/professionManager');
const blockPolicy = require('../safety/blockPolicy');
const baseSkill = require('../skills/base');
const worldMemory = require('../skills/memory');
const { createRootTree } = require('../agent/behaviorTree/rootTree');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sorim-agent-'));
const worldDirectory = path.join(directory, 'world');
const agentDirectory = path.join(directory, 'agent');

const events = new EventStream(16);
for (let index = 0; index < 24; index++) events.push('tick', { index }, index === 23 ? 0.9 : 0.1);
assert.equal(events.recent(100).length, 16);
assert.equal(events.recent(5, 0.8)[0].index, 23);

const bot = {
    health: 17,
    food: 13,
    oxygenLevel: 20,
    heldItem: { name: 'stone_pickaxe', count: 1 },
    entity: {
        position: new Vec3(10.7, 64, -3.2),
        velocity: new Vec3(0.1, 0, 0),
        onGround: true,
        isInWater: false
    },
    entities: {
        2: { id: 2, name: 'zombie', type: 'mob', position: new Vec3(14, 64, -3) }
    },
    inventory: {
        slots: [{ name: 'bread', count: 4 }, { name: 'stone_pickaxe', count: 1 }]
    },
    time: { timeOfDay: 14000 },
    game: { dimension: 'overworld' },
    isRaining: false,
    canSeeEntity: () => true,
    blockAt: () => ({ name: 'air', boundingBox: 'empty' })
};

const state = stateBuilder.buildWorldState(bot, {
    blocks: [{ name: 'oak_log', x: 15, y: 64, z: -3, distance: 4.3 }],
    events: events.recent(4),
    base: { x: 0, y: 64, z: 0 }
});
const observation = stateBuilder.toObservation(state, { farmReady: false });
assert.equal(state.environment.phase, 'night');
assert.equal(state.entities[0].name, 'zombie');
assert.equal(observation.inventory.bread, 4);
assert.equal(observation.worldState, state);

const blackboard = new Blackboard();
blackboard.update({ observation, autonomous: true });
assert.equal(blackboard.get('observation').health, 17);

worldMemory.initialize('architecture-world', { directory: worldDirectory });
persistentMemory.initialize('architecture-agent', { directory: agentDirectory });
persistentMemory.rememberPlayer('tester');
for (const [role, text] of [
    ['user', 'Help me build a farm.'],
    ['assistant', 'I will prepare the farm.'],
    ['user', 'Keep sixteen bread.'],
    ['assistant', 'I will remember that reserve.']
]) persistentMemory.addConversation('tester', role, text);
assert.match(persistentMemory.getPlayer('tester').conversationSummary.summary, /sixteen bread/);
assert.equal(persistentMemory.recordProactiveReport('farm_ready', 60000), true);
assert.equal(persistentMemory.recordProactiveReport('farm_ready', 60000), false);
persistentMemory.setClarification('tester', {
    kind: 'resource_target',
    originalMessage: 'Collect something.',
    question: 'Which resource should I collect?'
});
assert.equal(persistentMemory.getClarification('tester').kind, 'resource_target');
const professions = new ProfessionManager(persistentMemory);
assert.equal(professions.assign('ciftci', 'tester').id, 'farmer');
assert.equal(professions.current().assignedBy, 'tester');
assert.equal(professions.nextTool({ ...observation, farmReady: false }).tool, 'establish_wheat_farm');

const materialBot = {
    inventory: {
        items: () => [
            { name: 'oak_log', count: 4 },
            { name: 'dirt', count: 12 },
            { name: 'oak_planks', count: 8 }
        ]
    }
};
assert.equal(baseSkill.buildBlockCount(materialBot), 20);
assert.equal(baseSkill.materialPotential(materialBot), 36);

const queue = new TaskQueue(persistentMemory);
queue.enqueue({
    id: 'wood_order',
    goal: 'collect wood',
    requestedBy: 'tester',
    steps: [{ tool: 'mine_block', args: { target: 'any_log' } }]
});
assert.equal(queue.toolCall().tool, 'mine_block');
assert.equal(persistentMemory.getCommitments('tester', 'active')[0].id, 'wood_order');

const root = createRootTree({ taskQueue: queue, professionManager: professions });
const safety = { tool: 'escape_water', args: {}, reason: 'test' };
const safetyDecision = root.tick({ observation, safetyCall: safety });

Promise.resolve(safetyDecision).then(result => {
    assert.equal(result.value.source, 'safety');
    assert.equal(result.value.toolCall.tool, 'escape_water');

    persistentMemory.addProtectedZone({
        id: 'test_house',
        bounds: {
            min: { x: 0, y: 60, z: 0 },
            max: { x: 10, y: 80, z: 10 }
        },
        policies: { treeCutting: false }
    });
    const protectedLog = { name: 'oak_log', position: new Vec3(5, 64, 5) };
    assert.equal(blockPolicy.canHarvestTree(bot, protectedLog).allowed, false);

    persistentMemory.flush();
    persistentMemory.initialize('architecture-agent', { directory: agentDirectory });
    assert.equal(persistentMemory.getProfession().id, 'farmer');
    assert.equal(persistentMemory.getTaskQueue()[0].id, 'wood_order');
    assert.equal(persistentMemory.getClarification('tester').question, 'Which resource should I collect?');
    persistentMemory.clearClarification('tester');
    assert.equal(persistentMemory.getClarification('tester'), null);
    console.log('Agent world-state, memory, profession, task, tree, and grief policies passed.');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
