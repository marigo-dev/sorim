const assert = require('node:assert/strict');
const tools = require('../skills/tools');

assert.equal(
    tools.needsSurfaceReturn({ y: 67.9 }, { x: 0, y: 70, z: 0 }),
    true,
    'crafting below a remembered surface exit must trigger a return'
);
assert.equal(
    tools.needsSurfaceReturn({ y: 70 }, { x: 0, y: 70, z: 0 }),
    false,
    'standing at the surface exit must not trigger another climb'
);
assert.equal(
    tools.needsSurfaceReturn({ y: 20 }, null),
    false,
    'ordinary cave crafting without a remembered starter shaft remains supported'
);

console.log('tools tests passed');
