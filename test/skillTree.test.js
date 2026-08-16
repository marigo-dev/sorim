const assert = require('node:assert/strict');
const SkillTree = require('../src/skillTree');
const toolRegistry = require('../src/toolRegistry');
const actionControl = require('../src/skills/actionControl');
const memory = require('../src/skills/memory');

function observation(inventory, overrides = {}) {
    return {
        health: 20,
        food: 20,
        position: { x: 0, y: 70, z: 0 },
        inventory,
        nearbyBlocks: [],
        nearbyMobs: [],
        hasUsableChest: false,
        hasPlacedCraftingTable: false,
        hasPlacedFurnace: false,
        storageReady: true,
        base: null,
        survivalReady: true,
        ...overrides
    };
}

const restartedMidStoneTools = new SkillTree();
assert.equal(
    restartedMidStoneTools.getLevel(observation({
        oak_planks: 8,
        cobblestone: 10,
        stone_pickaxe: 1,
        stone_axe: 1,
        crafting_table: 1
    })).id,
    'L6_CRAFT_STONE_TOOLS'
);

const naturalStickTree = new SkillTree();
assert.equal(
    naturalStickTree.getLevel(observation({ stick: 2, dirt: 2 })).id,
    'L1_COLLECT_WOOD',
    'Natural stick drops must not prove that logs were collected'
);

const randomSwordLootTree = new SkillTree();
assert.equal(
    randomSwordLootTree.getLevel(observation({ oak_planks: 16, stone_sword: 1 })).id,
    'L3_CRAFT_TABLE',
    'Random weapon loot must not prove crafting-table or stone-mining milestones'
);

const completedStoneTools = new SkillTree();
const stoneToolInventory = {
    stone_pickaxe: 1,
    stone_axe: 1,
    stone_sword: 1
};
const shelterLevel = completedStoneTools.getLevel(observation(stoneToolInventory));
assert.equal(
    shelterLevel.id,
    'L7_BUILD_SAFE_SHELTER'
);

const foodStockTree = new SkillTree();
assert.equal(
    foodStockTree.getLevel(observation({
        ...stoneToolInventory,
        cooked_beef: 2
    }, { base: { x: 0, y: 70, z: 0 } })).id,
    'L9_FOOD_LOOP'
);
assert.equal(
    foodStockTree.getLevel(observation({
        ...stoneToolInventory,
        apple: 16
    }, { base: { x: 0, y: 70, z: 0 } })).id,
    'L10_STORAGE_AND_BASE_MEMORY'
);
assert.equal(
    completedStoneTools.getForcedAction(observation(stoneToolInventory), shelterLevel).action,
    'collect_stone'
);
assert.equal(
    completedStoneTools.getForcedAction(
        observation({ ...stoneToolInventory, cobblestone: 34 }),
        shelterLevel
    ).action,
    'mine'
);
assert.equal(
    completedStoneTools.getForcedAction(
        observation({ ...stoneToolInventory, cobblestone: 34, oak_log: 1 }),
        shelterLevel
    ).action,
    'craft'
);
assert.equal(
    completedStoneTools.getForcedAction(
        observation({ ...stoneToolInventory, cobblestone: 34, oak_planks: 60 }),
        shelterLevel
    ).action,
    'build_shelter'
);

memory.setConstructionBase({ x: 4, y: 70, z: 4 });
memory.setProgress('shelterShellScore', 71);
const utilityRepairTree = new SkillTree();
const utilityRepairLevel = utilityRepairTree.getLevel(observation(stoneToolInventory));
assert.equal(
    utilityRepairTree.getForcedAction(
        observation({
            ...stoneToolInventory,
            acacia_log: 1,
            acacia_planks: 7,
            acacia_door: 1
        }, {
            hasPlacedCraftingTable: true
        }),
        utilityRepairLevel
    ).action,
    'craft',
    'utility repair must resolve a one-plank chest deficit before retrying the build'
);
memory.clearConstructionBase();

const stillCollectingStone = new SkillTree();
assert.equal(
    stillCollectingStone.getLevel(observation({
        wooden_pickaxe: 1,
        oak_planks: 8,
        cobblestone: 10
    })).id,
    'L5_COLLECT_STONE'
);

const bedTree = new SkillTree();
const preBedInventory = {
    ...stoneToolInventory,
    bread: 16,
    oak_planks: 12
};
const bedLevel = bedTree.getLevel(observation(preBedInventory, {
    base: { x: 0, y: 70, z: 0 },
    hasUsableChest: true,
    farmReady: true,
    hasBed: false
}));
assert.equal(bedLevel.id, 'L11_SECURE_BED');
assert.equal(
    bedTree.getForcedAction(
        observation(preBedInventory, {
            base: { x: 0, y: 70, z: 0 },
            hasUsableChest: true,
            farmReady: true,
            hasBed: false
        }),
        bedLevel
    ).action,
    'secure_bed'
);

const bot = {};
const version = actionControl.snapshot(bot);
actionControl.assertActive(bot, version);
actionControl.cancel(bot, 'test interrupt');
assert.throws(
    () => actionControl.assertActive(bot, version),
    /Action cancelled: test interrupt/
);

const visibleTreeTools = toolRegistry.constrainToolsForObservation(
    toolRegistry.toolsForLevel({ allowedActions: ['mine', 'explore', 'idle'] }),
    { id: 'L1_COLLECT_WOOD' },
    observation({}, { nearbyBlocks: [{ name: 'oak_log', distance: 12 }] })
);
assert.equal(visibleTreeTools.some(tool => tool.name === 'explore'), false);
assert.equal(visibleTreeTools.some(tool => tool.name === 'mine_block'), true);

console.log('Skill tree milestones and action cancellation passed.');
