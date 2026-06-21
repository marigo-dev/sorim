const assert = require('assert');
const { Vec3 } = require('vec3');
const Skills = require('../src/skills');

const skills = Object.create(Skills.prototype);
skills.bot = {
    entity: {
        position: new Vec3(0, 64, 0)
    }
};
skills.memory = {
    data: {
        exploredAreas: [
            { x: 56, y: 64, z: 0, resource: 'herhangi_bir_odun' }
        ]
    }
};

const woodTarget = skills.chooseExplorationTarget('herhangi_bir_odun');
assert.ok(
    Math.hypot(woodTarget.x, woodTarget.z) >= 40,
    'Odun kesfi en az 40 blok uzaga gitmeli'
);
assert.notDeepStrictEqual(
    { x: woodTarget.x, z: woodTarget.z },
    { x: 56, z: 0 },
    'Daha once ziyaret edilen ayni nokta tekrar secilmemeli'
);

const genericTarget = skills.chooseExplorationTarget('genel');
assert.ok(
    Math.hypot(genericTarget.x, genericTarget.z) >= 24,
    'Genel kesif de kisa rastgele adim olmamali'
);

console.log('Exploration tests passed.');
