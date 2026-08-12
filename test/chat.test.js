const assert = require('node:assert/strict');
const { buildChatPrompt, normalizeIntent } = require('../llm');

const prompt = buildChatPrompt({
    username: 'player',
    message: 'Peki sen ne dusunuyorsun?',
    observation: {
        health: 20,
        food: 20,
        position: { x: 1, y: 64, z: 2 },
        inventoryText: 'oak_log:4',
        base: null,
        lastError: null
    },
    level: { goal: 'Collect wood' },
    conversation: [
        { role: 'user', text: 'Marigo, sence burada yasamak guzel mi?' },
        { role: 'assistant', text: 'Ormani sevdim; sakin ama kesfedilecek cok yer var.' }
    ],
    episodes: [],
    playerMemory: {},
    character: null
});

assert.match(prompt, /ongoing dialogue/i);
assert.match(prompt, /one to three natural sentences/i);
assert.match(prompt, /silent background context/i);
assert.match(prompt, /Ormani sevdim/);
assert.doesNotMatch(prompt, /under 20 words/i);
assert.doesNotMatch(prompt, /goal=Collect wood/);

const guard = normalizeIntent({ intent: 'guard' }, 'Marigo burada kal ve burayi koru', {});
assert.equal(guard.target, 'position');

const duel = normalizeIntent(
    { intent: 'combat', combatMode: 'duel' },
    'Marigo benimle savas',
    {},
    'waterghost8'
);
assert.equal(duel.targetPlayer, 'waterghost8');
assert.equal(duel.combatMode, 'duel');

const lethal = normalizeIntent(
    { intent: 'combat', targetPlayer: 'Steve' },
    'Marigo Steve oyuncusunu oldur',
    {},
    'waterghost8'
);
assert.equal(lethal.targetPlayer, 'Steve');
assert.equal(lethal.combatMode, 'lethal');

const customProfession = normalizeIntent({
    intent: 'create_profession',
    professionName: 'forest_guardian',
    routines: [{
        tool: 'mine_block',
        args: { target: 'any_log' },
        condition: { type: 'inventory_below', item: 'log', count: 32 }
    }]
}, 'Marigo artik orman bekcisisin', {});
assert.equal(customProfession.professionProfile.id, 'forest_guardian');
assert.equal(customProfession.professionProfile.routines[0].when.item, 'log');
assert.match(customProfession.professionProfile.routines[0].reason, /mine_block/);

const dynamicSkill = normalizeIntent({
    intent: 'create_dynamic_skill',
    skillName: 'wood_delivery',
    description: 'Collect wood and take it home.',
    parameters: { target: 'any_log' },
    steps: [{
        tool: 'mine_block',
        args: { target: '$param.target', count: 1 },
        repeat: 2
    }, {
        tool: 'return_base',
        args: {}
    }]
}, 'Marigo odun teslim etme yetenegi ogren', {});
assert.equal(dynamicSkill.dynamicSkillProfile.id, 'wood_delivery');
assert.equal(dynamicSkill.dynamicSkillProfile.steps.length, 2);
assert.equal(dynamicSkill.dynamicSkillProfile.steps[0].repeat, 2);
console.log('Conversational chat prompt passed.');
