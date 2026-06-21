const LOG_ITEMS = [
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'cherry_log',
    'mangrove_log'
];

const food = require('./skills/food');

const FOOD_VALUES = {
    bread: 5,
    cooked_beef: 8,
    cooked_porkchop: 8,
    cooked_mutton: 6,
    cooked_chicken: 6,
    beef: 3,
    porkchop: 3,
    mutton: 2,
    chicken: 2,
    apple: 4,
    carrot: 3,
    potato: 1,
    baked_potato: 5
};

const LEVELS = [
    {
        id: 'L1_COLLECT_WOOD',
        goal: 'Collect at least 6 logs. Search for trees and cut trunk logs.',
        allowedActions: ['mine', 'explore', 'idle'],
        complete: (observation, tree) => tree.progress.maxWoodUnits >= 6
    },
    {
        id: 'L2_CRAFT_PLANKS',
        goal: 'Craft at least 24 planks from logs; reserve enough for tools, shelter, and storage.',
        allowedActions: ['craft', 'idle'],
        complete: (observation, tree) => tree.progress.maxPlanks >= 24
    },
    {
        id: 'L3_CRAFT_TABLE',
        goal: 'Craft and place one crafting table.',
        allowedActions: ['craft', 'place', 'idle'],
        complete: (observation, tree) =>
            tree.progress.hasCraftingTable ||
            observation.nearbyBlocks.some(block => block.name === 'crafting_table' && block.distance <= 16)
    },
    {
        id: 'L4_CRAFT_WOODEN_PICKAXE',
        goal: 'Craft a wooden pickaxe.',
        allowedActions: ['craft', 'place', 'idle'],
        complete: observation => (observation.inventory.wooden_pickaxe || 0) >= 1
    },
    {
        id: 'L5_COLLECT_STONE',
        goal: 'Dig a safe staircase, find stone, collect 16 cobblestone, then return upward.',
        allowedActions: ['collect_stone', 'idle'],
        complete: (observation, tree) =>
            (observation.inventory.cobblestone || 0) >= 16 ||
            tree.progress.maxCobblestone >= 16
    },
    {
        id: 'L6_CRAFT_STONE_TOOLS',
        goal: 'Craft a stone pickaxe, stone axe, and stone sword.',
        allowedActions: ['craft_stone_tools', 'craft', 'idle'],
        complete: observation => hasStoneTools(observation.inventory)
    },
    {
        id: 'L7_BUILD_SAFE_SHELTER',
        goal: 'Build the first enclosed safe shelter and store its base coordinates.',
        allowedActions: ['build_shelter', 'idle'],
        complete: observation => Boolean(observation.base)
    },
    {
        id: 'L8_SURVIVAL_MANAGER',
        goal: 'Ensure the survival manager runs before the main loop.',
        allowedActions: ['idle'],
        complete: observation => observation.survivalReady === true
    },
    {
        id: 'L9_FOOD_LOOP',
        goal: 'Keep at least 16 food points in reserve; if no food is nearby, temporarily move on.',
        allowedActions: ['eat_food', 'find_food', 'idle'],
        complete: observation =>
            foodScore(observation.inventory) >= 16 ||
            food.isTemporarilyUnavailable()
    },
    {
        id: 'L10_STORAGE_AND_BASE_MEMORY',
        goal: 'Place a chest near the base and organize excess inventory.',
        allowedActions: ['organize_storage', 'idle'],
        complete: observation => observation.hasUsableChest === true
    }
];

class SkillTree {
    constructor() {
        this.progress = {
            maxWoodUnits: 0,
            maxPlanks: 0,
            maxCobblestone: 0,
            hasCraftingTable: false
        };
    }

    getLevel(observation) {
        this.updateProgress(observation);
        return LEVELS.find(level => !level.complete(observation, this)) ||
            {
                id: 'L11_STABLE_SURVIVAL',
                goal: 'Core loop complete. Maintain food, wood, planks, and storage.',
                allowedActions: [
                    'mine',
                    'explore',
                    'craft',
                    'eat_food',
                    'find_food',
                    'organize_storage',
                    'idle'
                ],
                complete: () => false
            };
    }

