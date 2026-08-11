const assert = require('node:assert/strict');

const LeaseManager = require('../agent/leaseManager');

let now = 1000;
let state = { leases: {} };
const store = {
    load: () => JSON.parse(JSON.stringify(state)),
    save: value => { state = JSON.parse(JSON.stringify(value)); }
};
const leases = new LeaseManager(store, { defaultTtlMs: 5000, now: () => now });

assert.equal(leases.claim('task:mine:any_log', 'mico').owner, 'mico');
assert.equal(leases.claim('task:mine:any_log', 'mira'), null);
assert.equal(leases.claim('task:farm:wheat', 'mira').owner, 'mira');

now = 3000;
assert.equal(leases.renew('task:mine:any_log', 'mico').expiresAt, 8000);
assert.equal(leases.release('task:mine:any_log', 'mira'), false);

now = 9000;
assert.equal(leases.claim('task:mine:any_log', 'mira').owner, 'mira');
assert.equal(leases.active()['task:farm:wheat'], undefined);

assert.equal(leases.releaseOwner('mira'), 1);
assert.deepEqual(leases.active(), {});

console.log('Colony task lease expiry, renewal, and disconnect release passed.');
