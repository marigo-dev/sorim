const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skillsDir = path.join(__dirname, '..', 'src', 'skills');
const emergencyOnly = new Set(['movement.js', 'combat.js', 'survival.js']);
const forbiddenNormalMovement = [
    /movement\.(?:manualNudge|moveTowardDirectly|moveTowardSafely|walkToward)\s*\(/,
    /\bbot\.setControlState\s*\(/
];

const violations = [];
for (const file of fs.readdirSync(skillsDir).filter(name => name.endsWith('.js'))) {
    if (emergencyOnly.has(file)) continue;
    const source = fs.readFileSync(path.join(skillsDir, file), 'utf8');
    for (const pattern of forbiddenNormalMovement) {
        if (pattern.test(source)) violations.push(`${file}: ${pattern}`);
    }
}

assert.deepEqual(violations, [], `normal skills bypass navigation facade: ${violations.join(', ')}`);
console.log('Normal skill Pathfinder navigation contract passed');
