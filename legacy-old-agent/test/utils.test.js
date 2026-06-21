const assert = require('assert');
const { entityName } = require('../src/utils');

assert.strictEqual(entityName({ name: 'sheep' }), 'sheep');
assert.strictEqual(entityName({ displayName: 'Sheep' }), 'sheep');
assert.strictEqual(entityName({ displayName: 'Iron Golem' }), 'iron_golem');
assert.strictEqual(entityName({ name: 'minecraft:cod' }), 'cod');
assert.strictEqual(entityName({}), '');

console.log('Utility tests passed.');
