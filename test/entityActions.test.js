const assert = require('node:assert/strict');
const entityActions = require('../skills/entityActions');

const packets = [];
let swings = 0;
const modern = {
    supportFeature: name => name === 'attackUsesOwnPacket',
    _client: { write: (name, data) => packets.push({ name, data }) },
    swingArm: () => { swings++; },
    attack: () => { throw new Error('legacy attack should not be used'); }
};
entityActions.attack(modern, { id: 42 });
assert.deepEqual(packets, [{ name: 'attack', data: { entityId: 42 } }]);
assert.equal(swings, 1);

let legacyTarget = null;
const legacy = {
    supportFeature: () => false,
    attack: target => { legacyTarget = target; }
};
const target = { id: 7 };
entityActions.attack(legacy, target);
assert.equal(legacyTarget, target);

console.log('Entity attack packet selection passed.');
