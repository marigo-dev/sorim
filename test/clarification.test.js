const assert = require('node:assert/strict');
const { parseCombatIntent } = require('../agent/combatIntent');
const {
    detectClarificationNeed,
    resolveClarificationMessage
} = require('../agent/clarification');

const combat = detectClarificationNeed('marigo onu oldur', 'Steve');
assert.equal(combat.type, 'clarify');
assert.equal(combat.kind, 'combat_target');
assert.equal(resolveClarificationMessage(combat, 'zombi'), 'zombi oldur');
assert.deepEqual(
    parseCombatIntent(resolveClarificationMessage(combat, 'zombi'), 'Steve', ['Steve']),
    { intent: 'combat_mob', targetMob: 'zombie', combatMode: 'lethal' }
);

const resource = detectClarificationNeed('bir sey topla', 'Steve');
assert.equal(resource.kind, 'resource_target');
assert.equal(resolveClarificationMessage(resource, '16 odun'), '16 odun topla');

const build = detectClarificationNeed('build something', 'Steve');
assert.equal(build.kind, 'build_target');
assert.equal(resolveClarificationMessage(build, 'house'), 'house yap');

assert.equal(resolveClarificationMessage(combat, 'dur'), 'dur');
assert.equal(resolveClarificationMessage(combat, 'Marigo iptal', 'Marigo'), 'iptal');
assert.equal(detectClarificationNeed('16 odun topla', 'Steve'), null);

console.log('Clarification flow passed.');
