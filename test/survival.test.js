const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');
const memory = require('../skills/memory');
const survival = require('../skills/survival');
const food = require('../skills/food');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marigo-survival-'));

function makeBot(timeOfDay) {
    return {
        entity: { position: new Vec3(0, 64, 0) },
        entities: {},
        time: { timeOfDay },
        registry: { blocksByName: {} },
        findBlocks: () => [],
        blockAt: () => ({ name: 'air', boundingBox: 'empty' })
    };
}

function observation(food, inventory = {}) {
    return {
        health: 20,
        food,
        inventory
    };
}

try {
    memory.initialize('survival-test', { directory });
    memory.setBase({ x: 0, y: 64, z: 0 });

    const night = makeBot(14000);
    const day = makeBot(6000);
    const level = { id: 'L9_FOOD_LOOP' };

    assert.equal(
        survival.chooseImmediateAction(night, observation(8), level).action,
        'wait_safe'
    );
    assert.equal(
        survival.chooseImmediateAction(day, observation(8), level).action,
        'find_food'
    );
    assert.equal(
        survival.chooseImmediateAction(night, observation(8, { bread: 1 }), level).action,
        'eat_food'
    );
    assert.equal(food.foodCount({ cooked_beef: 2 }), 2);
    assert.equal(food.hasFoodStock({ bread: 16 }), true);
    assert.equal(food.hasFoodStock({ cooked_beef: 2 }), false);
    console.log('Survival night and hunger priorities passed.');
} finally {
    memory.flush();
    fs.rmSync(directory, { recursive: true, force: true });
}