    getForcedAction(observation, level) {
        const inventory = observation.inventory;

        if (level.id === 'L1_COLLECT_WOOD') {
            const visibleLog = nearestVisibleLog(observation);
            if (visibleLog) {
                return {
                    action: 'mine',
                    target: visibleLog.name,
                    reason: 'Level 1: cut the visible tree trunk'
                };
            }
            return {
                action: 'explore',
                target: 'wood',
                reason: 'Level 1: find wood'
            };
        }

        if (level.id === 'L2_CRAFT_PLANKS') {
            const logName = LOG_ITEMS.find(name => (inventory[name] || 0) > 0);
            return {
                action: 'craft',
                item: plankForLog(logName || 'oak_log'),
                count: 24 - totalPlanks(inventory),
                reason: 'Level 2: craft planks'
            };
        }

        if (level.id === 'L3_CRAFT_TABLE') {
            if ((inventory.crafting_table || 0) > 0) {
                return {
                    action: 'place',
                    item: 'crafting_table',
                    reason: 'Level 3: place crafting table'
                };
            }
            return {
                action: 'craft',
                item: 'crafting_table',
                count: 1,
                reason: 'Level 3: craft crafting table'
            };
        }

        if (level.id === 'L4_CRAFT_WOODEN_PICKAXE') {
            if ((inventory.stick || 0) < 2) {
                return {
                    action: 'craft',
                    item: 'stick',
                    count: 2,
                    reason: 'Level 4: craft sticks for pickaxe'
                };
            }
            return {
                action: 'craft',
                item: 'wooden_pickaxe',
                count: 1,
                reason: 'Level 4: craft wooden pickaxe'
            };
        }

        if (level.id === 'L5_COLLECT_STONE') {
            return {
                action: 'collect_stone',
                count: Math.max(1, 16 - (inventory.cobblestone || 0)),
                reason: 'Level 5: collect cobblestone with a safe staircase'
            };
        }

        if (level.id === 'L6_CRAFT_STONE_TOOLS') {
            return {
                action: 'craft_stone_tools',
                reason: 'Level 6: craft stone pickaxe, axe, and sword'
            };
        }

        if (level.id === 'L7_BUILD_SAFE_SHELTER') {
            return {
                action: 'build_shelter',
                reason: 'Level 7: build first safe shelter'
            };
        }

        if (level.id === 'L9_FOOD_LOOP') {
            if (foodScore(inventory) > 0 && observation.food < 20) {
                return {
                    action: 'eat_food',
                    reason: 'Level 9: use food reserve'
                };
            }
            return {
                action: 'find_food',
                reason: 'Level 9: collect minimum food reserve'
            };
        }

        if (level.id === 'L10_STORAGE_AND_BASE_MEMORY') {
            return {
                action: 'organize_storage',
                reason: 'Level 10: place chest and organize inventory'
            };
        }

        if (level.id === 'L11_STABLE_SURVIVAL') {
            if (foodScore(inventory) < 16 && !food.isTemporarilyUnavailable()) {
                return {
                    action: 'find_food',
                    reason: 'Routine: food reserve is low'
                };
            }

            if (totalPlanks(inventory) < 12 && totalLogs(inventory) > 0) {
                const logName = LOG_ITEMS.find(name => (inventory[name] || 0) > 0);
                return {
                    action: 'craft',
                    item: plankForLog(logName || 'oak_log'),
                    count: Math.max(4, 12 - totalPlanks(inventory)),
                    reason: 'Routine: refill plank reserve'
                };
            }

            if (woodUnits(inventory) < 2) {
                const visibleLog = nearestVisibleLog(observation);
                if (visibleLog) {
                    return {
                        action: 'mine',
                        target: visibleLog.name,
                        reason: 'Routine: refill wood reserve'
                    };
                }
                return {
                    action: 'mine',
                    target: 'any_log',
                    reason: 'Routine: find and cut a reachable tree'
                };
            }

            if (shouldOrganizeInventory(inventory, observation)) {
                return {
                    action: 'organize_storage',
                    reason: 'Routine: organize inventory into chest'
                };
            }

            return {
                action: 'idle',
                ms: 3000,
                reason: 'Routine: core supplies are stable, wait safely'
            };
        }

        return null;
    }

