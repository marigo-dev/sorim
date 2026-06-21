class SurvivalStateMachine {
    constructor(options = {}) {
        this.bot = options.bot;
        this.memory = options.memory || null;
        this.lifeManager = options.lifeManager || null;
        this.combatSurvival = options.combatSurvival || null;
    }

    updateContext({ bot, memory, lifeManager, combatSurvival } = {}) {
        if (bot) this.bot = bot;
        if (memory) this.memory = memory;
        if (lifeManager) this.lifeManager = lifeManager;
        if (combatSurvival) this.combatSurvival = combatSurvival;
    }

    choose(observation, context = {}) {
        const state = this.classify(observation, context);

        if (state === 'COMBAT_DEFENSE') {
            const action = context.dangerReflex;
            const override = context.survivalOverride || null;
            if (override) {
                return {
                    state: 'SAFE_RECOVERY',
                    type: 'action',
                    action: override,
                    survival: true
                };
            }
            return {
                state,
                type: 'action',
                action,
                danger: true
            };
        }

        if (state === 'SURVIVAL_CRITICAL' && observation.inWater) {
            return {
                state,
                type: 'action',
                action: { type: 'swim' },
                survival: true
            };
        }

        const lifePriority = this.lifeManager?.choosePriority
            ? this.lifeManager.choosePriority(observation)
            : null;
        if (lifePriority?.type === 'action') {
            return {
                state: this.stateForLifeAction(lifePriority.action),
                type: 'action',
                action: lifePriority.action,
                survival: true
            };
        }
        if (lifePriority?.type === 'goals') {
            return {
                state: this.stateForGoals(lifePriority.goals),
                type: 'goals',
                goals: lifePriority.goals
            };
        }

        return {
            state,
            type: 'strategic'
        };
    }

    classify(observation, context = {}) {
        if (context.dangerReflex) return 'COMBAT_DEFENSE';
        if (observation.inWater) return 'SURVIVAL_CRITICAL';
        if (observation.health <= 8 || observation.food <= 6) {
            return 'SURVIVAL_CRITICAL';
        }
        if (observation.health <= 12 || observation.food <= 12) {
            return 'SAFE_RECOVERY';
        }
        if (observation.inventory?.emptySlots <= 3) {
            return 'INVENTORY_MANAGEMENT';
        }
        if (this.needsFoodEconomy(observation)) {
            return 'FOOD_ECONOMY';
        }
        if (observation.isNight && !this.isUnderground(observation)) {
            return 'SAFE_RECOVERY';
        }
        return this.progressionState(observation);
    }

    progressionState(observation) {
        const memory = this.memory?.data || {};
        const inventory = observation.inventory?.items || {};

        if (!inventory.wooden_pickaxe && !inventory.stone_pickaxe) {
            return 'EARLY_GAME';
        }
        if (!memory.shelter || !memory.upgradedBase || !memory.beautifulHouse) {
            return 'BASE_BUILDING';
        }
        if (!memory.farm || !memory.expandedFarm) {
            return 'FOOD_ECONOMY';
        }
        if (!memory.storageSystem || observation.inventory?.emptySlots <= 8) {
            return 'INVENTORY_MANAGEMENT';
        }
        if (!memory.ironArmorEquipped || !memory.deepMine || !memory.diamondArmorEquipped) {
            return 'MINING_PROGRESS';
        }
        return 'LONG_TERM_GOAL';
    }

    stateForLifeAction(action) {
        if (!action) return 'SAFE_RECOVERY';
        if (action.type === 'eat') return 'SURVIVAL_CRITICAL';
        if (action.type === 'store_items' || action.type === 'place_storage') {
            return 'INVENTORY_MANAGEMENT';
        }
        if (action.type === 'survive_night' || action.type === 'idle') {
            return 'SAFE_RECOVERY';
        }
        return 'SURVIVAL_CRITICAL';
    }

    stateForGoals(goals = []) {
        if (goals.some(goal => goal.type === 'find_food')) return 'FOOD_ECONOMY';
        if (goals.some(goal => goal.type === 'organize_storage')) {
            return 'INVENTORY_MANAGEMENT';
        }
        if (goals.some(goal => goal.type === 'survive_night')) {
            return 'SAFE_RECOVERY';
        }
        return 'EARLY_GAME';
    }

    needsFoodEconomy(observation) {
        const inventory = observation.inventory?.items || {};
        const hasBasicTool = Boolean(
            inventory.wooden_pickaxe ||
            inventory.stone_pickaxe ||
            inventory.iron_pickaxe ||
            inventory.diamond_pickaxe
        );
        const hasWeapon = Boolean(
            inventory.wooden_sword ||
            inventory.stone_sword ||
            inventory.iron_sword ||
            inventory.diamond_sword ||
            inventory.wooden_axe ||
            inventory.stone_axe ||
            inventory.iron_axe ||
            inventory.diamond_axe
        );
        const safeFood = Object.entries(inventory)
            .filter(([name]) => this.bot?.registry?.foodsByName?.[name])
            .reduce((total, [, count]) => total + count, 0);
        return Boolean(
            this.memory?.data?.base &&
            hasBasicTool &&
            hasWeapon &&
            safeFood < 16 &&
            observation.health >= 16 &&
            observation.food >= 14
        );
    }

    isUnderground(observation) {
        const y = observation.position?.y ?? this.bot?.entity?.position?.y;
        if (y == null) return false;
        const referenceY =
            this.memory?.data?.base?.y ??
            this.memory?.data?.shelter?.y ??
            this.memory?.data?.surfaceAnchor?.y ??
            this.memory?.data?.home?.y;
        if (referenceY == null) return y <= 50;
        return y <= Math.max(1, referenceY) - 3;
    }
}

module.exports = SurvivalStateMachine;
