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
console.log('Conversational chat prompt passed.');