    validateAction(action, level) {
        if (!action || typeof action !== 'object') return null;
        if (!level.allowedActions.includes(action.action)) return null;

        if (action.action === 'mine' && typeof action.target === 'string') return action;
        if (action.action === 'explore') return action;
        if (action.action === 'idle') return action;
        if (action.action === 'collect_stone') return action;
        if (action.action === 'craft_stone_tools') return action;
        if (action.action === 'build_shelter') return action;
        if (action.action === 'eat_food') return action;
        if (action.action === 'find_food') return action;
        if (action.action === 'fight_mob') return action;
        if (action.action === 'escape_pit') return action;
        if (action.action === 'return_base') return action;
        if (action.action === 'organize_storage') return action;
        if (action.action === 'craft' && typeof action.item === 'string') return action;
        if (action.action === 'place' && typeof action.item === 'string') return action;

        return null;
    }

    fallbackAction(observation, level) {
        return this.getForcedAction(observation, level) || {
            action: 'idle',
            ms: 1000,
            reason: 'No valid action available'
        };
    }

    updateProgress(observation) {
        const emptyInventory = Object.keys(observation.inventory).length === 0;
        if (emptyInventory) {
            this.progress.maxWoodUnits = 0;
            this.progress.maxPlanks = 0;
            this.progress.maxCobblestone = 0;
            this.progress.hasCraftingTable = false;
            return;
        }

        this.progress.maxWoodUnits = Math.max(
            this.progress.maxWoodUnits,
            woodUnits(observation.inventory)
        );
        this.progress.maxPlanks = Math.max(
            this.progress.maxPlanks,
            totalPlanks(observation.inventory)
        );
        this.progress.maxCobblestone = Math.max(
            this.progress.maxCobblestone,
            observation.inventory.cobblestone || 0
        );
        if (
            observation.nearbyBlocks.some(block => block.name === 'crafting_table' && block.distance <= 16)
        ) {
            this.progress.hasCraftingTable = true;
        }
    }
}

function nearestVisibleLog(observation) {
    return observation.nearbyBlocks.find(block => LOG_ITEMS.includes(block.name));
}

function totalLogs(inventory) {
    return LOG_ITEMS.reduce((sum, name) => sum + (inventory[name] || 0), 0);
}

function woodUnits(inventory) {
    return totalLogs(inventory) +
        totalPlanks(inventory) / 4 +
        (inventory.stick || 0) / 8 +
        (inventory.crafting_table || 0) +
        (inventory.wooden_pickaxe || 0);
}

function totalPlanks(inventory) {
    return Object.entries(inventory)
        .filter(([name]) => name.endsWith('_planks'))
        .reduce((sum, [, count]) => sum + count, 0);
}

function plankForLog(logName) {
    return logName.replace(/_log$/, '_planks');
}

function hasStoneTools(inventory) {
    return ['stone_pickaxe', 'stone_axe', 'stone_sword']
        .every(name => (inventory[name] || 0) >= 1);
}

function foodScore(inventory) {
    return Object.entries(inventory)
        .reduce((sum, [name, count]) => sum + (FOOD_VALUES[name] || 0) * count, 0);
}

function shouldOrganizeInventory(inventory, observation) {
    if (observation.hasUsableChest !== true) return false;
    if (observation.storageReady === false) return false;
    const itemTypes = Object.keys(inventory).length;
    const disposable = ['egg', 'oak_sapling', 'oak_door', 'dirt', 'cobblestone']
        .some(name => (inventory[name] || 0) > keepRoutineCount(name));
    return itemTypes >= 8 || disposable;
}

function keepRoutineCount(itemName) {
    if (itemName === 'dirt' || itemName === 'cobblestone') return 32;
    if (itemName === 'oak_sapling') return 1;
    if (itemName === 'oak_door') return 1;
    return 0;
}

module.exports = SkillTree;
