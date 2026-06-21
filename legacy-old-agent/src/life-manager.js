const { safeFoodInventoryCount } = require('./utils');

const DANGEROUS_FOODS = new Set([
    'chorus_fruit',
    'pufferfish',
    'poisonous_potato',
    'rotten_flesh',
    'spider_eye',
    'suspicious_stew',
    'raw_chicken'
]);

class LifeManager {
    constructor(bot, memory) {
        this.bot = bot;
        this.memory = memory;
        this.lastSleepGoalAt = 0;
        this.baseNightWaitStartedAt = 0;
    }

    choosePriority(observation) {
        const action = this.chooseImmediateAction(observation);
        if (action) {
            return {
                type: 'action',
                action
            };
        }

        const goals = this.createPriorityGoals(observation);
        if (goals.length > 0) {
            return {
                type: 'goals',
                goals
            };
        }

        return null;
    }

    chooseImmediateAction(observation) {
        if (observation.health <= 12 && observation.food <= 18) {
            const emergencyFood = this.bestFood(true);
            if (emergencyFood) {
                return {
                    type: 'eat',
                    item: emergencyFood.name,
                    reason: `Can cok dusuk (${observation.health}/20); acil beslen`
                };
            }
        }

        if (observation.health < 16 && observation.food < 18) {
            const recoveryFood = this.bestFood(false);
            if (recoveryFood) {
                return {
                    type: 'eat',
                    item: recoveryFood.name,
                    reason: `Can ${observation.health}/20; iyilesmek icin acligi doldur`
                };
            }
        }

        if (
            observation.health <= 12 &&
            (observation.hostileMobs || []).length === 0 &&
            observation.food >= 18
        ) {
            return {
                type: 'idle',
                until: Date.now() + 10000,
                reason: `Can cok dusuk (${observation.health}/20); iyilesmeyi bekle`
            };
        }

        if (observation.food <= 14) {
            const food = this.bestFood(observation.food <= 8);
            if (food) {
                return {
                    type: 'eat',
                    item: food.name,
                    reason: `Aclik seviyesi ${observation.food}/20`
                };
            }
        }

        if (this.shouldRecoverItemsBeforeFood(observation)) {
            return null;
        }

        const criticallyHungryWithoutFood =
            observation.food <= 8 &&
            !this.bestFood(true);
        const nightAction = this.nightSurfaceAction(observation);
        if (nightAction && observation.food > 2 && !criticallyHungryWithoutFood) {
            return nightAction;
        }

        if (observation.food <= 8 && !this.bestFood(true)) {
            return null;
        }

        if (nightAction && !criticallyHungryWithoutFood) {
            return nightAction;
        }

        if (observation.inventory.emptySlots <= 3) {
            if (
                this.memory?.data.ironArmorEquipped &&
                !this.memory?.data.storageSystem
            ) {
                return null;
            }
            const chest = this.findNearbyChest();
            if (chest) {
                return {
                    type: 'store_items',
                    reason: 'Envanter dolmak uzere'
                };
            }

            if (observation.inventory.items.chest) {
                return {
                    type: 'place_storage',
                    reason: 'Envanter dolmak uzere; depo kur'
                };
            }
        }

        return null;
    }

    createPriorityGoals(observation) {
        const hasBasicTool = this.bot.inventory.items()
            .some(item =>
                item.name === 'wooden_pickaxe' ||
                item.name === 'stone_pickaxe'
            );
        const hasWeapon = this.bot.inventory.items()
            .some(item =>
                item.name.endsWith('_sword') ||
                item.name.endsWith('_axe')
            );
        const visibleFoodMob = this.visibleFoodMob(observation);
        if (this.shouldRecoverItemsBeforeFood(observation)) return [];

        const deferFoodSearchForNight = this.shouldDeferFoodSearchForNight(observation);
        const shouldSeekFood =
            (
                observation.health <= 6 &&
                observation.food < 18 &&
                !this.bestFood(true)
            ) ||
            (
                observation.health <= 10 &&
                (
                    observation.food <= 14 ||
                    (
                        observation.food < 18 &&
                        hasBasicTool &&
                        hasWeapon &&
                        visibleFoodMob
                    )
                ) &&
                !this.bestFood(true)
            ) ||
            observation.food <= 8 ||
            (
                observation.food <= 12 &&
                hasBasicTool &&
                hasWeapon &&
                visibleFoodMob
            );
        if (shouldSeekFood && !this.bestFood(observation.food <= 8)) {
            if (deferFoodSearchForNight) return [];
            return [{
                type: 'find_food',
                reason: `Aclik kritik seviyede: ${observation.food}/20`
            }];
        }

        const safeFoodStock = safeFoodInventoryCount(this.bot);
        const shouldBuildFoodStock =
            safeFoodStock < 16 &&
            hasBasicTool &&
            hasWeapon &&
            this.hasBase() &&
            !observation.isNight &&
            observation.health >= 16 &&
            observation.food > 6;
        if (shouldBuildFoodStock) {
            return [{
                type: 'find_food',
                count: 16,
                reason: `Yemek stogu dusuk: ${safeFoodStock}/16`
            }];
        }

        const hasBed = this.findNearbyBed() ||
            this.bot.inventory.items().some(item => item.name.endsWith('_bed')) ||
            (this.memory?.data.beds?.length || 0) > 0;
        if (
            observation.isNight &&
            this.bot.game?.difficulty !== 'peaceful' &&
            !this.isUnderground(observation) &&
            observation.food > 10 &&
            hasBasicTool &&
            !hasBed
        ) {
            return [{
                type: 'acquire_item',
                item: 'white_bed',
                count: 1,
                reason: 'Gece uyuyabilmek icin yatak edin'
            }];
        }

        if (
            observation.inventory.emptySlots <= 6 &&
            !this.findNearbyChest() &&
            !observation.inventory.items.chest &&
            !this.memory?.data.ironArmorEquipped
        ) {
            return [{
                type: 'acquire_item',
                item: 'chest',
                count: 1,
                reason: 'Toplanan esyalar icin depo kur'
            }];
        }

        return [];
    }

