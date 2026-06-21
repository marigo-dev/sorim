const assert = require('assert');
const LocalAgent = require('../src/local-agent');

const agent = new LocalAgent({});

assert.deepStrictEqual(
    agent.parseJsonObject('{"type":"explore","reason":"test"}'),
    { type: 'explore', reason: 'test' }
);

assert.deepStrictEqual(
    agent.parseJsonObject('dusunmeden once yazdim {"type":"idle","reason":"bekle"} sonra sustum'),
    { type: 'idle', reason: 'bekle' }
);

assert.strictEqual(agent.parseJsonObject('json yok'), null);

console.log('Local agent tests passed.');
