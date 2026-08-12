const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');

const sandbox = require('../agent/dynamicSkillSandbox');
const memory = require('../agent/persistentMemory');
const toolRegistry = require('../toolRegistry');
const runtime = require('../agent/minecraftSkillRuntime');
const shelter = require('../skills/shelter');
const taskVerifier = require('../agent/taskVerifier');

const registry = {
    tools: toolRegistry.TOOL_DEFINITIONS,
    normalizeToolCall: toolRegistry.normalizeToolCall,
    validateToolCall: toolRegistry.validateToolCall
};

const compiled = sandbox.compile({
    id: 'wood_delivery',
    displayName: 'Wood Delivery',
    purpose: 'Collect logs and store the result.',
    parameters: { target: 'any_log' },
    steps: [
        { tool: 'mine_block', args: { target: '$param.target', count: 1 }, repeat: 2 },
        { tool: 'return_base', args: {} },
        { tool: 'organize_storage', args: {} }
    ]
}, registry);

assert.equal(compiled.ok, true);
assert.equal(compiled.profile.id, 'wood_delivery');
assert.equal(compiled.steps.length, 4);
assert.equal(compiled.steps[0].args.target, 'any_log');
assert.equal(compiled.steps[3].tool, 'organize_storage');

const instantiated = sandbox.instantiate(compiled.profile, { target: 'oak_log' }, registry);
assert.equal(instantiated.ok, true);
assert.equal(instantiated.steps[0].args.target, 'oak_log');

for (const forbidden of ['fight_player', 'follow_player', 'move_near', 'build_showcase']) {
    const rejected = sandbox.compile({
        id: `unsafe_${forbidden}`,
        steps: [{ tool: forbidden, args: forbidden === 'fight_player' ? { username: 'Steve' } : {} }]
    }, registry);
    assert.equal(rejected.ok, false, `${forbidden} must be rejected`);
}

const malformed = sandbox.compile({
    id: 'bad_craft',
    steps: [{ tool: 'craft_item', args: {} }]
}, registry);
assert.equal(malformed.ok, false);

const bytecode = sandbox.compile({
    id: 'place_marker',
    displayName: 'Place Marker',
    purpose: 'Place one bounded dirt marker.',
    capabilities: {
        radius: 3,
        vertical: 2,
        maxOperations: 4,
        maxMutations: 1,
        maxDurationMs: 5000,
        mutableBlocks: ['dirt']
    },
    program: [{ op: 'place', offset: { x: 1, y: 0, z: 0 }, item: 'dirt' }],
    postconditions: [{ type: 'block_equals', offset: { x: 1, y: 0, z: 0 }, block: 'dirt' }]
}, registry);
assert.equal(bytecode.ok, true);
assert.equal(bytecode.profile.kind, 'minecraft_bytecode');
assert.equal(bytecode.steps[0].tool, 'execute_dynamic_skill');
assert.equal(bytecode.steps[0].maxAttempts, 1);

for (const [name, patch] of Object.entries({
    attack_operation: { program: [{ op: 'attack', offset: { x: 1, y: 0, z: 0 } }] },
    activate_operation: { program: [{ op: 'activate', offset: { x: 1, y: 0, z: 0 }, block: 'chest' }] },
    absolute_position: { program: [{ op: 'move', x: 4, y: 64, z: 2 }] },
    outside_radius: { program: [{ op: 'move', offset: { x: 9, y: 0, z: 0 } }] },
    undeclared_block: { program: [{ op: 'place', offset: { x: 1, y: 0, z: 0 }, item: 'stone' }] },
    explosive_block: {
        program: [{ op: 'place', offset: { x: 1, y: 0, z: 0 }, item: 'tnt' }],
        capabilities: { ...bytecode.profile.capabilities, mutableBlocks: ['tnt'] }
    },
    gravity_block: {
        program: [{ op: 'place', offset: { x: 1, y: 0, z: 0 }, item: 'sand' }],
        capabilities: { ...bytecode.profile.capabilities, mutableBlocks: ['sand'] }
    },
    no_assertion: { postconditions: [] }
})) {
    const rejected = sandbox.compile({
        id: name,
        capabilities: patch.capabilities || bytecode.profile.capabilities,
        program: patch.program || bytecode.profile.program,
        postconditions: patch.postconditions || bytecode.profile.postconditions
    }, registry);
    assert.equal(rejected.ok, false, `${name} must be rejected`);
}

const blocks = new Map();
const blockKey = position => `${position.x},${position.y},${position.z}`;
const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [{ name: 'dirt', count: 2 }] },
    blockAt(position) {
        return blocks.get(blockKey(position)) || {
            name: 'air',
            position: position.clone(),
            boundingBox: 'empty'
        };
    }
};
const originalPlaceSpecific = shelter.placeSpecific;
shelter.placeSpecific = async (_bot, item, position) => {
    blocks.set(blockKey(position), { name: item, position: position.clone(), boundingBox: 'block' });
    return true;
};
async function verifyRuntime() {
    try {
        const result = await runtime.execute(mockBot, bytecode.profile);
        assert.equal(result.status, 'verified');
        assert.equal(result.mutations, 1);
        assert.equal(result.assertions.every(entry => entry.ok), true);

        const verification = taskVerifier.verify(
            { tool: 'execute_dynamic_skill', args: { skillId: 'place_marker' } },
            {},
            {},
            { executionResult: result }
        );
        assert.equal(verification.ok, true);
    } finally {
        shelter.placeSpecific = originalPlaceSpecific;
    }
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sorim-skills-'));
memory.initialize('skill-memory-test', { directory: temporary });
memory.saveDynamicSkill(compiled.profile);
memory.saveDynamicSkill(bytecode.profile);
assert.equal(memory.getDynamicSkill('place_marker').status, 'testing');
memory.markDynamicSkillResult('place_marker', true, { verification: 'world assertion passed' });
assert.equal(memory.getDynamicSkill('place_marker').status, 'active');
memory.markDynamicSkillResult('place_marker', false, { error: 'later verification failed' });
assert.equal(memory.getDynamicSkill('place_marker').status, 'disabled');
assert.match(memory.getDynamicSkill('place_marker').disabledReason, /later verification failed/);
memory.flush();
memory.initialize('skill-memory-test', { directory: temporary });
assert.equal(memory.getDynamicSkills().wood_delivery.displayName, 'Wood Delivery');
assert.equal(memory.getDynamicSkill('place_marker').status, 'disabled');

verifyRuntime().then(() => {
    console.log('Safe dynamic skill compilation, rejection, runtime, and lifecycle passed.');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