    nightSurfaceAction(observation, options = {}) {
        const { updateSleepGoal = true } = options;
        if (
            !observation.isNight ||
            this.bot.game?.difficulty === 'peaceful' ||
            this.isUnderground(observation)
        ) {
            return null;
        }

        const base = this.memory?.data.base || this.memory?.data.shelter;
        const hasBed =
            this.findNearbyBed() ||
            this.bot.inventory.items().some(item => item.name.endsWith('_bed'));
        const safeBaseWithoutBed =
            base &&
            !hasBed &&
            observation.health >= 16 &&
            observation.food >= 10 &&
            (observation.hostileMobs || []).length === 0;
        if (safeBaseWithoutBed) {
            if (!this.baseNightWaitStartedAt) {
                this.baseNightWaitStartedAt = Date.now();
            }
            if (Date.now() - this.baseNightWaitStartedAt >= 120000) {
                return null;
            }
        } else {
            this.baseNightWaitStartedAt = 0;
        }

        if (
            base ||
            hasBed ||
            Date.now() - this.lastSleepGoalAt >= 15000
        ) {
            if (updateSleepGoal) this.lastSleepGoalAt = Date.now();
            return {
                type: 'survive_night',
                reason: 'Gece yuzeyde; yatak/base/siginak oncelikli'
            };
        }
        return {
            type: 'idle',
            until: Date.now() + 5000,
            reason: 'Gece yuzeyde; normal hedefleri beklet'
        };
    }

    shouldDeferFoodSearchForNight(observation) {
        return Boolean(
            this.nightSurfaceAction(observation, { updateSleepGoal: false }) &&
            observation.food > 8 &&
            !this.bestFood(true)
        );
    }

    bestFood(allowEmergencyFood = false) {
        return this.bot.inventory.items()
            .map(item => ({
                item,
                food: this.bot.registry.foodsByName[item.name]
            }))
            .filter(entry =>
                entry.food &&
                (
                    !DANGEROUS_FOODS.has(entry.item.name) ||
                    (
                        allowEmergencyFood &&
                        entry.item.name === 'rotten_flesh'
                    )
                )
            )
            .sort((a, b) =>
                b.food.effectiveQuality - a.food.effectiveQuality
            )[0]?.item || null;
    }

    findNearbyBed() {
        return this.bot.findBlock({
            matching: block => this.bot.isABed(block),
            maxDistance: 24
        });
    }

    findNearbyChest() {
        const chestId = this.bot.registry.blocksByName.chest?.id;
        if (!chestId) return null;
        return this.bot.findBlock({ matching: chestId, maxDistance: 24 });
    }

    shouldRecoverItemsBeforeFood(observation) {
        const death = this.memory?.data.deathPosition;
        return (
            (death?.itemCount || 0) > 0 &&
            observation.food > 6 &&
            observation.health > 4 &&
            !this.bestFood(true)
        );
    }

    hasBase() {
        return Boolean(this.memory?.data.base || this.memory?.data.shelter);
    }

    visibleFoodMob(observation) {
        return observation.nearbyMobs?.some(mob =>
            ['cow', 'pig', 'sheep', 'rabbit', 'cod', 'salmon'].includes(mob.name)
        );
    }

    isUnderground(observation) {
        const y = observation.position?.y ?? this.bot.entity?.position?.y;
        if (y == null) return false;

        const referenceY =
            this.memory?.data.base?.y ??
            this.memory?.data.shelter?.y ??
            this.memory?.data.surfaceAnchor?.y ??
            this.memory?.data.home?.y;

        if (referenceY != null) return y <= referenceY - 3;
        if (this.hasOpenSky()) return false;
        return y <= 50;
    }

    hasOpenSky() {
        const position = this.bot.entity?.position;
        if (!position?.offset || !this.bot.blockAt) return false;

        for (let dy = 1; dy <= 16; dy++) {
            const block = this.bot.blockAt(position.offset(0, dy, 0));
            if (!block) return false;
            if (
                block.boundingBox === 'block' &&
                !block.name.endsWith('_leaves') &&
                block.name !== 'vine'
            ) {
                return false;
            }
        }

        return true;
    }
}

module.exports = LifeManager;
