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
const iron = require('./skills/iron');

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
        goal: 'Collect at least 4 logs. Search for trees and cut trunk logs.',
        allowedActions: ['mine', 'explore', 'idle'],
        complete: (observation, tree) => tree.progress.maxWoodUnits >= 4
    },
    {
        id: 'L2_CRAFT_PLANKS',
        goal: 'Craft at least 16 planks from logs; unlock the early tool chain.',
        allowedActions: ['craft', 'idle'],
        complete: (observation, tree) => tree.progress.maxPlanks >= 16
    },
    {
        id: 'L3_CRAFT_TABLE',
        goal: 'Craft and place one crafting table.',
        allowedActions: ['craft', 'place', 'idle'],
        complete: (observation, tree) =>
            (observation.inventory.wooden_pickaxe || 0) >= 1 ||
            hasStoneTools(observation.inventory) ||
            tree.progress.hasCraftingTable ||
            observation.hasPlacedCraftingTable === true ||
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
    },
    {
        id: 'L12_PREPARE_MINING_KIT',
        goal: 'Prepare furnace, fuel, torches, food, stone tools, and block stock for iron mining.',
        allowedActions: ['prepare_mining_kit', 'eat_food', 'find_food', 'mine', 'craft', 'idle'],
        complete: observation => hasMiningKit(observation)
    },
    {
        id: 'L13_SAFE_IRON_MINE',
        goal: 'Open a controlled stair mine from base, place torches, and search for iron.',
        allowedActions: ['mine_iron', 'eat_food', 'organize_storage', 'idle'],
        complete: observation =>
            rawIronPotential(observation.inventory) >= 16 ||
            iron.hasIronCoreKit(observation.inventory)
    },
    {
        id: 'L14_COLLECT_RAW_IRON',
        goal: 'Collect enough raw iron for iron tools, shield, and an 8 ingot reserve.',
        allowedActions: ['mine_iron', 'eat_food', 'organize_storage', 'idle'],
        complete: observation =>
            rawIronPotential(observation.inventory) >= 17 ||
            iron.hasIronCoreKit(observation.inventory)
    },
    {
        id: 'L15_SMELT_IRON',
        goal: 'Smelt raw iron into iron ingots using furnace and fuel.',
        allowedActions: ['smelt_item', 'prepare_mining_kit', 'idle'],
        complete: observation =>
            (observation.inventory.iron_ingot || 0) >= 17 ||
            iron.hasIronCoreKit(observation.inventory)
    },
    {
        id: 'L16_CRAFT_IRON_KIT',
        goal: 'Craft iron pickaxe, sword, axe, shield, then iron armor as ingots allow.',
        allowedActions: ['craft_iron_kit', 'craft', 'idle'],
        complete: observation => iron.hasIronCoreKit(observation.inventory)
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
                    'prepare_mining_kit',
                    'mine_iron',
                    'smelt_item',
                    'craft_iron_kit',
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
                action: 'mine',
                target: 'any_log',
                reason: 'Level 1: search and cut the nearest tree'
            };
        }

        if (level.id === 'L2_CRAFT_PLANKS') {
            const logName = LOG_ITEMS.find(name => (inventory[name] || 0) > 0);
            return {
                action: 'craft',
                item: plankForLog(logName || 'oak_log'),
                count: 16 - totalPlanks(inventory),
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

        if (level.id === 'L12_PREPARE_MINING_KIT') {
            if (foodScore(inventory) < 16 && !food.isTemporarilyUnavailable()) {
                return {
                    action: 'find_food',
                    reason: 'Level 12: collect food before mining'
                };
            }
            return {
                action: 'prepare_mining_kit',
                reason: 'Level 12: prepare furnace, fuel, torches, and blocks'
            };
        }

        if (level.id === 'L13_SAFE_IRON_MINE') {
            return {
                action: 'mine_iron',
                count: 16,
                reason: 'Level 13: open safe mine and find first iron'
            };
        }

        if (level.id === 'L14_COLLECT_RAW_IRON') {
            return {
                action: 'mine_iron',
                count: 17,
                reason: 'Level 14: collect enough raw iron for kit and reserve'
            };
        }

        if (level.id === 'L15_SMELT_IRON') {
            return {
                action: 'smelt_item',
                input: 'raw_iron',
                output: 'iron_ingot',
                count: Math.max(1, Math.min(8, 17 - (inventory.iron_ingot || 0))),
                reason: 'Level 15: smelt raw iron into ingots'
            };
        }

        if (level.id === 'L16_CRAFT_IRON_KIT') {
            return {
                action: 'craft_iron_kit',
                reason: 'Level 16: craft iron tools, shield, and armor'
            };
        }

        if (level.id === 'L11_STABLE_SURVIVAL') {
            if (!iron.hasIronCoreKit(inventory)) {
                return {
                    action: 'prepare_mining_kit',
                    reason: 'Routine: advance toward iron age'
                };
            }

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
        if (action.action === 'prepare_mining_kit') return action;
        if (action.action === 'mine_iron') return action;
        if (action.action === 'smelt_item') return action;
        if (action.action === 'craft_iron_kit') return action;
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
        if (observation.hasPlacedCraftingTable === true) {
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

function hasMiningKit(observation) {
    const inventory = observation.inventory;
    if (iron.hasIronCoreKit(inventory)) return true;
    const hasFurnace = (inventory.furnace || 0) > 0 ||
        observation.nearbyBlocks.some(block => block.name === 'furnace' && block.distance <= 16) ||
        (inventory.charcoal || 0) > 0;
    const hasFuel = (inventory.coal || 0) > 0 ||
        (inventory.charcoal || 0) > 0 ||
        totalLogs(inventory) > 0;
    const hasTools = (inventory.stone_pickaxe || 0) > 0 &&
        ((inventory.stone_sword || 0) > 0 || (inventory.iron_sword || 0) > 0);
    const hasBlocks = ((inventory.cobblestone || 0) + (inventory.dirt || 0)) >= 16;
    const hasFood = foodScore(inventory) >= 16 || food.isTemporarilyUnavailable();
    return hasFurnace && hasFuel && (inventory.torch || 0) >= 16 && hasTools && hasBlocks && hasFood;
}

function rawIronPotential(inventory) {
    return (inventory.raw_iron || 0) + (inventory.iron_ingot || 0);
}

function shouldOrganizeInventory(inventory, observation) {
    if (observation.hasUsableChest !== true) return false;
    if (observation.storageReady === false) return false;
    const itemTypes = Object.keys(inventory).length;
    const disposable = ['egg', 'oak_sapling', 'oak_door', 'dirt', 'cobblestone']
        .some(name => (inventory[name] || 0) > keepRoutineCount(name));
    return itemTypes >= 12 || disposable;
}

function keepRoutineCount(itemName) {
    if (itemName === 'dirt' || itemName === 'cobblestone') return 32;
    if (itemName === 'oak_sapling') return 1;
    if (itemName === 'oak_door') return 1;
    return 0;
}

module.exports = SkillTree;
