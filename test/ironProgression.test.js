const assert = require('node:assert/strict');
const SkillTree = require('../src/skillTree');
const iron = require('../src/skills/iron');

function observation(inventory, overrides = {}) {
    return {
        health: 20,
        food: 20,
        position: { x: 0, y: 70, z: 0 },
        inventory,
        nearbyBlocks: [],
        nearbyMobs: [],
        hasUsableChest: true,
        hasPlacedCraftingTable: true,
        hasPlacedFurnace: true,
        storageReady: true,
        base: { x: 0, y: 70, z: 0 },
        survivalReady: true,
        hasBed: true,
        farmReady: true,
        hasMatureCrop: false,
        ...overrides
    };
}

const miningKit = {
    stone_pickaxe: 1,
    stone_axe: 1,
    stone_sword: 1,
    furnace: 1,
    coal: 3,
    torch: 16,
    cobblestone: 16,
    bread: 16,
    oak_planks: 12,
    stick: 6
};

const tree = new SkillTree();
assert.equal(tree.getLevel(observation(miningKit)).id, 'L13_SAFE_IRON_MINE');
assert.equal(
    tree.getForcedAction(observation(miningKit), tree.getLevel(observation(miningKit))).action,
    'mine_iron'
);
assert.equal(
    new SkillTree().getLevel(observation({ ...miningKit, raw_iron: 16 })).id,
    'L14_COLLECT_RAW_IRON'
);
assert.equal(
    new SkillTree().getLevel(observation({ ...miningKit, raw_iron: 17 })).id,
    'L15_SMELT_IRON'
);
assert.equal(
    new SkillTree().getLevel(observation({ ...miningKit, raw_iron: 9, iron_ingot: 7 })).id,
    'L15_SMELT_IRON'
);
assert.equal(
    new SkillTree().getLevel(observation({
        ...miningKit,
        coal: 0,
        raw_iron: 9,
        iron_ingot: 8
    })).id,
    'L15_SMELT_IRON'
);
const smeltingTree = new SkillTree();
assert.equal(smeltingTree.getLevel(observation({ ...miningKit, raw_iron: 17 })).id, 'L15_SMELT_IRON');
assert.equal(
    smeltingTree.getLevel(observation({ ...miningKit, raw_iron: 9, iron_ingot: 7 })).id,
    'L15_SMELT_IRON'
);
const reconcileLevel = smeltingTree.getLevel(observation({
    ...miningKit,
    coal: 0,
    raw_iron: 0,
    iron_ingot: 16
}));
assert.equal(reconcileLevel.id, 'L15_SMELT_IRON');
assert.equal(
    smeltingTree.getForcedAction(
        observation({ ...miningKit, coal: 0, raw_iron: 0, iron_ingot: 16 }),
        reconcileLevel
    ).action,
    'smelt_item'
);
const spentCoreReserve = {
    ...miningKit,
    iron_pickaxe: 1,
    iron_sword: 1,
    iron_axe: 1,
    shield: 1,
    iron_ingot: 0
};
const replaceCoreReserveLevel = smeltingTree.getLevel(observation(spentCoreReserve));
assert.equal(replaceCoreReserveLevel.id, 'L13_SAFE_IRON_MINE');
assert.equal(
    smeltingTree.getForcedAction(
        observation(spentCoreReserve),
        replaceCoreReserveLevel
    ).action,
    'mine_iron'
);
assert.equal(
    new SkillTree().getLevel(observation({ ...miningKit, iron_ingot: 17 })).id,
    'L16_CRAFT_IRON_KIT'
);
assert.equal(
    new SkillTree().getLevel(observation({
        ...miningKit,
        iron_ingot: 14,
        iron_pickaxe: 1
    })).id,
    'L16_CRAFT_IRON_KIT'
);
assert.equal(
    new SkillTree().getLevel(observation({
        ...miningKit,
        iron_pickaxe: 1,
        iron_sword: 1,
        iron_axe: 1,
        shield: 1,
        bucket: 1,
        iron_ingot: 8
    })).id,
    'L18_COLLECT_ARMOR_IRON'
);

