const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');

const persistentMemory = require('../agent/persistentMemory');
const DirectiveManager = require('../agent/directiveManager');
const ProfessionManager = require('../professions/professionManager');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sorim-directives-'));
persistentMemory.initialize('mico', { directory });

const directives = new DirectiveManager(persistentMemory);
directives.follow('tester', 3);
const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    players: { tester: { entity: { position: new Vec3(12, 64, 0) } } }
};
assert.equal(directives.nextTool(bot, {}).tool, 'follow_player');
bot.players.tester.entity.position = new Vec3(2, 64, 0);
assert.equal(directives.nextTool(bot, {}).tool, 'wait_safe');

directives.guard({ anchor: { x: 20, y: 64, z: 20 }, range: 5, assignedBy: 'tester' });
assert.equal(directives.nextTool(bot, {}).tool, 'move_near');

const tools = [{ name: 'mine_block' }, { name: 'organize_storage' }];
const professions = new ProfessionManager(persistentMemory, {
    tools,
    validateToolCall: call => call.tool === 'mine_block' && call.args?.target ? call :
        call.tool === 'organize_storage' ? call : null
});
const created = professions.createAndAssign({
    id: 'forest_keeper',
    displayName: 'Forest Keeper',
    purpose: 'Maintain a renewable wood reserve.',
    aliases: ['ormanci'],
    protectedBlocks: ['oak_sapling'],
    stockTargets: { oak_log: 32 },
    routines: [
        {
            tool: 'mine_block',
            args: { target: 'any_log' },
            reason: 'Gather safe natural wood',
            when: { type: 'inventory_below', item: 'oak_log', count: 32 }
        },
        {
            tool: 'organize_storage',
            args: {},
            reason: 'Store the completed wood reserve',
            when: { type: 'inventory_at_least', item: 'oak_log', count: 32 }
        }
    ]
}, 'tester');
assert.equal(created.ok, true);
assert.equal(professions.current().id, 'forest_keeper');
assert.equal(professions.nextTool({ inventory: { oak_log: 4 } }).tool, 'mine_block');
professions.lastActionAt = 0;
assert.equal(professions.nextTool({ inventory: { oak_log: 32 }, base: { x: 0, y: 64, z: 0 } }).tool, 'organize_storage');

const rejected = professions.createAndAssign({
    id: 'unsafe_job',
    routines: [{ tool: 'unknown_power', args: {}, reason: 'Invent a capability' }]
}, 'tester');
assert.equal(rejected.ok, false);

persistentMemory.flush();
persistentMemory.initialize('mico', { directory });
assert.equal(persistentMemory.getCustomProfessions().forest_keeper.id, 'forest_keeper');
assert.equal(persistentMemory.getDirective().type, 'guard');

console.log('Persistent directives and safe dynamic professions passed.');
