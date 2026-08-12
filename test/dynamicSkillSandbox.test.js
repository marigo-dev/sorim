const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sandbox = require('../agent/dynamicSkillSandbox');
const memory = require('../agent/persistentMemory');
const toolRegistry = require('../toolRegistry');

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

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sorim-skills-'));
memory.initialize('skill-memory-test', { directory: temporary });
memory.saveDynamicSkill(compiled.profile);
memory.flush();
memory.initialize('skill-memory-test', { directory: temporary });
assert.equal(memory.getDynamicSkills().wood_delivery.displayName, 'Wood Delivery');

console.log('Safe dynamic skill compilation, rejection, and persistence passed.');