const ironCore = {
    ...miningKit,
    iron_pickaxe: 1,
    iron_sword: 1,
    iron_axe: 1,
    shield: 1,
    bucket: 1,
    iron_ingot: 8
};
const farmTree = new SkillTree();
const farmLevel = farmTree.getLevel(observation(ironCore, { farmReady: false }));
assert.equal(farmLevel.id, 'L17_ESTABLISH_WHEAT_FARM');
assert.equal(
    farmTree.getForcedAction(observation(ironCore, { farmReady: false }), farmLevel).action,
    'establish_wheat_farm'
);
const armorTree = new SkillTree();
const collectArmorLevel = armorTree.getLevel(observation(ironCore));
assert.equal(collectArmorLevel.id, 'L18_COLLECT_ARMOR_IRON');
assert.equal(
    armorTree.getForcedAction(observation(ironCore), collectArmorLevel).count,
    24
);
assert.equal(
    armorTree.getLevel(observation({ ...ironCore, raw_iron: 24 })).id,
    'L19_SMELT_ARMOR_IRON'
);
assert.equal(
    armorTree.getLevel(observation({ ...ironCore, iron_ingot: 32 })).id,
    'L20_CRAFT_IRON_ARMOR'
);
const finalFurnaceLevel = armorTree.getLevel(observation({ ...ironCore, iron_ingot: 31 }));
assert.equal(finalFurnaceLevel.id, 'L19_SMELT_ARMOR_IRON');
assert.equal(
    armorTree.getForcedAction(
        observation({ ...ironCore, iron_ingot: 31 }),
        finalFurnaceLevel
    ).action,
    'smelt_item'
);
assert.equal(
    armorTree.getLevel(observation({
        ...ironCore,
        iron_chestplate: 1,
        iron_leggings: 1,
        iron_helmet: 1,
        iron_boots: 1
    })).id,
    'L21_STABLE_SURVIVAL'
);
const stableInventory = {
    ...ironCore,
    stick: 1,
    iron_chestplate: 1,
    iron_leggings: 1,
    iron_helmet: 1,
    iron_boots: 1
};
const stableLevel = armorTree.getLevel(observation(stableInventory));
assert.equal(
    armorTree.getForcedAction(observation(stableInventory), stableLevel).action,
    'idle'
);
assert.equal(
    armorTree.getForcedAction(
        observation({ ...stableInventory, egg: 2 }),
        stableLevel
    ).action,
    'organize_storage'
);
const lowFoodFarmTree = new SkillTree();
const lowFoodFarmObservation = observation(
    { ...stableInventory, bread: 0 },
    { farmReady: true }
);
const lowFoodFarmLevel = lowFoodFarmTree.getLevel(lowFoodFarmObservation);
assert.equal(lowFoodFarmLevel.id, 'L9_FOOD_LOOP');
assert.equal(
    lowFoodFarmTree.getForcedAction(lowFoodFarmObservation, lowFoodFarmLevel).action,
    'maintain_food_supply'
);
const spentReserveInventory = { ...stableInventory, iron_ingot: 0 };
const replaceReserveLevel = armorTree.getLevel(observation(spentReserveInventory));
assert.equal(replaceReserveLevel.id, 'L19_SMELT_ARMOR_IRON');
assert.equal(
    armorTree.getForcedAction(
        observation(spentReserveInventory),
        replaceReserveLevel
    ).action,
    'mine_iron'
);

assert.equal(iron.requiredCorePlanks(0), 10);
assert.equal(iron.requiredCorePlanks(2), 8);
assert.equal(iron.requiredCorePlanks(6), 6);
assert.equal(iron.requiredCoreIngots({}), 9);
assert.equal(iron.requiredCoreIngots({ iron_pickaxe: 1, shield: 1 }), 5);
assert.equal(iron.ironInvestment({ iron_pickaxe: 1 }), 3);
assert.equal(iron.ironInvestment({
    iron_pickaxe: 1,
    iron_sword: 1,
    iron_axe: 1,
    shield: 1
}), 9);
assert.equal(iron.requiredArmorIngots({}), 24);
assert.equal(iron.requiredArmorIngots({ iron_chestplate: 1 }), 16);
assert.equal(iron.ironInvestment({ bucket: 1 }), 3);
assert.equal(iron.ironInvestment({ water_bucket: 1 }), 3);

console.log('Iron-age milestones and core material reserve passed.');
