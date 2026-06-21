const { AsyncLocalStorage } = require('async_hooks');
const { Vec3 } = require('vec3');
const { goals, Movements } = require('mineflayer-pathfinder');
const {
    sleep,
    entityName,
    inventoryCount,
    isSafeFoodItem,
    safeFoodInventoryCount
} = require('./utils');

class Skills {
    constructor(bot, memory = null) {
        this.bot = bot;
        this.memory = memory;
        this.surfaceAnchor = null;
        this.lastSleepAttemptAt = 0;
        this.blocksSinceTorch = 0;
        this.interactionSequence = 1;
        this.failedMineTargets = new Map();
        this.failedMineEvents = [];
        this.failedMineAreas = [];
        this.actionContext = new AsyncLocalStorage();
        this.nextActionToken = 1;
        this.runningActionTokens = new Set();
        this.cancelledActionTokens = new Set();
        this.cancelReason = 'Aksiyon iptal edildi';
    }

    setSurfaceAnchor(position) {
        const origin = position.floored();
        const base = this.memory?.data.base || this.memory?.data.shelter;
        if (base) {
            this.surfaceAnchor = new Vec3(base.x, base.y, base.z);
            this.normalizeSurfaceAnchor();
            console.log(`Yuzey referansi: ${this.surfaceAnchor.toString()}`);
            return;
        }
        const savedAnchor = this.memory?.data.surfaceAnchor || this.memory?.data.home;
        if (savedAnchor) {
            const distance = Math.hypot(
                savedAnchor.x - origin.x,
                savedAnchor.z - origin.z
            );
            if (distance <= 48) {
                this.surfaceAnchor = new Vec3(
                    savedAnchor.x,
                    savedAnchor.y,
                    savedAnchor.z
                );
                this.normalizeSurfaceAnchor();
                console.log(`Yuzey referansi: ${this.surfaceAnchor.toString()}`);
                return;
            }
            console.log(
                `Kayitli yuzey referansi uzak (${Math.round(distance)} blok); yerel referans aranacak.`
            );
        }

        let best = null;
        let bestScore = Infinity;

        for (let dx = -8; dx <= 8; dx++) {
            for (let dz = -8; dz <= 8; dz++) {
                for (let y = Math.max(1, origin.y - 48); y <= origin.y + 24; y++) {
                    const candidate = new Vec3(origin.x + dx, y, origin.z + dz);
                    const feet = this.bot.blockAt(candidate);
                    const head = this.bot.blockAt(candidate.offset(0, 1, 0));
                    const floor = this.bot.blockAt(candidate.offset(0, -1, 0));
                    const unstableFloor =
                        floor?.name.endsWith('_leaves') ||
                        floor?.name.endsWith('_log');

                    const score =
                        Math.abs(y - origin.y) * 5 +
                        Math.sqrt(dx * dx + dz * dz);
                    if (
                        feet?.name === 'air' &&
                        head?.name === 'air' &&
                        floor?.boundingBox === 'block' &&
                        !unstableFloor &&
                        score < bestScore
                    ) {
                        best = candidate;
                        bestScore = score;
                    }
                }
            }
        }

        this.surfaceAnchor = best || origin;
        this.normalizeSurfaceAnchor();
        this.rememberSurfaceAnchor();
        console.log(`Yuzey referansi: ${this.surfaceAnchor.toString()}`);
    }

    normalizeSurfaceAnchor() {
        if (this.surfaceAnchor && this.surfaceAnchor.y < 1) {
            this.surfaceAnchor = new Vec3(
                this.surfaceAnchor.x,
                1,
                this.surfaceAnchor.z
            );
        }
    }

    async execute(action) {
        const token = this.nextActionToken++;
        this.runningActionTokens.add(token);

        return this.actionContext.run({ token }, async () => {
            try {
                this.assertActionActive();
                await this.openShelterBarricadeFor(action);
                this.assertActionActive();
                return this.dispatch(action);
            } finally {
                this.runningActionTokens.delete(token);
                this.cancelledActionTokens.delete(token);
            }
        });
    }

    dispatch(action) {
        switch (action.type) {
            case 'mine':
                return this.mine(action);
            case 'craft':
                return this.craft(action);
            case 'place_workstation':
                return this.placeCraftingTable();
            case 'return_workstation':
                return this.returnCraftingTable(action);
            case 'explore':
                return this.explore(action);
            case 'idle':
                return this.idle(action);
            case 'wait_out_night':
                return this.waitOutNight(action);
            case 'survive_night':
                return this.surviveNight(action);
            case 'recover_items':
                return this.recoverItems(action);
            case 'dig_staircase':
                return this.digStaircase(action);
            case 'return_surface':
                return this.returnSurface();
            case 'escape_pit':
                return this.escapePit(action);
            case 'eat':
                return this.eat(action);
            case 'sleep':
                return this.sleepInBed();
            case 'place_bed':
                return this.placeBed();
            case 'hunt_food':
                return this.huntFood(action);
            case 'hunt_mob':
                return this.huntMob([action.mob]);
            case 'place_storage':
                return this.placeStorage();
            case 'store_items':
                return this.storeItems();
            case 'prepare_loadout':
                return this.prepareLoadout(action);
            case 'build_shelter':
                return this.buildShelter();
            case 'emergency_shelter':
                return this.emergencyShelter();
            case 'barricade_shelter':
                return this.barricadeShelter();
            case 'return_base':
                return this.returnBase();
            case 'establish_mine':
                return this.establishMine(action);
            case 'mine_tunnel':
                return this.mineTunnel(action);
            case 'smelt':
                return this.smelt(action);
            case 'fill_bucket':
                return this.fillBucket();
            case 'gather_seeds':
                return this.gatherSeeds(action);
            case 'gather_saplings':
                return this.gatherSaplings(action);
            case 'build_farm':
                return this.buildFarm(action);
            case 'upgrade_base':
                return this.upgradeBase();
            case 'equip_iron_armor':
                return this.equipIronArmor();
            case 'build_house':
                return this.buildHouse();
            case 'organize_storage':
                return this.organizeStorage();
            case 'expand_farm':
                return this.expandFarm();
            case 'establish_tree_garden':
                return this.establishTreeGarden();
            case 'maintain_tree_garden':
                return this.maintainTreeGarden();
            case 'establish_deep_mine':
                return this.establishDeepMine();
            case 'equip_diamond_armor':
                return this.equipDiamondArmor();
            case 'build_nether_portal':
                return this.buildNetherPortal();
            case 'enter_nether':
                return this.enterNether();
            case 'flee':
                return this.flee(action);
            case 'fight':
                return this.fight(action);
            case 'swim':
                return this.swim();
            default:
                throw new Error(`Bilinmeyen eylem: ${action.type}`);
        }
    }

    cancelCurrentAction(reason = 'Aksiyon iptal edildi') {
        for (const token of this.runningActionTokens) {
            this.cancelledActionTokens.add(token);
        }
        this.cancelReason = reason;
        this.stop();
    }

    assertActionActive() {
        const token = this.actionContext.getStore()?.token;
        if (token && this.cancelledActionTokens.has(token)) {
            throw new Error(this.cancelReason || 'Aksiyon iptal edildi');
        }
        if (this.bot.health <= 0) {
            throw new Error('Aksiyon iptal edildi: bot oldu');
        }
    }

    async mine(action) {
        const blockType = this.bot.registry.blocksByName[action.block];
        if (!blockType) throw new Error(`Bilinmeyen blok: ${action.block}`);

        let block = this.findSafeMineTarget(blockType);
        if (!block) {
            if (this.isWoodBlock(action.block)) {
                return this.explore({
                    resource: 'herhangi_bir_odun',
                    candidates: [
                        'oak_log',
                        'spruce_log',
                        'birch_log',
                        'jungle_log',
                        'acacia_log',
                        'cherry_log',
                        'dark_oak_log',
                        'mangrove_log'
                    ],
                    reason: `${action.block} hedefi gorunur ama ulasilabilir degil; yeni agac ara`
                });
            }
            if (action.item === 'diamond' || action.block.includes('diamond_ore')) {
                return this.mineTunnel({
                    resource: 'diamond',
                    candidates: ['diamond_ore', 'deepslate_diamond_ore'],
                    reason: 'Elmas gorunmuyor; yeni guvenli maden kolu ac'
                });
            }
            if (action.block === 'stone' || action.block === 'deepslate') {
                return this.digStaircase({
                    resource: action.item,
                    reason: `${action.block} icin yeni damar ac`
                });
            }
            if (action.block === 'cobblestone') {
                return this.digStaircase({
                    resource: action.item,
                    reason: 'Gorunen cobblestone erisilemez; guvenli tas damari ac'
                });
            }
            throw new Error(`${action.block} bulunamadi`);
        }
        if (this.isWoodBlock(action.block)) {
            block = this.lowestReachableWoodBlock(block) || block;
        }

        await this.equipTool(blockType);
        try {
            await this.goto(new goals.GoalLookAtBlock(
                block.position,
                this.bot.world,
                { reach: 4.5 }
            ), 20000);
        } catch (error) {
            this.rememberFailedMineTarget(block);
            if (
                this.isWoodBlock(action.block) &&
                this.shouldDescendFromHighSpot()
            ) {
                const descended = await this.descendFromHighSpot(
                    `${action.block} hedefine yol bulunamadi`
                );
                if (descended) return;
            }
            throw error;
        }

        const currentBlock = this.bot.blockAt(block.position);
        if (!currentBlock || currentBlock.name !== action.block) {
            throw new Error(`${action.block} hedefe ulasilmadan kayboldu`);
        }
        if (!this.bot.canDigBlock(currentBlock)) {
            await this.gotoProjectWorkPosition(currentBlock.position);
            await this.bot.lookAt(
                currentBlock.position.offset(0.5, 0.5, 0.5),
                true
            );
        }
        if (!this.bot.canDigBlock(currentBlock)) {
            this.rememberFailedMineTarget(currentBlock);
            const distance = currentBlock.position
                .offset(0.5, 0.5, 0.5)
                .distanceTo(this.bot.entity.position.offset(0, 1.65, 0));
            throw new Error(
                `${action.block} kirilamiyor (mesafe=${distance.toFixed(2)})`
            );
        }

        const tool = await this.equipBestTool(currentBlock);
        if (tool) {
            console.log(`Kazma aleti: ${tool.name}`);
        }
        const expectedDrop = action.item || this.primaryDropName(currentBlock);
        const beforeCount = expectedDrop
            ? inventoryCount(this.bot, expectedDrop)
            : 0;
        await this.bot.dig(currentBlock);
        if (!this.isWoodBlock(currentBlock.name)) {
            this.blocksSinceTorch += 1;
            await this.maybePlaceTorch();
        }
        await this.stepTowardMinedDrop(currentBlock.position);
        await this.waitForInventoryIncrease(expectedDrop, beforeCount, 900);
        if (
            expectedDrop &&
            inventoryCount(this.bot, expectedDrop) <= beforeCount
        ) {
            for (const radius of [12, 16, 24, 32]) {
                const collected = await this.collectNearbyDrops(expectedDrop, radius);
                if (
                    collected ||
                    await this.waitForInventoryIncrease(expectedDrop, beforeCount, 900)
                ) {
                    break;
                }
                await sleep(400);
            }
            if (inventoryCount(this.bot, expectedDrop) <= beforeCount) {
                for (const radius of [8, 16, 24]) {
                    await this.collectNearbyDrops(null, radius);
                    if (await this.waitForInventoryIncrease(expectedDrop, beforeCount, 900)) {
                        break;
                    }
                }
            }
        } else {
            await this.collectNearbyDrops(null, 4);
        }

        const gainedDrop =
            !expectedDrop ||
            inventoryCount(this.bot, expectedDrop) > beforeCount;
        if (!gainedDrop) {
            this.rememberFailedMineTarget(currentBlock);
            throw new Error(
                `${expectedDrop} kazildi ama envantere alinamadi`
            );
        }
    }

    async stepTowardMinedDrop(position) {
        const yDistance = Math.abs(position.y - this.bot.entity.position.y);
        if (yDistance > 2) {
            try {
                await this.goto(new goals.GoalNearXZ(
                    position.x,
                    position.z,
                    1
                ), 5000);
                return;
            } catch {
                // Fall back to the full 3D target below.
            }
        }

        try {
            await this.goto(new goals.GoalNear(
                position.x,
                position.y,
                position.z,
                1
            ), 5000);
        } catch {
            try {
                await this.goto(new goals.GoalNearXZ(
                    position.x,
                    position.z,
                    1
                ), 5000);
            } catch {
                // Drop collection will still scan nearby item entities below.
            }
        }
    }

    async waitForInventoryIncrease(itemName, beforeCount, timeoutMs = 1000) {
        if (!itemName) {
            await sleep(timeoutMs);
            return false;
        }

        const endAt = Date.now() + timeoutMs;
        while (Date.now() < endAt) {
            if (inventoryCount(this.bot, itemName) > beforeCount) return true;
            await sleep(100);
        }
        return inventoryCount(this.bot, itemName) > beforeCount;
    }

    async craft(action) {
        const item = this.bot.registry.itemsByName[action.item];
        if (!item) throw new Error(`Bilinmeyen item: ${action.item}`);

        const table = action.requiresTable
            ? await this.ensureCraftingTableForCraft()
            : null;
        if (action.requiresTable && !table) {
            throw new Error('Crafting table yakinda degil');
        }

        const recipe = this.bot.recipesFor(
            item.id,
            null,
            action.count,
            table
        )[0];
        if (!recipe) {
            throw new Error(`${action.item} icin kullanilabilir tarif yok`);
        }

        const operations = Math.ceil(action.count / recipe.result.count);
        for (let operation = 0; operation < operations; operation++) {
            const currentRecipe = this.bot.recipesFor(
                item.id,
                null,
                1,
                table
            )[0];
            if (!currentRecipe) {
                throw new Error(`${action.item} icin malzeme kalmadi`);
            }
            await this.bot.craft(currentRecipe, 1, table);
            await sleep(250);
        }
    }

    async placeCraftingTable() {
        if (this.findNearbyCraftingTable()) return;

        const item = this.bot.inventory.items()
            .find(entry => entry.name === 'crafting_table');
        if (!item) throw new Error('Crafting table envanterde yok');

        const placement = this.findPlacement();
        if (!placement) {
            const carved = await this.createPlacementNook();
            if (!carved) throw new Error('Crafting table icin bos zemin yok');
            await this.bot.equip(item, 'hand');
            await this.bot.placeBlock(carved.reference, new Vec3(0, 1, 0));
            this.rememberCraftingTable(carved.target);
            await sleep(500);
            return;
        }

        await this.bot.equip(item, 'hand');
        await this.bot.placeBlock(placement.reference, new Vec3(0, 1, 0));
        this.rememberCraftingTable(placement.target);
        await sleep(500);
    }

    async ensureCraftingTableForCraft() {
        let table = this.findNearbyCraftingTable(4);
        if (table) {
            this.rememberCraftingTable(table.position);
            return table;
        }

        if (this.bot.inventory.items().some(item => item.name === 'crafting_table')) {
            await this.placeCraftingTable();
            table = this.findNearbyCraftingTable(4);
            if (table) {
                this.rememberCraftingTable(table.position);
                return table;
            }
        }

        await this.returnCraftingTable({
            workstation: 'crafting_table',
            reason: 'Craft icin mevcut crafting table yakinina git'
        });

        table = this.findNearbyCraftingTable(4);
        if (table) {
            this.rememberCraftingTable(table.position);
        }
        return table;
    }

    async returnCraftingTable(action = {}) {
        const nearby = this.findNearbyCraftingTable(4);
        if (nearby) {
            this.rememberCraftingTable(nearby.position);
            return;
        }

        const table = this.findVisibleCraftingTable(16) ||
            this.nearestKnownCraftingTable(64);
        if (!table) throw new Error('Bilinen crafting table yok');

        const position = table.position || table;
        console.log(
            `Crafting table'a donuluyor: (${position.x}, ${position.y}, ${position.z})`
        );

        const movements = this.createMovements(true, true);
        this.bot.pathfinder.setMovements(movements);
        try {
            await this.goto(
                new goals.GoalNear(position.x, position.y, position.z, 2),
                30000
            );
        } catch (error) {
            console.log(`Crafting table yolu bulunamadi: ${error.message}`);
            if (
                this.surfaceAnchor &&
                position.y >= this.bot.entity.position.y + 2
            ) {
                await this.returnSurface();
                await this.goto(
                    new goals.GoalNear(position.x, position.y, position.z, 2),
                    30000
                );
            } else {
                throw error;
            }
        } finally {
            this.bot.pathfinder.setMovements(this.createMovements(false));
        }

        const reached = this.findNearbyCraftingTable(5);
        if (reached) {
            this.rememberCraftingTable(reached.position);
            return;
        }

        const block = this.bot.blockAt(position);
        if (block?.name === 'crafting_table') {
            this.rememberCraftingTable(position);
            return;
        }

        this.forgetCraftingTable(position);
        throw new Error('Crafting table konumuna gidildi ama masa bulunamadi');
    }

    async explore(action) {
        const resource = action.resource || 'genel';
        if (this.shouldDescendFromHighSpot()) {
            const descended = await this.descendFromHighSpot(
                'Kesif oncesi yuksek/kararsiz noktadan iniliyor'
            );
            if (descended) return;
        }

        const start = this.bot.entity.position.clone();
        const target = this.chooseExplorationTarget(resource);
        const distance = Math.round(
            this.bot.entity.position.distanceTo(target)
        );

        console.log(
            `Uzun kesif: ${resource} hedef=(${target.x}, ${target.z}) mesafe=${distance}`
        );

        let result;
        try {
            result = await this.travelExplorationDirection(
                target,
                action.candidates || []
            );
        } catch (error) {
            this.memory?.rememberExplored(target, resource);
            throw error;
        }
        if (result.resourceFound) {
            console.log(
                `Kesif sirasinda kaynak bulundu: ${result.resourceFound.name} ` +
                `konum=${result.resourceFound.position.toString()}`
            );
            try {
                await this.goto(new goals.GoalNear(
                    result.resourceFound.position.x,
                    result.resourceFound.position.y,
                    result.resourceFound.position.z,
                    3
                ), 30000);
            } catch (error) {
                console.log('Kaynak yuksekligine cikilamadi, XZ yakinina gidiliyor:', error.message);
                try {
                    await this.goto(new goals.GoalNearXZ(
                        result.resourceFound.position.x,
                        result.resourceFound.position.z,
                        2
                    ), 30000);
                } catch (xzError) {
                    this.rememberFailedMineTarget(result.resourceFound);
                    this.memory?.rememberExplored(
                        result.resourceFound.position,
                        resource
                    );
                    throw xzError;
                }
            }
        }
        this.memory?.rememberExplored(
            result.position || this.bot.entity.position,
            resource
        );

        const moved = this.horizontalDistance(start, this.bot.entity.position);
        if (!result.resourceFound && moved < 3) {
            console.log('Kesif ilerleme saglamadi; hedef denendi sayilip kurtarma yuruyusu yapiliyor.');
            this.memory?.rememberExplored(target, resource);
            const movedAfterNudge = await this.manualExplorationNudge(target, start);
            if (movedAfterNudge >= 3) {
                console.log(`Kesif kurtarma yuruyusu ise yaradi: ${movedAfterNudge.toFixed(1)} blok.`);
                return;
            }
            if (
                this.surfaceAnchor &&
                this.bot.entity.position.y < this.surfaceAnchor.y
            ) {
                await this.carveEscapeStaircase();
            }
            throw new Error('Kesif konum degistirmedi');
        }
    }

    async manualExplorationNudge(target, startPosition, durationMs = 3500) {
        if (this.shouldDescendFromHighSpot()) {
            const descended = await this.descendFromHighSpot(
                'Kesif kurtarmasi yerine once guvenli inis'
            );
            if (!descended) return this.horizontalDistance(startPosition, this.bot.entity.position);
        }

        const safePoint = this.findSafeNudgePoint(target);
        if (!safePoint) {
            console.log('Kesif kurtarma yuruyusu atlandi: onde guvenli zemin yok.');
            return this.horizontalDistance(startPosition, this.bot.entity.position);
        }

        this.stop();
        const current = this.bot.entity.position;
        await this.bot.lookAt(
            safePoint.offset(0.5, 1, 0.5),
            true
        );
        this.bot.setControlState('forward', true);
        this.bot.setControlState('jump', true);
        await sleep(Math.min(durationMs, 1200));
        this.bot.clearControlStates();
        await sleep(250);
        return this.horizontalDistance(startPosition, this.bot.entity.position);
    }

    findSafeNudgePoint(target) {
        const current = this.bot.entity.position;
        const dx = target.x - current.x;
        const dz = target.z - current.z;
        const length = Math.hypot(dx, dz);
        if (length < 0.5) return null;

        const stepX = Math.round(dx / length);
        const stepZ = Math.round(dz / length);
        if (stepX === 0 && stepZ === 0) return null;

        const origin = current.floored();
        for (let step = 1; step <= 3; step++) {
            const candidate = origin.offset(stepX * step, 0, stepZ * step);
            const feet = this.bot.blockAt(candidate);
            const head = this.bot.blockAt(candidate.offset(0, 1, 0));
            const floor = this.bot.blockAt(candidate.offset(0, -1, 0));
            if (
                ['air', 'cave_air', 'void_air'].includes(feet?.name) &&
                ['air', 'cave_air', 'void_air'].includes(head?.name) &&
                floor?.boundingBox === 'block' &&
                !this.isUnstableStandingFloor(floor)
            ) {
                return candidate;
            }
        }

        return null;
    }

    async idle(action = {}) {
        const waitMs = Math.max(
            1000,
            Math.min(10000, (action.until || Date.now() + 5000) - Date.now())
        );
        console.log(`Bekleniyor: ${action.reason || 'kisa mola'} (${waitMs}ms)`);
        await this.sleepCancellable(waitMs);
    }

    async sleepCancellable(durationMs, stepMs = 500, check = null) {
        const endAt = Date.now() + durationMs;
        while (Date.now() < endAt) {
            this.assertActionActive();
            if (check) await check();
            await sleep(Math.min(stepMs, endAt - Date.now()));
        }
        this.assertActionActive();
        if (check) await check();
    }

    async waitOutNight(action = {}) {
        this.stop();
        const delay = Math.max(5000, Math.min(20000, action.delayMs || 10000));
        console.log(`Gece disarida bekleniyor; baglanti kesilmiyor (${Math.round(delay / 1000)}sn).`);
        await this.sleepCancellable(delay, 500, () => {
            const threat = this.nearestImmediateHostile(10);
            if (threat) {
                throw new Error(
                    `Gece bekleme kesildi: ${entityName(threat)} yaklasti`
                );
            }
        });
    }

    async surviveNight(action = {}) {
        if (this.shouldDescendFromHighSpot()) {
            const descended = await this.descendFromHighSpot(
                'Gece beklemeden once yuksek/kararsiz noktadan iniliyor'
            );
            if (descended) return;
        }

        if (this.isUnderground()) {
            console.log('Gece yuzeyde degilim; magarada guvenli calismaya devam edilebilir.');
            await sleep(5000);
            return;
        }

        const bed = this.bot.findBlock({
            matching: block => this.bot.isABed(block),
            maxDistance: 24
        });
        if (bed) return this.sleepInBed();

        const carriedBed = this.bot.inventory.items()
            .find(item => item.name.endsWith('_bed'));
        if (carriedBed) {
            await this.placeBed();
            return this.sleepInBed();
        }

        const base = this.memory?.data.base || this.memory?.data.shelter;
        if (base) {
            const basePosition = new Vec3(base.x, base.y, base.z);
            const distanceToBase = this.bot.entity.position.distanceTo(basePosition);
            const fragileAndFar =
                distanceToBase > 64 &&
                !this.bestCombatWeapon() &&
                (
                    this.bot.health <= 16 ||
                    this.countEmergencyBlocks() < 6
                );

            if (fragileAndFar) {
                try {
                    console.log('Gece base uzak ve bot savunmasiz; yerel acil siginak deneniyor.');
                    await this.emergencyShelter();
                    await this.barricadeShelter();
                    return;
            } catch (error) {
                console.log(`Yerel gece siginagi kurulamadi: ${error.message}`);
                const threat = this.nearestImmediateHostile(16);
                if (threat) {
                    return this.flee({
                        targetId: threat.id,
                        threat: entityName(threat),
                        distance: threat.position.distanceTo(this.bot.entity.position),
                        reason: 'Gece siginak kurulamadi; yakin tehdit var'
                    });
                }
                return this.waitOutNight({
                    delayMs: 10000,
                    reason: 'Uzak base yerine savunmasiz bekle'
                });
            }
            }

            try {
                await this.returnBase();
            } catch (error) {
                if (!this.bestCombatWeapon() || this.bot.health <= 14) {
                    console.log(`Base donusu riskli; yerel acil siginak deneniyor: ${error.message}`);
                    await this.emergencyShelter();
                    await this.barricadeShelter();
                    return;
                }
                throw error;
            }
            if (!this.memory?.data.shelterBarricaded) {
                if (this.countEmergencyBlocks() < 2) {
                    await this.collectEmergencyBlocks(2);
                }
            }
            if (this.countEmergencyBlocks() >= 2 && !this.memory?.data.shelterBarricaded) {
                await this.barricadeShelter();
                return;
            }
            console.log('Gece base icinde bekleniyor; yatak yok.');
            await this.sleepCancellable(20000, 500, () => {
                const threat = this.nearestImmediateHostile(4, { visibleOnly: true });
                if (threat) {
                    throw new Error(
                        `Barinak yakininda ${entityName(threat)} var; bekleme kesildi`
                    );
                }
            });
            return;
        }

        try {
            await this.emergencyShelter();
            await this.barricadeShelter();
            return;
        } catch (error) {
            console.log('Gece acil siper kurulamadi:', error.message);
            const threat = this.nearestImmediateHostile(24);
            if (threat) {
                console.log(`Gece beklemek riskli; ${entityName(threat)} tehdidinden uzaklasiliyor.`);
                return this.flee({
                    targetId: threat.id,
                    threat: entityName(threat),
                    distance: threat.position.distanceTo(this.bot.entity.position),
                    reason: 'Gece siper kurulamadi; acik alanda bekleme'
                });
            }
            await this.shortDisengage(2500);
        }

        return this.waitOutNight({
            delayMs: action.delayMs || 10000,
            reason: action.reason || 'Gece, base ve yatak yok'
        });
    }

    isUnderground() {
        const baseY =
            this.memory?.data.base?.y ??
            this.memory?.data.shelter?.y ??
            this.surfaceAnchor?.y;
        if (baseY != null && this.bot.entity.position.y <= baseY - 3) {
            return true;
        }
        if (this.hasOpenSky()) return false;
        return false;
    }

    hasOpenSky() {
        const position = this.bot.entity?.position;
        if (!position?.offset) return false;

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

    chooseExplorationTarget(resource) {
        const origin = this.bot.entity.position;
        const foodSearch = resource.includes('cow/pig/sheep') ||
            resource.includes('rabbit') ||
            resource.includes('cod') ||
            resource.includes('salmon');
        const longRange = resource === 'herhangi_bir_odun' ||
            resource === 'sheep' ||
            resource.includes('/');
        const distances = foodSearch
            ? [32, 24, 16]
            : longRange ? [56, 48, 40] : [40, 32, 24];
        const explored = this.memory?.data.exploredAreas || [];
        const resourceVisits = explored.filter(
            entry => entry.resource === resource
        );
        const candidates = [];

        for (const distance of distances) {
            for (let direction = 0; direction < 8; direction++) {
                const angle = direction * Math.PI / 4;
                const target = new Vec3(
                    Math.floor(origin.x + Math.cos(angle) * distance),
                    Math.floor(origin.y),
                    Math.floor(origin.z + Math.sin(angle) * distance)
                );
                const nearestVisited = resourceVisits.reduce(
                    (nearest, entry) => Math.min(
                        nearest,
                        Math.hypot(entry.x - target.x, entry.z - target.z)
                    ),
                    distance * 2
                );
                const preferredDirection = resourceVisits.length % 8;
                const directionDifference = Math.min(
                    Math.abs(direction - preferredDirection),
                    8 - Math.abs(direction - preferredDirection)
                );

                candidates.push({
                    target,
                    score:
                        nearestVisited +
                        distance * 0.1 -
                        directionDifference * 20
                });
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].target;
    }

    async travelExplorationDirection(target, resourceNames = []) {
        const origin = this.bot.entity.position.clone();
        const direction = target.minus(origin);
        const horizontalLength = Math.hypot(direction.x, direction.z) || 1;
        const steps = [1, 0.65, 0.35];

        for (const fraction of steps) {
            const x = Math.floor(
                origin.x + direction.x / horizontalLength *
                horizontalLength * fraction
            );
            const z = Math.floor(
                origin.z + direction.z / horizontalLength *
                horizontalLength * fraction
            );

            try {
                const result = await this.gotoUntilResource(
                    new goals.GoalNearXZ(x, z, 3),
                    resourceNames,
                    20000
                );
                return {
                    position: this.bot.entity.position.clone(),
                    resourceFound: result.resourceFound
                };
            } catch (error) {
                console.log(
                    `Kesif ara hedefi tamamlanamadi (${x}, ${z}):`,
                    error.message
                );
            }
        }

        throw new Error('Secilen kesif yonunde ulasilabilir ara hedef yok');
    }

    async gotoUntilResource(goal, resourceNames, timeoutMs) {
        if (resourceNames.length === 0) {
            await this.goto(goal, timeoutMs);
            return { resourceFound: null };
        }

        const ids = resourceNames
            .map(name => this.bot.registry.blocksByName[name]?.id)
            .filter(id => id != null);
        const entityNames = resourceNames
            .filter(name => this.bot.registry.blocksByName[name]?.id == null);
        if (ids.length === 0 && entityNames.length === 0) {
            await this.goto(goal, timeoutMs);
            return { resourceFound: null };
        }

        let finished = false;
        let pathError = null;
        const pathPromise = this.bot.pathfinder.goto(goal)
            .catch(error => {
                pathError = error;
            })
            .finally(() => {
                finished = true;
            });
        const deadline = Date.now() + timeoutMs;

        while (!finished && Date.now() < deadline) {
            this.assertActionActive();
            const blockResource = ids.length > 0
                ? this.findNearestResource(ids)
                : null;
            const entityResource = entityNames.length > 0
                ? this.findNearestEntityResource(entityNames, 64)
                : null;
            const resource = blockResource || entityResource;
            if (resource) {
                this.bot.pathfinder.setGoal(null);
                this.bot.clearControlStates();
                await pathPromise;
                return { resourceFound: resource };
            }
            await sleep(250);
        }

        if (!finished) {
            this.bot.pathfinder.setGoal(null);
            this.bot.clearControlStates();
            await pathPromise;
            throw new Error('Navigasyon zaman asimina ugradi');
        }
        if (pathError) throw pathError;
        return { resourceFound: null };
    }

    findNearestResource(ids) {
        const positions = this.bot.findBlocks({
            matching: ids,
            maxDistance: 64,
            count: 128
        });
        const resources = positions
            .map(position => this.bot.blockAt(position))
            .filter(Boolean)
            .filter(block => !this.isRecentlyFailedMineTarget(block))
            .filter(block => !this.isRecentlyFailedMineArea(block))
            .filter(block => {
                if (!this.isWoodBlock(block.name)) return true;
                return this.isReachableWoodTarget(block);
            })
            .sort((a, b) =>
                this.mineTargetScore(a) - this.mineTargetScore(b)
            );
        return resources[0] || null;
    }

    findNearestEntityResource(names, maxDistance = 64) {
        return Object.values(this.bot.entities || {})
            .filter(entity =>
                entity !== this.bot.entity &&
                entity.isValid !== false &&
                names.includes(entityName(entity)) &&
                entity.position.distanceTo(this.bot.entity.position) <= maxDistance
            )
            .sort((a, b) =>
                a.position.distanceTo(this.bot.entity.position) -
                b.position.distanceTo(this.bot.entity.position)
            )[0] || null;
    }

    async digStaircase(action) {
        const currentEntry = this.bot.entity.position.floored();
        const currentAnchorDistance = this.surfaceAnchor
            ? Math.hypot(
                this.surfaceAnchor.x - currentEntry.x,
                this.surfaceAnchor.z - currentEntry.z
            )
            : Infinity;
        if (
            !this.surfaceAnchor ||
            currentAnchorDistance > 48 ||
            Math.abs(this.bot.entity.position.y - this.surfaceAnchor.y) <= 3
        ) {
            this.surfaceAnchor = currentEntry;
            this.rememberSurfaceAnchor();
            console.log(`Yerel maden yuzey girisi: ${this.surfaceAnchor.toString()}`);
        }

        const target = this.findUndergroundStone();
        if (!target) {
            throw new Error('Yuklu chunklarda yer alti tasi bulunamadi');
        }

        const stoneData = this.bot.registry.blocksByName[target.name];
        await this.equipTool(stoneData);

        console.log(
            `Topragin altina tunel aciliyor: hedef=${target.name} konum=${target.position.toString()}`
        );

        const tunnelMovements = this.createMovements(true);
        this.bot.pathfinder.setMovements(tunnelMovements);

        try {
            await this.goto(
                new goals.GoalNear(
                    target.position.x,
                    target.position.y,
                    target.position.z,
                    1
                ),
                30000
            );
        } finally {
            this.bot.pathfinder.setMovements(this.createMovements(false));
        }

        const current = this.bot.blockAt(target.position);
        if (!current || current.name !== target.name) return;
        if (!this.bot.canDigBlock(current)) {
            throw new Error(`${current.name} tunel sonunda kazilamiyor`);
        }

        const actualDrop = this.primaryDropName(current);
        const expectedDrop = actualDrop || action.resource;
        const beforeCount = expectedDrop
            ? inventoryCount(this.bot, expectedDrop)
            : 0;
        await this.equipBestTool(current);
        await this.bot.lookAt(current.position.offset(0.5, 0.5, 0.5), true);
        await this.bot.dig(current);
        await this.stepTowardMinedDrop(current.position);
        await this.collectNearbyDrops(expectedDrop, 12);

        if (
            expectedDrop &&
            inventoryCount(this.bot, expectedDrop) <= beforeCount
        ) {
            throw new Error(`${expectedDrop} tunel sonunda toplanamadi`);
        }
    }

    async returnSurface() {
        if (!this.surfaceAnchor) {
            throw new Error('Yuzey girisi bilinmiyor');
        }

        console.log(`Yuzeye donuluyor: ${this.surfaceAnchor.toString()}`);
        const tunnelMovements = this.createMovements(true, true);
        this.bot.pathfinder.setMovements(tunnelMovements);

        try {
            await this.goto(
                new goals.GoalNear(
                    this.surfaceAnchor.x,
                    this.surfaceAnchor.y,
                    this.surfaceAnchor.z,
                    1
                ),
                20000
            );
        } catch (error) {
            this.assertActionActive();
            console.log(
                `Yuzey yolu bulunamadi, manuel kacis merdiveni deneniyor: ${error.message}`
            );
            if (this.nearbyImmediateHostile(8) && this.bot.health <= 12) {
                throw new Error('Yuzeye donus saldiri altinda kesildi');
            }
            await this.carveEscapeStaircase();
            await this.goto(
                new goals.GoalNear(
                    this.surfaceAnchor.x,
                    this.surfaceAnchor.y,
                    this.surfaceAnchor.z,
                    2
                ),
                45000
            );
        } finally {
            this.bot.pathfinder.setMovements(this.createMovements(false));
        }

        let current = this.bot.entity.position.floored();
        if (current.y < this.surfaceAnchor.y) {
            console.log(
                `Yuzey hedefi tamamlanmadi: mevcutY=${current.y}, hedefY=${this.surfaceAnchor.y}; manuel merdiven aciliyor.`
            );
            await this.carveEscapeStaircase();
            current = this.bot.entity.position.floored();
            if (current.y < this.surfaceAnchor.y) {
                throw new Error(
                    `Yuzeye cikilamadi: mevcutY=${current.y}, hedefY=${this.surfaceAnchor.y}`
                );
            }
        }

        if (current.y >= this.surfaceAnchor.y) {
            this.surfaceAnchor = new Vec3(
                current.x,
                Math.max(this.surfaceAnchor.y, current.y),
                current.z
            );
            this.rememberSurfaceAnchor();
        }
    }

    async escapePit(action = {}) {
        this.stop();
        this.ensureEscapeSurfaceAnchor(Boolean(action.threat));
        console.log(
            `Cukurdan cikis deneniyor: ${action.reason || 'yatay kacis yerine yuzeye cik'}`
        );

        try {
            await this.returnSurface();
            return;
        } catch (error) {
            console.log(`Yuzeye donus tamamlanamadi, manuel cikis suruyor: ${error.message}`);
        }

        await this.carveEscapeStaircase();
    }

    ensureEscapeSurfaceAnchor(localThreat = false) {
        if (
            localThreat &&
            !this.memory?.data.base &&
            !this.memory?.data.shelter
        ) {
            const current = this.bot.entity.position.floored();
            this.surfaceAnchor = new Vec3(
                current.x,
                Math.max(1, current.y + 4),
                current.z
            );
            return;
        }

        if (this.surfaceAnchor && this.surfaceAnchor.y >= 1) return;

        const remembered =
            this.memory?.data.base ||
            this.memory?.data.shelter ||
            this.memory?.data.surfaceAnchor ||
            this.memory?.data.home;
        if (remembered) {
            this.surfaceAnchor = new Vec3(
                remembered.x,
                Math.max(1, remembered.y),
                remembered.z
            );
            return;
        }

        const current = this.bot.entity.position.floored();
        this.surfaceAnchor = new Vec3(current.x, Math.max(1, current.y + 8), current.z);
        this.rememberSurfaceAnchor();
    }

    async carveEscapeStaircase() {
        const anchor = this.surfaceAnchor;
        if (!anchor) return;

        for (let step = 0; step < 24; step++) {
            this.assertActionActive();
            const current = this.bot.entity.position.floored();
            if (current.y >= anchor.y) return;

            const directions = this.orderedEscapeDirections(current, anchor);
            let moved = false;
            let lastError = null;

            for (const direction of directions) {
                this.assertActionActive();
                const support = current.offset(direction.x, 0, direction.z);
                const feet = current.offset(direction.x, 1, direction.z);
                const head = current.offset(direction.x, 2, direction.z);

                try {
                    await this.clearEscapeBlock(feet);
                    await this.clearEscapeBlock(head);

                    const supportBlock = this.bot.blockAt(support);
                    if (!supportBlock || supportBlock.name === 'air') {
                        await this.placeEscapeSupport(support);
                    }

                    this.bot.pathfinder.setMovements(this.createMovements(true, true));
                    try {
                        await this.goto(
                            new goals.GoalBlock(feet.x, feet.y, feet.z),
                            15000
                        );
                    } catch (error) {
                        console.log(
                            `Pathfinder kacis adimini bulamadi; manuel ziplama deneniyor: ${error.message}`
                        );
                        await this.manualEscapeStep(feet);
                    }
                    moved = true;
                    break;
                } catch (error) {
                    lastError = error;
                    this.stop();
                    console.log(
                        `Kacis merdiveni yonu denenemedi ${direction.x},${direction.z}: ${error.message}`
                    );
                }
            }

            if (!moved) {
                throw lastError || new Error('Kacis merdiveni ilerleyemedi');
            }
        }
    }

    async manualEscapeStep(target) {
        const start = this.bot.entity.position.floored();
        await this.bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
        this.bot.setControlState('forward', true);
        this.bot.setControlState('jump', true);
        this.bot.setControlState('sprint', true);
        await sleep(1300);
        this.bot.clearControlStates();
        await sleep(250);

        const current = this.bot.entity.position.floored();
        const reached =
            Math.abs(current.x - target.x) <= 1 &&
            Math.abs(current.z - target.z) <= 1 &&
            current.y >= target.y - 1 &&
            current.y >= start.y;
        if (!reached) {
            throw new Error(
                `Manuel kacis adimi ilerlemedi: mevcut=${current.toString()} hedef=${target.toString()}`
            );
        }
    }

    horizontalDirectionToward(current, target) {
        const dx = target.x - current.x;
        const dz = target.z - current.z;
        if (Math.abs(dx) >= Math.abs(dz) && dx !== 0) {
            return new Vec3(Math.sign(dx), 0, 0);
        }
        if (dz !== 0) return new Vec3(0, 0, Math.sign(dz));
        return new Vec3(1, 0, 0);
    }

    chooseEscapeDirection(current, target) {
        return this.orderedEscapeDirections(current, target)[0] ||
            this.horizontalDirectionToward(current, target);
    }

    orderedEscapeDirections(current, target) {
        const preferred = this.horizontalDirectionToward(current, target);
        const directions = [
            preferred,
            new Vec3(1, 0, 0),
            new Vec3(-1, 0, 0),
            new Vec3(0, 0, 1),
            new Vec3(0, 0, -1)
        ];
        const unique = [];
        const seen = new Set();
        for (const direction of directions) {
            const key = `${direction.x},${direction.z}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(direction);
            }
        }

        const hasPortableBlock = Boolean(this.findEscapeSupportItem());
        const ranked = unique
            .map(direction => {
                const support = this.bot.blockAt(current.offset(direction.x, 0, direction.z));
                const feet = this.bot.blockAt(current.offset(direction.x, 1, direction.z));
                const head = this.bot.blockAt(current.offset(direction.x, 2, direction.z));
                const solidSupport = support?.boundingBox === 'block';
                const canPlaceSupport =
                    hasPortableBlock &&
                    this.hasPlacementReference(support?.position || current.offset(direction.x, 0, direction.z));
                const clearCost =
                    (feet?.boundingBox === 'block' ? 1 : 0) +
                    (head?.boundingBox === 'block' ? 1 : 0);
                const preferencePenalty =
                    direction.x === preferred.x && direction.z === preferred.z ? 0 : 4;
                const supportPenalty = solidSupport || canPlaceSupport ? 0 : 100;
                return {
                    direction,
                    score: supportPenalty + clearCost + preferencePenalty
                };
            })
            .sort((a, b) => a.score - b.score)
            .map(entry => entry.direction);
        return ranked.length > 0 ? ranked : [preferred];
    }

    hasPlacementReference(target) {
        if (!target) return false;
        return [
            [0, -1, 0],
            [-1, 0, 0],
            [1, 0, 0],
            [0, 0, -1],
            [0, 0, 1]
        ].some(offset =>
            this.bot.blockAt(target.offset(...offset))?.boundingBox === 'block'
        );
    }

    async clearEscapeBlock(position) {
        const block = this.bot.blockAt(position);
        if (!block || block.name === 'air' || block.boundingBox !== 'block') return;
        if (!this.bot.canDigBlock(block)) {
            throw new Error(`Kacis merdiveni kazilamiyor: ${block.name}`);
        }
        await this.equipBestTool(block);
        try {
            await this.bot.dig(block);
        } catch (error) {
            const after = this.bot.blockAt(position);
            if (!after || after.name === 'air' || after.boundingBox !== 'block') {
                return;
            }
            throw error;
        }
        await sleep(100);
    }

    async placeEscapeSupport(position) {
        let item = this.findEscapeSupportItem();
        if (!item) {
            await this.collectEscapeBlocks(4);
            item = this.findEscapeSupportItem();
        }
        if (!item) throw new Error('Kacis merdiveni icin blok yok');
        await this.placeItemAt(position, item.name);
    }

    findEscapeSupportItem() {
        const names = this.escapeSupportItemNames();
        return this.bot.inventory.items()
            .find(entry => names.has(entry.name)) || null;
    }

    async collectEscapeBlocks(targetCount = 4) {
        const failed = new Set();
        while (this.escapeSupportBlockCount() < targetCount) {
            this.assertActionActive();
            const block = this.findEscapeDigBlock(failed);
            if (!block) break;

            const before = this.escapeSupportBlockCount();
            try {
                await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
                await this.equipBestTool(block);
                await Promise.race([
                    this.bot.dig(block, true, new Vec3(0, 1, 0)),
                    sleep(3000).then(() => {
                        throw new Error('Kacis blogu kazisi zaman asimi');
                    })
                ]);
                await sleep(250);
            } catch (error) {
                if (typeof this.bot.stopDigging === 'function') {
                    try {
                        this.bot.stopDigging();
                    } catch {
                        // Best effort cleanup before trying another block.
                    }
                }
                failed.add(block.position.toString());
                console.log(`Kacis blogu kazilamadi: ${block.name} ${block.position} (${error.message})`);
                continue;
            }

            if (this.escapeSupportBlockCount() <= before) {
                failed.add(block.position.toString());
            }
        }
    }

    findEscapeDigBlock(failed = new Set()) {
        const diggableNames = new Set([
            'dirt',
            'grass_block',
            'coarse_dirt',
            'podzol',
            'cobblestone',
            'stone',
            'deepslate',
            'cobbled_deepslate',
            'tuff'
        ]);
        return this.bot.findBlocks({
                matching: block => diggableNames.has(block.name),
                maxDistance: 5,
                count: 64
            })
            .map(position => this.bot.blockAt(position))
            .filter(block =>
                block &&
                !failed.has(block.position.toString()) &&
                block.diggable &&
                this.bot.canDigBlock(block) &&
                this.hasRequiredHarvestTool(block) &&
                this.hasOpenMiningFace(block.position)
            )
            .sort((a, b) =>
                a.position.distanceTo(this.bot.entity.position) -
                b.position.distanceTo(this.bot.entity.position)
            )[0] || null;
    }

    escapeSupportBlockCount() {
        const names = this.escapeSupportItemNames();
        return this.bot.inventory.items()
            .filter(item => names.has(item.name))
            .reduce((total, item) => total + item.count, 0);
    }

    hasRequiredHarvestTool(block) {
        const toolIds = Object.keys(block.harvestTools || {}).map(Number);
        if (toolIds.length === 0) return true;
        return this.bot.inventory.items().some(item => toolIds.includes(item.type));
    }

    escapeSupportItemNames() {
        return new Set([
            'cobblestone',
            'cobbled_deepslate',
            'dirt',
            'grass_block',
            'coarse_dirt',
            'podzol',
            'tuff',
            'deepslate',
            'stone',
            'oak_planks'
        ]);
    }

    rememberSurfaceAnchor() {
        if (!this.surfaceAnchor) return;
        this.memory?.setFlag('surfaceAnchor', {
            x: Math.floor(this.surfaceAnchor.x),
            y: Math.floor(this.surfaceAnchor.y),
            z: Math.floor(this.surfaceAnchor.z)
        });
    }

    async eat(action) {
        const food = this.bot.inventory.items()
            .find(item => item.name === action.item);
        if (!food) throw new Error(`${action.item} envanterde yok`);

        this.stop();
        await this.bot.equip(food, 'hand');
        await this.bot.consume();
    }

    async sleepInBed() {
        if (this.bot.isSleeping) return;
        if (Date.now() - this.lastSleepAttemptAt < 10000) return;

        const bed = this.bot.findBlock({
            matching: block => this.bot.isABed(block),
            maxDistance: 24
        });
        if (!bed) throw new Error('Yakinda yatak yok');

        await this.goto(
            new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2),
            15000
        );
        this.lastSleepAttemptAt = Date.now();
        await Promise.race([
            this.bot.sleep(bed),
            sleep(5000)
        ]);
        this.memory?.remember('beds', bed.position);
        if (this.bot.isSleeping) {
            await sleep(5000);
            if (this.bot.isSleeping) {
                await this.bot.wake();
                console.log('Gece atlanmadi; ajan calismaya devam ediyor.');
            }
        }
    }

    async placeBed() {
        const bed = this.bot.inventory.items()
            .find(item => item.name.endsWith('_bed'));
        if (!bed) throw new Error('Envanterde yatak yok');

        const placement = this.findPlacement() || await this.createPlacementNook();
        if (!placement) throw new Error('Yatak icin uygun zemin yok');

        await this.bot.equip(bed, 'hand');
        await this.bot.placeBlock(placement.reference, new Vec3(0, 1, 0));
        const placed = this.bot.blockAt(placement.target);
        if (placed) {
            try {
                await this.bot.activateBlock(placed);
            } catch {
                // Daytime activation can fail on some server versions; memory still tracks it.
            }
        }
        this.memory?.remember('beds', placement.target);
        await sleep(500);
    }

    async huntFood(action = {}) {
        if (await this.craftBreadFromWheat()) {
            console.log(`Bugday ekmege cevrildi: ekmek=${inventoryCount(this.bot, 'bread')}`);
        }

        await this.eatBestFoodIfHungry(
            this.bot.health <= 12 ? 18 : 14,
            this.bot.food <= 8 || this.bot.health <= 8
        );

        const beforeFoodItems = this.foodInventoryCount();
        const targetFoodCount = action.count && action.count > 1
            ? action.count
            : beforeFoodItems + 1;

        if (this.foodInventoryCount() >= targetFoodCount) return;

        await this.returnToSafeFoodSearchArea();
        if (await this.craftBreadFromWheat()) {
            console.log(`Guvenli bolgede bugday ekmege cevrildi: ekmek=${inventoryCount(this.bot, 'bread')}`);
            await this.eatBestFoodIfHungry(
                this.bot.health <= 12 ? 18 : 14,
                this.bot.food <= 8 || this.bot.health <= 8
            );
            if (this.foodInventoryCount() >= targetFoodCount) return;
        }

        const harvested = await this.harvestFarmFood(targetFoodCount);
        if (harvested) {
            await this.eatBestFoodIfHungry(
                this.bot.health <= 12 ? 18 : 14,
                this.bot.food <= 8 || this.bot.health <= 8
            );
            if (
                this.foodInventoryCount() >= targetFoodCount ||
                (
                    !action.count &&
                    this.foodInventoryCount() > beforeFoodItems
                )
            ) {
                return;
            }
        }

        const critical = this.bot.health <= 8 || this.bot.food <= 8;
        const landFoodMobs = ['cow', 'pig', 'sheep', 'rabbit'];
        const aquaticFoodMobs = ['cod', 'salmon'];

        try {
            await this.huntMob(landFoodMobs, {
                targetFoodCount,
                avoidAquatic: true
            });
        } catch (error) {
            if (this.foodInventoryCount() >= targetFoodCount) return;
            if (critical) {
                console.log(`Kritik aclikta kara yiyecegi bulunamadi, balik son care deneniyor: ${error.message}`);
                try {
                    await this.huntMob(aquaticFoodMobs, {
                        targetFoodCount,
                        preferLand: true
                    });
                    return;
                } catch (fishError) {
                    throw new Error(
                        `Kritik durumda guvenli yiyecek bulunamadi: ${error.message}; balik=${fishError.message}`
                    );
                }
            }
            console.log(`Kara yiyecegi yetersiz, balik son care olarak deneniyor: ${error.message}`);
            await this.huntMob([...landFoodMobs, ...aquaticFoodMobs], {
                targetFoodCount,
                preferLand: true
            });
        }
    }

    async returnToSafeFoodSearchArea() {
        if (this.bot.entity.isInWater) {
            await this.leaveWaterAfterFishing();
        }

        if (!this.isUnsafeFoodSearchArea()) return;

        console.log('Yiyecek aramadan once guvenli yuzeye/base bolgesine donuluyor.');
        const base = this.memory?.data.base || this.memory?.data.shelter;
        if (base && this.bot.entity.position.distanceTo(new Vec3(base.x, base.y, base.z)) <= 96) {
            await this.returnBase();
            return;
        }

        this.ensureEscapeSurfaceAnchor(false);
        await this.returnSurface();
    }

    isUnsafeFoodSearchArea() {
        if (this.bot.entity.isInWater) return true;
        const base =
            this.memory?.data.base ||
            this.memory?.data.shelter ||
            this.memory?.data.surfaceAnchor ||
            this.memory?.data.home;
        const referenceY = base?.y ?? this.surfaceAnchor?.y;
        if (referenceY != null) {
            return this.bot.entity.position.y <= referenceY - 2;
        }
        if (this.hasOpenSky()) return false;
        return this.bot.entity.position.y <= 50;
    }
    async harvestFarmFood(targetFoodCount = 1) {
        const farm = this.memory?.data.expandedFarm || this.memory?.data.farm;
        if (!farm) return false;

        const center = new Vec3(farm.x, farm.y, farm.z);
        if (this.bot.entity.position.distanceTo(center) > 48 && !this.memory?.data.base) {
            return false;
        }

        let harvested = 0;
        const radius = farm.radius || (farm.cropCount >= 24 ? 3 : 1);
        const beforeWheat = inventoryCount(this.bot, 'wheat');
        const beforeBread = inventoryCount(this.bot, 'bread');

        await this.goto(new goals.GoalNear(center.x, center.y, center.z, 4), 30000);

        const crops = [];
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (dx === 0 && dz === 0) continue;
                const block = this.bot.blockAt(center.offset(dx, 0, dz));
                if (block?.name !== 'wheat') continue;
                const age = Number(block.getProperties?.().age ?? block.metadata ?? 0);
                if (age >= 7) crops.push(block);
            }
        }

        for (const crop of crops) {
            this.assertActionActive();
            await this.gotoProjectWorkPosition(crop.position);
            try {
                await this.bot.dig(crop);
                harvested++;
                await sleep(250);
                await this.collectNearbyDrops(null, 8);
                await this.replantWheatAt(crop.position);
            } catch (error) {
                console.log(`Bugday hasadi atlandi ${crop.position.toString()}: ${error.message}`);
            }

            await this.craftBreadFromWheat();
            if (this.foodInventoryCount() >= targetFoodCount) break;
        }

        await this.collectNearbyDrops(null, 8);
        await this.craftBreadFromWheat();

        const gained =
            harvested > 0 ||
            inventoryCount(this.bot, 'wheat') > beforeWheat ||
            inventoryCount(this.bot, 'bread') > beforeBread;
        if (gained) {
            console.log(
                `Tarla hasadi: ${harvested} ekin, ekmek=${inventoryCount(this.bot, 'bread')}`
            );
        }
        return gained;
    }

    async replantWheatAt(position) {
        const soil = this.bot.blockAt(position.offset(0, -1, 0));
        const above = this.bot.blockAt(position);
        if (soil?.name !== 'farmland' || above?.name !== 'air') return false;

        const seeds = this.bot.inventory.items()
            .find(item => item.name === 'wheat_seeds');
        if (!seeds) return false;

        await this.bot.equip(seeds, 'hand');
        try {
            await this.bot.placeBlock(soil, new Vec3(0, 1, 0));
            await sleep(150);
            return true;
        } catch {
            return this.bot.blockAt(position)?.name === 'wheat';
        }
    }

    async craftBreadFromWheat() {
        const wheatCount = inventoryCount(this.bot, 'wheat');
        if (wheatCount < 3) return false;

        const bread = this.bot.registry.itemsByName.bread;
        if (!bread) return false;
        const craftCount = Math.floor(wheatCount / 3);
        let table = null;
        let recipe = this.bot.recipesFor(bread.id, null, 1, null)[0];
        if (!recipe) {
            try {
                table = await this.ensureCraftingTableForCraft();
                recipe = this.bot.recipesFor(bread.id, null, 1, table)[0];
            } catch (error) {
                console.log(`Bugday ekmege cevrilemedi: ${error.message}`);
                return false;
            }
        }
        if (!recipe) return false;

        for (let i = 0; i < craftCount; i++) {
            const currentRecipe = this.bot.recipesFor(bread.id, null, 1, null)[0];
            const recipeToCraft = currentRecipe ||
                this.bot.recipesFor(bread.id, null, 1, table)[0];
            if (!recipeToCraft) break;
            await this.bot.craft(recipeToCraft, 1, table);
            await sleep(150);
        }
        return true;
    }

    async huntMob(names, options = {}) {
        const beforeFoodItems = this.foodInventoryCount();
        const targetFoodCount = options.targetFoodCount || beforeFoodItems + 1;
        const maxAttempts = options.targetFoodCount ? 4 : 2;
        const failedTargetIds = new Set();

        for (
            let attempt = 0;
            attempt < maxAttempts && this.foodInventoryCount() < targetFoodCount;
            attempt++
        ) {
            let target = this.findHuntTarget(names, failedTargetIds, options);
            if (!target) {
                await this.explore({
                    resource: names.join('/'),
                    candidates: names,
                    reason: 'Yiyecek veya malzeme icin hayvan ara'
                });
                target = this.findHuntTarget(names, failedTargetIds, options);
                if (!target) continue;
            }

            try {
                await this.huntSingleTarget(target);
            } catch (error) {
                if (target.id != null) failedTargetIds.add(target.id);
                console.log(`Yiyecek avi basarisiz: ${error.message}`);
                if (attempt === maxAttempts - 1) throw error;
            }
        }

        if (this.foodInventoryCount() <= beforeFoodItems) {
            throw new Error('Yiyecek kesfi sonuc getirmedi');
        }
    }

    findHuntTarget(names, ignoredIds = new Set(), options = {}) {
        const urgent = this.bot.health <= 6 || this.bot.food <= 4;
        return Object.values(this.bot.entities || {})
            .filter(entity =>
                entity !== this.bot.entity &&
                entity.isValid !== false &&
                !ignoredIds.has(entity.id) &&
                names.includes(entityName(entity)) &&
                entity.position.distanceTo(this.bot.entity.position) <= 64
            )
            .sort((a, b) => {
                const aName = entityName(a);
                const bName = entityName(b);
                const aAquatic = ['cod', 'salmon'].includes(aName);
                const bAquatic = ['cod', 'salmon'].includes(bName);
                const aquaticPenalty = options.avoidAquatic
                    ? 10000
                    : (urgent || options.preferLand) ? 80 : 20;
                const aPenalty = aAquatic ? aquaticPenalty : 0;
                const bPenalty = bAquatic ? aquaticPenalty : 0;
                return (
                    a.position.distanceTo(this.bot.entity.position) + aPenalty -
                    b.position.distanceTo(this.bot.entity.position) - bPenalty
                );
            })[0] || null;
    }

    async huntSingleTarget(target) {
        const beforeFoodItems = this.foodInventoryCount();
        const targetName = entityName(target);
        console.log(
            `Yiyecek hedefi: ${targetName} mesafe=${target.position.distanceTo(this.bot.entity.position).toFixed(1)}`
        );

        if (['cod', 'salmon'].includes(targetName)) {
            await this.manualHuntTarget(target, 25000);
            await sleep(1000);
            await this.collectNearbyDrops(null, 16);
            if (this.foodInventoryCount() <= beforeFoodItems) {
                throw new Error(`${targetName} avi yiyecek getirmedi`);
            }
            await this.eatBestFoodIfHungry(14, true);
            await this.leaveWaterAfterFishing();
            return;
        }

        try {
            await this.goto(new goals.GoalFollow(target, 2), 15000);
        } catch (error) {
            console.log(`Yiyecek hedefine pathfinder yetisemedi: ${error.message}; manuel takip.`);
            await this.manualHuntTarget(target);
        }

        for (let attempt = 0; attempt < 12 && target.isValid; attempt++) {
            this.assertActionActive();
            if (target.position.distanceTo(this.bot.entity.position) > 3) {
                try {
                    await this.goto(new goals.GoalFollow(target, 2), 8000);
                } catch {
                    await this.manualHuntTarget(target, 4500);
                }
            }
            await this.bot.lookAt(target.position.offset(0, 1, 0), true);
            this.bot.attack(target);
            await sleep(650);
        }
        await sleep(1200);
        await this.collectNearbyDrops(null, 16);
        if (this.foodInventoryCount() <= beforeFoodItems) {
            throw new Error(`${targetName} avi yiyecek getirmedi`);
        }
        await this.eatBestFoodIfHungry(14, true);
    }

    async leaveWaterAfterFishing() {
        if (!this.bot.entity.isInWater) return;
        console.log('Balik avindan sonra kiyiya cikiliyor.');
        try {
            await this.swim({ timeoutMs: 16000 });
        } catch (error) {
            console.log('Balik avindan sonra kiyiya cikilamadi:', error.message);
        }
    }

    bestEdibleFood(allowEmergencyFood = false) {
        return this.bot.inventory.items()
            .map(item => ({
                item,
                food: this.bot.registry.foodsByName[item.name]
            }))
            .filter(entry =>
                entry.food &&
                isSafeFoodItem(this.bot, entry.item, allowEmergencyFood)
            )
            .sort((a, b) =>
                b.food.effectiveQuality - a.food.effectiveQuality
            )[0]?.item || null;
    }

    async eatBestFoodIfHungry(foodThreshold = 14, allowEmergencyFood = false) {
        if (this.bot.food > foodThreshold) return false;
        const food = this.bestEdibleFood(allowEmergencyFood);
        if (!food) return false;
        console.log(`Acil yemek yeniyor: ${food.name}`);
        await this.eat({ item: food.name });
        return true;
    }

    async manualHuntTarget(target, durationMs = 8000) {
        const deadline = Date.now() + durationMs;
        try {
            while (target?.isValid && Date.now() < deadline) {
                this.assertActionActive();
                const distance = target.position.distanceTo(this.bot.entity.position);
                await Promise.race([
                    this.bot.lookAt(target.position.offset(0, 0.8, 0), true),
                    sleep(350)
                ]);

                this.bot.setControlState('forward', true);
                this.bot.setControlState('sprint', true);
                if (this.bot.entity.isInWater || distance > 3) {
                    this.bot.setControlState('jump', true);
                }
                if (distance <= 3.4) {
                    this.bot.attack(target);
                    await sleep(550);
                } else {
                    await sleep(350);
                }
            }
        } finally {
            this.bot.clearControlStates();
        }
        console.log('Manuel yiyecek takibi tamamlandi.');
    }

    async placeStorage() {
        const chest = this.bot.inventory.items()
            .find(item => item.name === 'chest');
        if (!chest) throw new Error('Envanterde sandik yok');

        const placement = this.findPlacement();
        if (!placement) throw new Error('Sandik icin uygun zemin yok');

        await this.bot.equip(chest, 'hand');
        await this.bot.placeBlock(placement.reference, new Vec3(0, 1, 0));
        this.memory?.remember('chests', placement.target);
        await sleep(500);
    }

    async storeItems() {
        const storage = this.memory?.data.storageSystem;
        if (storage?.chests?.length) {
            return this.storeItemsByCategory(storage.chests);
        }

        const chestId = this.bot.registry.blocksByName.chest?.id;
        const chestBlock = chestId
            ? this.bot.findBlock({ matching: chestId, maxDistance: 24 })
            : null;
        if (!chestBlock) throw new Error('Yakinda sandik yok');

        await this.goto(
            new goals.GoalNear(
                chestBlock.position.x,
                chestBlock.position.y,
                chestBlock.position.z,
                2
            ),
            15000
        );

        const chest = await this.bot.openChest(chestBlock);
        try {
            for (const item of this.bot.inventory.items()) {
                const keep = this.keepInInventory(item);
                const depositCount = Math.max(0, item.count - keep);
                if (depositCount > 0) {
                    await chest.deposit(item.type, item.metadata, depositCount);
                }
            }
        } finally {
            chest.close();
        }
        this.memory?.remember('chests', chestBlock.position);
    }

    async prepareLoadout(action = {}) {
        const chestBlock = this.findLoadoutChest();
        if (!chestBlock) throw new Error('Loadout icin yakinda sandik yok');

        await this.goto(
            new goals.GoalNear(
                chestBlock.position.x,
                chestBlock.position.y,
                chestBlock.position.z,
                2
            ),
            20000
        );

        const chest = await this.bot.openChest(chestBlock);
        try {
            for (const item of [...this.bot.inventory.items()]) {
                const keep = this.keepForLoadout(item, action.context);
                const depositCount = Math.max(0, item.count - keep);
                if (depositCount > 0) {
                    await chest.deposit(item.type, item.metadata, depositCount);
                    await sleep(100);
                }
            }

            for (const need of this.loadoutNeeds(action.context)) {
                const current = inventoryCount(this.bot, need.name);
                const missing = Math.max(0, need.count - current);
                if (missing <= 0) continue;

                const itemData = this.bot.registry.itemsByName[need.name];
                if (!itemData) continue;
                const available = chest.containerItems()
                    .find(item => item.name === need.name);
                if (!available) continue;

                await chest.withdraw(
                    itemData.id,
                    available.metadata,
                    Math.min(missing, available.count)
                );
                await sleep(100);
            }
        } finally {
            chest.close();
        }

        this.memory?.remember('chests', chestBlock.position);
        console.log('Envanter loadout ihtiyacina gore duzenlendi.');
    }

    findLoadoutChest() {
        const storage = this.memory?.data.storageSystem;
        if (storage?.chests?.length) {
            for (const chestInfo of storage.chests) {
                const position = new Vec3(chestInfo.x, chestInfo.y, chestInfo.z);
                const block = this.bot.blockAt(position);
                if (block?.name === 'chest') return block;
            }
        }

        const chestId = this.bot.registry.blocksByName.chest?.id;
        return chestId
            ? this.bot.findBlock({ matching: chestId, maxDistance: 24 })
            : null;
    }

    storageCategory(itemName) {
        if (
            itemName.includes('_ore') ||
            itemName.includes('deepslate') ||
            ['coal', 'charcoal', 'raw_iron', 'iron_ingot', 'diamond'].includes(itemName)
        ) return 'ores';
        if (
            itemName.includes('log') ||
            itemName.includes('planks') ||
            ['cobblestone', 'stone', 'dirt', 'sand', 'gravel'].includes(itemName)
        ) return 'building';
        if (
            itemName.includes('sapling') ||
            itemName.includes('seeds') ||
            this.bot.registry.foodsByName[itemName] ||
            ['wheat', 'bone_meal'].includes(itemName)
        ) return 'food_farm';
        return 'tools_misc';
    }

    async storeItemsByCategory(chests) {
        for (const chestInfo of chests) {
            const position = new Vec3(chestInfo.x, chestInfo.y, chestInfo.z);
            const block = this.bot.blockAt(position);
            if (block?.name !== 'chest') continue;

            await this.goto(
                new goals.GoalNear(position.x, position.y, position.z, 2),
                20000
            );
            const chest = await this.bot.openChest(block);
            try {
                for (const item of [...this.bot.inventory.items()]) {
                    if (this.storageCategory(item.name) !== chestInfo.name) continue;
                    const keep = this.keepInInventory(item);
                    const depositCount = Math.max(0, item.count - keep);
                    if (depositCount > 0) {
                        await chest.deposit(item.type, item.metadata, depositCount);
                    }
                }
            } finally {
                chest.close();
            }
        }
    }

    async buildShelter() {
        const material = this.bot.inventory.items()
            .find(item => item.name === 'cobblestone' && item.count >= 24);
        if (!material) throw new Error('Barinak icin 24 cobblestone gerekli');

        let center = this.findFlatShelterCenter();
        let fallbackReason = null;
        if (center && center.y > this.bot.entity.position.y + 4) {
            console.log(
                `Barinak alani yukarida (${center.y}); once yuzeye cikiliyor.`
            );
            await this.returnSurface();
            center = this.findFlatShelterCenter();
        }
        if (!center) {
            fallbackReason = 'Barinak icin duz 3x3 alan bulunamadi';
        }

        if (center) {
            try {
                await this.goto(new goals.GoalNear(center.x, center.y, center.z, 1), 15000);
                const reached = this.bot.entity.position;
                if (
                    Math.hypot(reached.x - center.x, reached.z - center.z) > 3 ||
                    Math.abs(reached.y - center.y) > 3
                ) {
                    await this.gotoProjectWorkPosition(center);
                }
                if (
                    Math.hypot(this.bot.entity.position.x - center.x, this.bot.entity.position.z - center.z) > 4 ||
                    Math.abs(this.bot.entity.position.y - center.y) > 4
                ) {
                    fallbackReason = `Barinak merkezine ulasilamadi: ${center.toString()}`;
                }
            } catch (error) {
                fallbackReason = `Barinak merkezine gidilemedi: ${error.message}`;
            }
        }

        if (fallbackReason) {
            return this.buildQuickShelter(fallbackReason);
        }
        await this.bot.equip(material, 'hand');

        const targets = this.shelterTargets(center);

        try {
            for (const target of targets) {
                await this.placeAt(target);
            }
        } catch (error) {
            console.log(`Planli barinak kurulamadi: ${error.message}`);
            return this.buildQuickShelter(error.message);
        }

        this.memory?.setShelter(center);
        this.memory?.setFlag('shelterBarricaded', false);
    }

    shelterTargets(center) {
        const targets = [];
        for (let layer = 0; layer < 2; layer++) {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const perimeter = Math.abs(dx) === 1 || Math.abs(dz) === 1;
                    const doorway = dx === 1 && dz === 0;
                    if (perimeter && !doorway) {
                        targets.push(center.offset(dx, layer, dz));
                    }
                }
            }
        }

        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (dx !== 0 || dz !== 0) {
                    targets.push(center.offset(dx, 2, dz));
                }
            }
        }
        targets.push(center.offset(0, 2, 0));
        return targets;
    }

    async buildQuickShelter(reason = 'planli barinak uygun degil') {
        console.log(`Hizli tas siginak kuruluyor: ${reason}`);
        const center = this.bot.entity.position.floored();
        const targets = this.shelterTargets(center);
        let solidTargets = 0;

        for (const target of targets) {
            try {
                const solid = await this.ensureShelterBoundary(target);
                if (solid) solidTargets += 1;
            } catch (error) {
                console.log(`Hizli siginak noktasi atlandi: ${target.toString()} ${error.message}`);
            }
        }

        if (solidTargets < 10) {
            throw new Error(`Hizli siginak yetersiz kapandi: ${solidTargets}/${targets.length}`);
        }

        this.memory?.setShelter(center);
        this.memory?.setFlag('shelterBarricaded', true);
        console.log(`Hizli siginak kuruldu: ${center.toString()} kapali=${solidTargets}/${targets.length}`);
    }

    async ensureShelterBoundary(target) {
        const existing = this.bot.blockAt(target);
        if (existing?.boundingBox === 'block') return true;

        const material = this.bot.inventory.items()
            .find(item => item.name === 'cobblestone');
        if (!material) throw new Error('Cobblestone kalmadi');

        await this.bot.equip(material, 'hand');
        await this.placeAt(target);
        return this.bot.blockAt(target)?.boundingBox === 'block';
    }

    async emergencyShelter() {
        this.stop();
        await this.shortDisengage();
        if (this.nearbyImmediateHostile(6) && this.bot.health <= 18) {
            throw new Error('Saldirgan cok yakin; siper kazisi yerine once uzaklas');
        }
        if (this.countEmergencyBlocks() < 6) {
            const foxhole = await this.tryBuildFoxholeShelter();
            if (foxhole) return;
        }

        await this.collectEmergencyBlocks(12);

        const current = this.bot.entity.position.floored();
        const anchorY = this.surfaceAnchor?.y ?? current.y;
        const center = new Vec3(current.x, Math.max(current.y, anchorY), current.z);
        const material = this.findEmergencyBlock();
        if (!material || this.countEmergencyBlocks() < 6) {
            throw new Error('Acil siper icin yeterli toprak/tas yok');
        }

        const wallOffsets = [
            [1, 0], [-1, 0], [0, 1], [0, -1]
        ];

        for (let layer = 0; layer <= 1; layer++) {
            for (const [dx, dz] of wallOffsets) {
                await this.placeEmergencyBlockAt(center.offset(dx, layer, dz));
            }
        }

        if (this.countEmergencyBlocks() >= 2) {
            await this.placeEmergencyBlockAt(center.offset(1, 2, 0));
            await this.placeEmergencyBlockAt(center.offset(0, 2, 0));
        }

        this.memory?.setShelter(center);
        this.memory?.setFlag('shelterBarricaded', false);
        console.log(`Acil siper kuruldu: ${center.toString()}`);
    }

    async tryBuildFoxholeShelter() {
        const start = this.bot.entity.position.floored();
        const digNames = new Set([
            'dirt',
            'grass_block',
            'coarse_dirt',
            'podzol',
            'rooted_dirt',
            'mud',
            'moss_block',
            'sand',
            'red_sand',
            'gravel',
            'clay'
        ]);

        for (let depth = 0; depth < 2; depth++) {
            const current = this.bot.entity.position.floored();
            const floor = this.bot.blockAt(current.offset(0, -1, 0));
            if (
                !floor ||
                !digNames.has(floor.name) ||
                !floor.diggable ||
                !this.bot.canDigBlock(floor)
            ) {
                return false;
            }

            await this.bot.lookAt(floor.position.offset(0.5, 0.5, 0.5), true);
            await this.equipBestTool(floor);
            try {
                await Promise.race([
                    this.bot.dig(floor, true, new Vec3(0, 1, 0)),
                    sleep(2500).then(() => {
                        throw new Error('Foxhole kazisi zaman asimi');
                    })
                ]);
            } catch (error) {
                if (typeof this.bot.stopDigging === 'function') {
                    try {
                        this.bot.stopDigging();
                    } catch {
                        // Best effort cleanup.
                    }
                }
                console.log(`Foxhole kazilamadi: ${error.message}`);
                return false;
            }
            await sleep(450);
        }

        const inside = this.bot.entity.position.floored();
        const cap = inside.offset(0, 2, 0);
        if (this.countEmergencyBlocks() < 1) {
            await this.collectNearbyDrops(null, 3);
        }
        if (this.countEmergencyBlocks() < 1) return false;

        try {
            await this.placeEmergencyBlockAt(cap);
        } catch (error) {
            console.log(`Foxhole ustu kapatilamadi: ${error.message}`);
            return false;
        }

        this.memory?.setShelter(inside);
        this.memory?.setFlag('shelterBarricaded', true);
        console.log(`Acil foxhole siginagi kuruldu: ${inside.toString()} (baslangic ${start.toString()})`);
        await sleep(12000);
        return true;
    }

    async barricadeShelter() {
        const shelter = this.memory?.data.shelter;
        if (!shelter) throw new Error('Kapatilacak barinak yok');
        if (this.countEmergencyBlocks() < 1) {
            throw new Error('Barinak girisini kapatmak icin blok yok');
        }

        const shelterCenter = new Vec3(shelter.x, shelter.y, shelter.z);
        const currentCenter = this.bot.entity.position.floored();
        const centers = [currentCenter];
        if (currentCenter.distanceTo(shelterCenter) > 1) {
            centers.push(shelterCenter);
        }
        this.bot.pathfinder.setMovements(this.createMovements(true, true));
        await this.goto(new goals.GoalNear(
            shelterCenter.x,
            shelterCenter.y,
            shelterCenter.z,
            1
        ), 30000);

        const offsets = [
            [1, 0, 0], [1, 1, 0],
            [-1, 0, 0], [-1, 1, 0],
            [0, 0, 1], [0, 1, 1],
            [0, 0, -1], [0, 1, -1],
            [0, 2, 0]
        ];
        let placed = 0;
        for (const center of centers) {
            for (const [dx, dy, dz] of offsets) {
                if (this.countEmergencyBlocks() < 1) break;
                try {
                    const before = this.countEmergencyBlocks();
                    await this.placeEmergencyBlockAt(center.offset(dx, dy, dz));
                    if (this.countEmergencyBlocks() < before) placed += 1;
                } catch (error) {
                    console.log(`Barinak kapatma noktasi atlandi: ${error.message}`);
                }
            }
        }
        if (placed < 1) throw new Error('Barinak kapatilamadi');

        this.memory?.setFlag('shelterBarricaded', true);
        console.log(`Barinak girisi gecici olarak kapatildi. blok=${placed}`);
        await this.sleepCancellable(15000, 500, () => {
            const threat = this.nearestImmediateHostile(4);
            if (threat) {
                throw new Error(
                    `Barinak yakininda ${entityName(threat)} var; barikat bekleme kesildi`
                );
            }
        });
    }

    async openShelterBarricadeFor(action) {
        if ([
            'barricade_shelter',
            'flee',
            'fight',
            'swim',
            'eat',
            'sleep',
            'survive_night',
            'return_base',
            'idle'
        ].includes(action.type)) {
            return;
        }

        const shelter = this.memory?.data.shelter;
        if (!shelter) return;
        const center = new Vec3(shelter.x, shelter.y, shelter.z);
        if (this.bot.entity.position.distanceTo(center) > 5) return;

        for (const target of [
            center.offset(0, 2, 0),
            center.offset(1, 1, 0),
            center.offset(1, 0, 0)
        ]) {
            const block = this.bot.blockAt(target);
            if (!block || block.name === 'air') continue;
            if (!block.diggable || !this.bot.canDigBlock(block)) continue;
            await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
            await this.equipBestTool(block);
            await this.bot.dig(block);
            await sleep(150);
        }
        this.memory?.setFlag('shelterBarricaded', false);
        console.log('Barinak girisi tekrar acildi.');
    }

    async collectEmergencyBlocks(targetCount) {
        const failed = new Set();
        while (this.countEmergencyBlocks() < targetCount) {
            this.assertActionActive();
            if (this.nearbyImmediateHostile(6) && this.bot.health <= 16) {
                throw new Error('Acil blok toplama saldiri altinda kesildi');
            }

            const block = this.findEmergencyDigBlock(failed);
            if (!block) break;

            await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
            await this.equipBestTool(block);
            try {
                await Promise.race([
                    this.bot.dig(block, true, new Vec3(0, 1, 0)),
                    sleep(6000).then(() => {
                        throw new Error('Acil blok kazisi zaman asimi');
                    })
                ]);
            } catch (error) {
                if (typeof this.bot.stopDigging === 'function') {
                    try {
                        this.bot.stopDigging();
                    } catch {
                        // Best effort cleanup before trying another nearby block.
                    }
                }
                console.log(`Acil blok kazilamadi: ${block.name} ${block.position} (${error.message})`);
                failed.add(block.position.toString());
                continue;
            }
            await sleep(300);
        }
    }

    findEmergencyDigBlock(failed = new Set()) {
        const feet = this.bot.entity.position.floored();
        const names = new Set([
            'dirt',
            'grass_block',
            'coarse_dirt',
            'podzol',
            'cobblestone',
            'stone',
            'deepslate',
            'cobbled_deepslate',
            'tuff'
        ]);
        const candidates = [];

        for (let radius = 1; radius <= 4; radius++) {
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
                    if (dx === 0 && dz === 0) continue;

                    for (let dy = -1; dy <= -1; dy++) {
                        const block = this.bot.blockAt(feet.offset(dx, dy, dz));
                        if (
                            block &&
                            !failed.has(block.position.toString()) &&
                            names.has(block.name) &&
                            block.diggable &&
                            this.bot.canDigBlock(block) &&
                            this.hasRequiredHarvestTool(block)
                        ) {
                            candidates.push(block);
                        }
                    }
                }
            }
            if (candidates.length > 0) break;
        }

        return candidates
            .sort((a, b) => this.emergencyDigScore(a) - this.emergencyDigScore(b))[0] ||
            null;
    }

    emergencyDigScore(block) {
        const softBlocks = new Set([
            'dirt',
            'grass_block',
            'coarse_dirt',
            'podzol'
        ]);
        const toolPenalty = softBlocks.has(block.name) ? 0 : 50;
        return toolPenalty + block.position.distanceTo(this.bot.entity.position);
    }

    countEmergencyBlocks() {
        return this.bot.inventory.items()
            .filter(item => this.isEmergencyBlockItem(item.name))
            .reduce((total, item) => total + item.count, 0);
    }

    findEmergencyBlock() {
        return this.bot.inventory.items()
            .find(item => this.isEmergencyBlockItem(item.name)) || null;
    }

    isEmergencyBlockItem(name) {
        return [
            'dirt',
            'grass_block',
            'coarse_dirt',
            'podzol',
            'cobblestone',
            'cobbled_deepslate',
            'tuff',
            'deepslate',
            'stone',
            'oak_planks'
        ].includes(name);
    }

    async placeEmergencyBlockAt(target) {
        let existing = this.bot.blockAt(target);
        if (existing?.boundingBox === 'block') return;
        if (existing?.name !== 'air') {
            if (!existing?.diggable) {
                throw new Error(`Acil siper hedefi temizlenemiyor: ${target}`);
            }
            await this.bot.lookAt(existing.position.offset(0.5, 0.5, 0.5), true);
            await this.equipBestTool(existing);
            await this.bot.dig(existing);
            await sleep(120);
            existing = this.bot.blockAt(target);
            if (existing?.name !== 'air') {
                throw new Error(`Acil siper hedefi dolu kaldi: ${target}`);
            }
        }

        const item = this.findEmergencyBlock();
        if (!item) throw new Error('Acil siper blogu bitti');

        const references = [
            { offset: [0, -1, 0], face: new Vec3(0, 1, 0) },
            { offset: [-1, 0, 0], face: new Vec3(1, 0, 0) },
            { offset: [1, 0, 0], face: new Vec3(-1, 0, 0) },
            { offset: [0, 0, -1], face: new Vec3(0, 0, 1) },
            { offset: [0, 0, 1], face: new Vec3(0, 0, -1) }
        ]
            .map(candidate => ({
                block: this.bot.blockAt(target.offset(...candidate.offset)),
                face: candidate.face
            }))
            .find(candidate => candidate.block?.boundingBox === 'block');
        if (!references) {
            throw new Error(`Acil siper icin referans yok: ${target}`);
        }

        await this.bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
        await this.bot.equip(item, 'hand');
        try {
            await this.bot.placeBlock(references.block, references.face);
        } catch (error) {
            await this.useItemOnBlock(references.block, references.face);
        }
        await sleep(120);
    }

    async returnBase() {
        const base = this.memory?.data.base || this.memory?.data.shelter;
        if (!base) throw new Error('Ana us konumu hafizada yok');

        console.log(`Ana usse donuluyor: (${base.x}, ${base.y}, ${base.z})`);
        const movement = this.createMovements(true, true);
        this.bot.pathfinder.setMovements(movement);
        try {
            await this.goto(new goals.GoalNear(base.x, base.y, base.z, 4), 180000);
        } catch (error) {
            this.assertActionActive();
            console.log(
                `Ana us yolu bulunamadi, manuel kacis merdiveni deneniyor: ${error.message}`
            );
            if (this.nearbyImmediateHostile(8) && this.bot.health <= 12) {
                throw new Error('Ana usse donus saldiri altinda kesildi');
            }
            if (this.bot.entity.position.y > base.y + 5) {
                const descended = await this.descendFromHighSpot(
                    'Ana usse donmek icin once yuksek noktadan in'
                );
                if (descended) {
                    this.bot.pathfinder.setMovements(this.createMovements(true, true));
                    await this.goto(new goals.GoalNear(base.x, base.y, base.z, 6), 180000);
                    this.surfaceAnchor = new Vec3(base.x, base.y, base.z);
                    return;
                }
            }
            await this.carveEscapeStaircase();
            this.bot.pathfinder.setMovements(this.createMovements(true, true));
            await this.goto(new goals.GoalNear(base.x, base.y, base.z, 6), 180000);
        }
        this.surfaceAnchor = new Vec3(base.x, base.y, base.z);
    }

    async establishMine(action) {
        const base = this.memory?.data.base || this.memory?.data.shelter;
        if (!base) throw new Error('Maden icin ana us gerekli');

        if (this.bot.entity.position.distanceTo(
            new Vec3(base.x, base.y, base.z)
        ) > 12) {
            await this.returnBase();
        }

        const entrance = this.findMineEntrance(new Vec3(base.x, base.y, base.z));
        this.bot.pathfinder.setMovements(this.createMovements(false));
        await this.goto(
            new goals.GoalNear(entrance.x, entrance.y, entrance.z, 1),
            20000
        );
        this.memory?.setProject('mine', entrance, {
            branch: 0,
            lowestY: entrance.y
        });
        await this.mineTunnel({
            ...action,
            candidates: ['iron_ore', 'coal_ore']
        });
    }

    async mineTunnel(action) {
        const mine = this.memory?.data.mine;
        const origin = this.bot.entity.position.floored();
        const branch = mine?.branch || 0;
        const directions = [
            [1, 0], [0, 1], [-1, 0], [0, -1]
        ];
        const [dx, dz] = directions[branch % directions.length];
        const targetDepth = action.resource === 'diamond' ? -54 : -32;
        const descend = origin.y > targetDepth
            ? Math.min(6, origin.y - targetDepth)
            : 0;
        const target = origin.offset(dx * 16, -descend, dz * 16);

        console.log(
            `Guvenli maden kolu: ${origin.toString()} -> ${target.toString()}`
        );
        const movement = this.createMovements(true);
        this.bot.pathfinder.setMovements(movement);

        try {
            const result = await this.gotoUntilResource(
                new goals.GoalNear(target.x, target.y, target.z, 2),
                action.candidates || [],
                45000
            );
            if (result.resourceFound) {
                console.log(
                    `Maden kaynagi bulundu: ${result.resourceFound.name} ` +
                    result.resourceFound.position.toString()
                );
                await this.equipBestTool(result.resourceFound);
                await this.goto(
                    new goals.GoalLookAtBlock(
                        result.resourceFound.position,
                        this.bot.world,
                        { reach: 4.5 }
                    ),
                    30000
                );
                const current = this.bot.blockAt(result.resourceFound.position);
                if (current && this.bot.canDigBlock(current)) {
                    await this.bot.dig(current);
                    await sleep(500);
                }
            }
        } finally {
            this.bot.pathfinder.setMovements(this.createMovements(false));
        }

        if (mine) {
            mine.branch = branch + 1;
            mine.lowestY = Math.min(mine.lowestY, Math.floor(this.bot.entity.position.y));
            this.memory.save();
        }
        this.blocksSinceTorch = 4;
        await this.maybePlaceTorch(true);
    }

    async smelt(action) {
        let furnaceBlock = this.findNearbyBlock('furnace', 8);
        if (!furnaceBlock) {
            const furnaceItem = this.bot.inventory.items()
                .find(item => item.name === 'furnace');
            if (!furnaceItem) throw new Error('Eritme icin furnace yok');
            furnaceBlock = await this.placeWorkstationNearBase(furnaceItem);
        }

        await this.goto(new goals.GoalNear(
            furnaceBlock.position.x,
            furnaceBlock.position.y,
            furnaceBlock.position.z,
            2
        ), 15000);

        const furnace = await this.bot.openFurnace(furnaceBlock);
        try {
            let collected = 0;
            const oldOutput = furnace.outputItem();
            if (oldOutput) {
                const taken = await furnace.takeOutput();
                if (taken?.name === action.output) collected += taken.count;
            }
            if (collected >= action.count) return;

            const oldInput = furnace.inputItem();
            if (oldInput && oldInput.name !== action.input) {
                await furnace.takeInput();
            }

            const existingInput = furnace.inputItem();
            const inputInFurnace = existingInput?.name === action.input
                ? existingInput.count
                : 0;
            const remaining = Math.max(
                0,
                action.count - collected - inputInFurnace
            );
            if (remaining > 0) {
                const input = this.bot.inventory.items()
                    .find(item => item.name === action.input);
                if (!input) throw new Error(`${action.input} envanterde yok`);
                await furnace.putInput(
                    input.type,
                    input.metadata,
                    Math.min(remaining, input.count)
                );
            }

            const ensureFuel = async () => {
                if (furnace.fuelItem()) return;
                const fuel = this.findSmeltingFuel();
                if (!fuel) throw new Error('Furnace icin yakit yok');
                const needed = Math.max(1, action.count - collected);
                const fuelCount = ['coal', 'charcoal'].includes(fuel.name)
                    ? Math.max(1, Math.ceil(needed / 8))
                    : Math.max(1, Math.ceil(needed / 1.5));
                await furnace.putFuel(
                    fuel.type,
                    fuel.metadata,
                    Math.min(fuel.count, fuelCount)
                );
            };
            await ensureFuel();

            const deadline = Date.now() + action.count * 12000 + 15000;
            while (Date.now() < deadline) {
                const output = furnace.outputItem();
                if (output?.name === action.output) {
                    const taken = await furnace.takeOutput();
                    collected += taken?.count || 0;
                    if (collected >= action.count) return;
                }
                if (
                    collected > 0 &&
                    !furnace.inputItem() &&
                    !this.bot.inventory.items().some(item => item.name === action.input)
                ) {
                    return;
                }
                await sleep(1000);
            }
            throw new Error(`${action.output} eritme zaman asimi`);
        } finally {
            furnace.close();
        }
    }

    async fillBucket() {
        const sources = this.findWaterSources(64);
        if (sources.length === 0) {
            const attempts = (this.memory?.data.waterSearchAttempts || 0) + 1;
            this.memory?.setFlag('waterSearchAttempts', attempts);
            if (attempts >= 12) {
                this.memory?.setFlag('waterUnavailable', true);
                throw new Error('Yakin cevrede su bulunamadi; kuru tarla moduna geciliyor');
            }
            const known = this.nearestKnownWaterSource();
            if (known) {
                const distance = this.bot.entity.position.distanceTo(known);
                console.log(
                    `Bilinen su kaynagina donuluyor: ${known.toString()} ` +
                    `mesafe=${distance.toFixed(1)}`
                );
                this.bot.pathfinder.setMovements(this.createMovements(false));
                if (distance > 48) {
                    await this.moveToward(known, 36, 30000);
                } else {
                    await this.goto(
                        new goals.GoalNear(known.x, known.y, known.z, 5),
                        45000
                    );
                }
                return;
            }

            this.bot.pathfinder.setMovements(this.createMovements(true));
            try {
                await this.explore({
                    resource: 'water',
                    candidates: [],
                    reason: 'Tarla kovasi icin kaynak su ara'
                });
            } finally {
                this.bot.pathfinder.setMovements(this.createMovements(false));
            }
            return;
        }
        this.memory?.setFlag('waterSearchAttempts', 0);
        this.memory?.setFlag('waterUnavailable', false);

        const bucket = this.bot.inventory.items()
            .find(item => item.name === 'bucket');
        if (!bucket) throw new Error('Bos kova yok');

        let lastError = null;
        for (const water of sources.slice(0, 12)) {
            this.memory?.remember('waterSources', water.position);
            try {
                const distance = this.bot.entity.position
                    .distanceTo(water.position.offset(0.5, 0.5, 0.5));
                if (distance > 4.5) {
                    await this.goto(
                        new goals.GoalLookAtBlock(
                            water.position,
                            this.bot.world,
                            { reach: 4.5 }
                        ),
                        30000
                    );
                }
                console.log(
                    `Gorulebilir kaynak su deneniyor: ${water.position.toString()} ` +
                    `durum=${JSON.stringify(water.getProperties?.() || {})} ` +
                    `mesafe=${this.bot.entity.position.distanceTo(water.position).toFixed(2)}`
                );
                if (await this.collectWater(water, bucket)) {
                    return;
                }
                throw new Error('Kova dolmadi');
            } catch (error) {
                lastError = error;
                console.log(
                    `Su kaynagina erisilemedi ${water.position.toString()}:`,
                    error.message
                );
            }
        }
        throw new Error(
            `Gorulen su kaynaklarindan kova doldurulamadi: ` +
            `${lastError?.message || 'bilinmeyen hata'}`
        );
    }

    async collectWater(water, bucket) {
        await this.bot.equip(bucket, 'hand');
        await sleep(300);
        await this.bot.lookAt(
            water.position.offset(0.5, 0.5, 0.5),
            true
        );
        const delta = this.bot.entity.position.minus(water.position);
        await this.bot.activateBlock(water, this.interactionFace(delta));
        await sleep(900);
        if (this.bot.inventory.items()
            .some(item => item.name === 'water_bucket')) {
            return true;
        }

        await this.bot.lookAt(
            water.position.offset(0.5, 0.5, 0.5),
            true
        );
        this.bot.activateItem();
        await sleep(900);
        return this.bot.inventory.items()
            .some(item => item.name === 'water_bucket');
    }

    async gatherSeeds(action) {
        const grassIds = ['short_grass', 'tall_grass']
            .map(name => this.bot.registry.blocksByName[name]?.id)
            .filter(id => id != null);
        const targetCount = action.count || 1;
        const seedId = this.bot.registry.itemsByName.wheat_seeds.id;
        const startCount = this.bot.inventory.count(seedId, null);

        for (let attempts = 0;
            attempts < 40 && this.bot.inventory.count(seedId, null) < targetCount;
            attempts++
        ) {
            const grass = this.bot.findBlock({
                matching: grassIds,
                maxDistance: 64
            });
            if (!grass) {
                await this.explore({
                    resource: 'grass',
                    reason: 'Bugday tohumu icin ot ara'
                });
                continue;
            }
            await this.goto(new goals.GoalNear(
                grass.position.x,
                grass.position.y,
                grass.position.z,
                2
            ), 20000);
            await this.bot.dig(grass);
            await sleep(350);
        }

        const currentCount = this.bot.inventory.count(seedId, null);
        if (currentCount < targetCount && currentCount > startCount) {
            console.log(
                `Tohum toplama ilerledi: ${currentCount}/${targetCount}; sonraki dongude devam edilecek.`
            );
            return;
        }

        if (currentCount < targetCount) {
            throw new Error('Yeterli bugday tohumu bulunamadi');
        }
    }

    async buildFarm(action = {}) {
        const base = this.memory?.data.base;
        if (!base) throw new Error('Tarla icin ana us yok');
        const savedCenter = this.memory?.data.farmInProgress;
        let center = savedCenter
            ? new Vec3(savedCenter.x, savedCenter.y, savedCenter.z)
            : this.findExistingFarmCenter(new Vec3(base.x, base.y, base.z)) ||
                this.findFarmCenter(new Vec3(base.x, base.y, base.z));
        if (!center) throw new Error('Base yakininda 3x3 tarla alani bulunamadi');
        const dryFarm = Boolean(action.dry || this.memory?.data.waterUnavailable);
        let waterSource = this.findFarmWaterSource(center);
        if (waterSource) center = waterSource.position.offset(0, 1, 0);
        this.memory?.setFlag('farmInProgress', {
            x: center.x,
            y: center.y,
            z: center.z,
            planted: this.countFarmCrops(center),
            waterPlaced: Boolean(waterSource)
        });

        const waterBucket = this.bot.inventory.items()
            .find(item => item.name === 'water_bucket');
        const hoe = this.bot.inventory.items()
            .find(item => item.name.endsWith('_hoe'));
        if (!hoe) throw new Error('Tarla icin capa gerekli');

        await this.goto(new goals.GoalNear(center.x, center.y, center.z, 2), 20000);
        let centerBlock = waterSource ||
            this.bot.blockAt(center.offset(0, -1, 0));
        console.log(
            `Tarla devam durumu: merkez=${center.toString()} ` +
            `merkezBlok=${centerBlock?.name} ekin=${this.countFarmCrops(center)}/8`
        );
        if (centerBlock?.name !== 'water' && !dryFarm) {
            if (!waterBucket) throw new Error('Tarla icin su kovasi gerekli');
            if (centerBlock?.name !== 'air') {
                await this.bot.dig(centerBlock);
            }
            const bottom = this.bot.blockAt(center.offset(0, -2, 0));
            if (!bottom || bottom.boundingBox !== 'block') {
                throw new Error('Tarla suyu icin saglam taban yok');
            }
            await this.bot.equip(waterBucket, 'hand');
            await this.bot.activateBlock(bottom, new Vec3(0, 1, 0));
            await sleep(1000);
            centerBlock = this.bot.blockAt(center.offset(0, -1, 0));
            if (centerBlock?.name !== 'water') {
                await this.bot.lookAt(
                    bottom.position.offset(0.5, 1, 0.5),
                    true
                );
                this.bot.activateItem();
                await sleep(1000);
                centerBlock = this.bot.blockAt(center.offset(0, -1, 0));
            }
            waterSource = this.findFarmWaterSource(center);
            if (!waterSource) {
                throw new Error('Tarla merkezine su yerlestirilemedi');
            }
            center = waterSource.position.offset(0, 1, 0);
            centerBlock = waterSource;
            this.memory?.setFlag('farmInProgress', {
                x: center.x,
                y: center.y,
                z: center.z,
                planted: this.countFarmCrops(center),
                waterPlaced: true
            });
        }

        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (dx === 0 && dz === 0) continue;
                const cropPosition = center.offset(dx, 0, dz);
                if (this.bot.blockAt(cropPosition)?.name === 'wheat') continue;

                let farmland = this.bot.blockAt(center.offset(dx, -1, dz));
                if (farmland?.name === 'wheat') {
                    await this.bot.dig(farmland);
                    await sleep(250);
                    farmland = this.bot.blockAt(center.offset(dx, -1, dz));
                }
                if (farmland?.name === 'air' || farmland?.name === 'water') {
                    const feet = this.bot.entity.position.floored();
                    if (feet.equals(farmland.position)) {
                        await this.goto(new goals.GoalNear(
                            center.x + 3,
                            center.y - 1,
                            center.z + 3,
                            1
                        ), 12000);
                    }
                    farmland = await this.placeFarmSoil(farmland.position);
                }
                if (
                    farmland &&
                    !this.isFarmSoilBase(farmland) &&
                    farmland.name !== 'farmland'
                ) {
                    if (
                        farmland.boundingBox === 'block' &&
                        farmland.diggable &&
                        this.bot.canDigBlock(farmland)
                    ) {
                        await this.gotoProjectWorkPosition(farmland.position);
                        await this.equipBestTool(farmland);
                        await this.bot.dig(farmland);
                        await sleep(250);
                        farmland = this.bot.blockAt(center.offset(dx, -1, dz));
                    }
                    farmland = await this.placeFarmSoil(farmland.position);
                }
                if (!farmland) {
                    throw new Error(`Tarla zemini okunamadi: ${cropPosition.toString()}`);
                }
                if (farmland?.name !== 'farmland') {
                    await this.bot.equip(hoe, 'hand');
                    let above = this.bot.blockAt(farmland.position.offset(0, 1, 0));
                    if (
                        above?.name !== 'air' &&
                        above?.name !== 'cave_air' &&
                        above?.name !== 'void_air'
                    ) {
                        if (above?.diggable) {
                            await this.bot.dig(above);
                            await sleep(250);
                            above = this.bot.blockAt(
                                farmland.position.offset(0, 1, 0)
                            );
                        } else {
                            throw new Error(
                                `Tarla ustu kapali: ${above?.position} blok=${above?.name}`
                            );
                        }
                    }
                    if (
                        above?.name !== 'air' &&
                        above?.name !== 'cave_air' &&
                        above?.name !== 'void_air'
                    ) {
                        throw new Error(
                            `Tarla ustu temizlenemedi: ${above?.position} ` +
                            `blok=${above?.name}`
                        );
                    }
                    await this.useItemOnBlock(farmland, new Vec3(0, 1, 0));
                    await sleep(500);
                    farmland = this.bot.blockAt(center.offset(dx, -1, dz));
                    if (farmland?.name !== 'farmland') {
                        await this.bot.activateBlock(farmland);
                        await sleep(300);
                        farmland = this.bot.blockAt(center.offset(dx, -1, dz));
                    }
                    if (farmland?.name !== 'farmland') {
                        await this.bot.lookAt(
                            farmland.position.offset(0.5, 0.95, 0.5),
                            true
                        );
                        this.bot.activateItem();
                        await sleep(500);
                        farmland = this.bot.blockAt(center.offset(dx, -1, dz));
                    }
                }
                if (farmland?.name !== 'farmland') {
                    throw new Error(
                        `Toprak surulemedi: ${farmland?.position} ` +
                        `blok=${farmland?.name} ` +
                        `ustu=${this.bot.blockAt(
                            farmland.position.offset(0, 1, 0)
                        )?.name} elde=${this.bot.heldItem?.name}`
                    );
                }
                const seeds = this.bot.inventory.items()
                    .find(item => item.name === 'wheat_seeds');
                if (!seeds) throw new Error('Ekim sirasinda tohum bitti');
                await this.bot.equip(seeds, 'hand');
                try {
                    await this.bot.placeBlock(farmland, new Vec3(0, 1, 0));
                } catch (error) {
                    if (this.bot.blockAt(cropPosition)?.name !== 'wheat') {
                        throw error;
                    }
                }
                await sleep(150);
                this.memory?.setFlag('farmInProgress', {
                    x: center.x,
                    y: center.y,
                    z: center.z,
                    planted: this.countFarmCrops(center),
                    waterPlaced: Boolean(this.findFarmWaterSource(center, 0))
                });
            }
        }
        const planted = this.countFarmCrops(center);
        const hydrated = Boolean(this.findFarmWaterSource(center, 0));
        if ((!dryFarm && !hydrated) || planted < 8) {
            throw new Error(
                `Tarla dogrulanamadi: ${hydrated ? 'sulu' : 'kuru'} ` +
                `${planted}/8 ekin`
            );
        }
        this.memory?.setProject('farm', center, {
            crop: 'wheat',
            hydrated
        });
        this.memory?.setFlag('farmInProgress', null);
    }

    async upgradeBase() {
        const base = this.memory?.data.base;
        if (!base) throw new Error('Gelistirilecek ana us yok');
        const center = new Vec3(base.x, base.y, base.z);
        const planks = this.bot.inventory.items()
            .find(item => item.name.endsWith('_planks') && item.count >= 16);
        if (!planks) throw new Error('Us gelistirmesi icin 16 tahta gerekli');

        const edgeTargets = [];
        const cornerTargets = [];
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                if (Math.abs(dx) === 2 || Math.abs(dz) === 2) {
                    const target = center.offset(dx, 2, dz);
                    if (Math.abs(dx) === 2 && Math.abs(dz) === 2) {
                        cornerTargets.push(target);
                    } else {
                        edgeTargets.push(target);
                    }
                }
            }
        }
        for (const target of [...edgeTargets, ...cornerTargets]) {
            await this.placeItemAt(target, planks.name);
        }
        this.memory?.setProject('upgradedBase', center, {
            style: 'stone_shelter_with_wooden_eaves'
        });
    }

    async equipIronArmor() {
        const slots = {
            iron_helmet: 'head',
            iron_chestplate: 'torso',
            iron_leggings: 'legs',
            iron_boots: 'feet'
        };
        for (const [name, slot] of Object.entries(slots)) {
            const item = this.bot.inventory.items()
                .find(entry => entry.name === name);
            if (!item) throw new Error(`${name} envanterde yok`);
            await this.bot.equip(item, slot);
        }
        this.memory?.setFlag('ironArmorEquipped', true);
        console.log('Tam demir zirh kusanildi.');
    }

    async buildHouse() {
        const base = this.memory?.data.base;
        if (!base) throw new Error('Ev icin ana us yok');
        const center = new Vec3(base.x, base.y, base.z - 14);
        await this.goto(
            new goals.GoalNear(center.x, center.y, center.z, 3),
            45000
        );

        const floorTargets = [];
        const stoneWallTargets = [];
        const woodWallTargets = [];
        const roofTargets = [];

        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                floorTargets.push(center.offset(dx, -1, dz));
                const edge = Math.abs(dx) === 3 || Math.abs(dz) === 3;
                const doorway = dz === 3 && dx === 0;
                const window =
                    (Math.abs(dx) === 3 && dz === 0) ||
                    (Math.abs(dz) === 3 && Math.abs(dx) === 2);
                if (edge && !doorway) {
                    stoneWallTargets.push(center.offset(dx, 0, dz));
                }
                if (edge && !doorway && !window) {
                    woodWallTargets.push(center.offset(dx, 1, dz));
                    woodWallTargets.push(center.offset(dx, 2, dz));
                }
            }
        }

        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                roofTargets.push(center.offset(dx, 3, dz));
            }
        }
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                roofTargets.push(center.offset(dx, 4, dz));
            }
        }

        const deadline = Date.now() + 28000;
        await this.placeProjectBatch(
            floorTargets,
            'cobblestone',
            deadline,
            true
        );
        await this.placeProjectBatch(stoneWallTargets, 'cobblestone', deadline);
        await this.placeProjectBatch(woodWallTargets, 'oak_planks', deadline);
        await this.placeProjectBatch(roofTargets, 'oak_planks', deadline);

        const verifiedFloor = floorTargets.filter(target =>
            this.bot.blockAt(target)?.name === 'cobblestone'
        ).length;
        const verifiedStoneWalls = stoneWallTargets.filter(target =>
            this.bot.blockAt(target)?.name === 'cobblestone'
        ).length;
        const verifiedWoodWalls = woodWallTargets.filter(target =>
            this.bot.blockAt(target)?.name === 'oak_planks'
        ).length;
        const verifiedRoof = roofTargets.filter(target =>
            this.bot.blockAt(target)?.name === 'oak_planks'
        ).length;
        const mostlyBuilt =
            verifiedFloor >= Math.ceil(floorTargets.length * 0.85) &&
            verifiedStoneWalls >= Math.ceil(stoneWallTargets.length * 0.75) &&
            verifiedWoodWalls >= Math.ceil(woodWallTargets.length * 0.70) &&
            verifiedRoof >= Math.ceil(roofTargets.length * 0.60);
        if (!mostlyBuilt) {
            throw new Error(
                `Ev dogrulanamadi: temel ${verifiedFloor}/${floorTargets.length}, ` +
                `tas duvar ${verifiedStoneWalls}/${stoneWallTargets.length}, ` +
                `ahsap duvar ${verifiedWoodWalls}/${woodWallTargets.length}, ` +
                `cati ${verifiedRoof}/${roofTargets.length}`
            );
        }

        this.memory?.setProject('beautifulHouse', center, {
            style: 'cobblestone_oak_cottage',
            width: 7,
            depth: 7
        });
    }

    async placeProjectBatch(targets, itemName, deadline, replace = false) {
        for (const target of targets) {
            if (Date.now() >= deadline) return;
            if (this.bot.blockAt(target)?.name === itemName) continue;
            try {
                await this.ensureProjectBlock(target, itemName, replace);
            } catch (error) {
                console.log(
                    `Proje blogu atlandi: ${itemName} ${target.toString()} ` +
                    `sebep=${error.message}`
                );
            }
        }
    }

    async organizeStorage() {
        const anchor =
            this.memory?.data.beautifulHouse ||
            this.memory?.data.upgradedBase ||
            this.memory?.data.base ||
            this.memory?.data.shelter;
        if (!anchor) throw new Error('Depo icin ana us yok');
        const center = new Vec3(anchor.x, anchor.y, anchor.z);
        const categories = [
            { name: 'building', offset: [-2, 0, -1] },
            { name: 'ores', offset: [-2, 0, 1] },
            { name: 'food_farm', offset: [2, 0, -1] },
            { name: 'tools_misc', offset: [2, 0, 1] }
        ];
        const positions = [];

        for (const category of categories) {
            const target = center.offset(...category.offset);
            await this.ensureStoragePlacementSupport(target);
            let block = this.bot.blockAt(target);
            if (block?.name !== 'chest') {
                await this.ensureProjectBlock(target, 'chest', true);
                block = this.bot.blockAt(target);
            }
            if (block?.name !== 'chest') {
                throw new Error(`${category.name} sandigi yerlestirilemedi`);
            }
            positions.push({
                ...category,
                x: target.x,
                y: target.y,
                z: target.z
            });
            this.memory?.remember('chests', target);
        }

        this.memory?.setProject('storageSystem', center, {
            anchor: this.memory?.data.beautifulHouse ? 'house' : 'base',
            chests: positions
        });
        await this.storeItems();
    }

    async ensureStoragePlacementSupport(target) {
        const floorPosition = target.offset(0, -1, 0);
        let floor = this.bot.blockAt(floorPosition);
        if (!floor || floor.boundingBox !== 'block') {
            await this.placeFarmSoil(floorPosition);
            floor = this.bot.blockAt(floorPosition);
        }
        if (!floor || floor.boundingBox !== 'block') {
            throw new Error(`Sandik zemini hazirlanamadi: ${target.toString()}`);
        }

        const head = this.bot.blockAt(target.offset(0, 1, 0));
        if (
            head &&
            head.name !== 'air' &&
            head.name !== 'cave_air' &&
            head.name !== 'void_air' &&
            head.diggable &&
            this.bot.canDigBlock(head)
        ) {
            await this.equipBestTool(head);
            await this.bot.dig(head);
            await sleep(150);
        }
    }

    async expandFarm() {
        const farm = this.memory?.data.farm;
        if (!farm) throw new Error('Buyutulecek tarla yok');
        const center = new Vec3(farm.x, farm.y, farm.z);
        const hoe = this.bot.inventory.items()
            .find(item => item.name.endsWith('_hoe'));
        if (!hoe) throw new Error('Tarla buyutmek icin capa yok');

        await this.goto(new goals.GoalNear(center.x, center.y, center.z, 3), 30000);
        const offsets = [];
        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                if (dx === 0 && dz === 0) continue;
                offsets.push([dx, dz]);
            }
        }
        offsets.sort((a, b) =>
            Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1])
        );

        for (const [dx, dz] of offsets) {
            if (this.countFarmCropsRadius(center, 3) >= 24) break;
            const cropPosition = center.offset(dx, 0, dz);
            if (this.bot.blockAt(cropPosition)?.name === 'wheat') continue;

            try {
                const soilPosition = center.offset(dx, -1, dz);
                await this.gotoProjectWorkPosition(soilPosition);
                let soil = this.bot.blockAt(soilPosition);
                if (!['dirt', 'grass_block', 'farmland'].includes(soil?.name)) {
                    soil = await this.placeFarmSoil(soil.position);
                }
                if (soil?.name !== 'farmland') {
                    await this.bot.equip(hoe, 'hand');
                    await this.useItemOnBlock(soil, new Vec3(0, 1, 0));
                    await sleep(400);
                    soil = this.bot.blockAt(soil.position);
                }
                if (soil?.name !== 'farmland') {
                    throw new Error(`toprak surulemedi: ${soil?.position}`);
                }

                const seeds = this.bot.inventory.items()
                    .find(item => item.name === 'wheat_seeds');
                if (!seeds) throw new Error('tohum bitti');
                await this.bot.equip(seeds, 'hand');
                try {
                    await this.bot.placeBlock(soil, new Vec3(0, 1, 0));
                } catch (error) {
                    if (this.bot.blockAt(cropPosition)?.name !== 'wheat') throw error;
                }
            } catch (error) {
                console.log(
                    `Tarla karesi atlandi ${cropPosition.toString()}:`,
                    error.message
                );
            }
        }

        const crops = this.countFarmCropsRadius(center, 3);
        if (crops < 24) throw new Error(`Buyuk tarla eksik: ${crops}/24`);
        this.memory?.setProject('expandedFarm', center, {
            crop: 'wheat',
            cropCount: crops,
            radius: 3,
            hydrated: true
        });
        this.memory.data.farm.cropCount = crops;
        this.memory.save();
    }

    async gatherSaplings(action) {
        const desired = action.count || 1;
        const leavesId = this.bot.registry.blocksByName.oak_leaves?.id;
        if (leavesId == null) throw new Error('oak_leaves kaydi bulunamadi');

        let attempts = 0;
        const skippedLeaves = new Set();
        while (
            inventoryCount(this.bot, 'oak_sapling') < desired &&
            attempts < 32
        ) {
            await this.collectNearbyDrops('oak_sapling', 10);
            if (inventoryCount(this.bot, 'oak_sapling') >= desired) break;

            const leaves = this.findReachableLeaves(leavesId, skippedLeaves);
            if (!leaves) {
                const oakLog = this.bot.registry.blocksByName.oak_log;
                const log = oakLog ? this.findSafeMineTarget(oakLog) : null;
                if (log) {
                    try {
                        await this.mine({ type: 'mine', block: 'oak_log', item: 'oak_log' });
                        await sleep(1500);
                        await this.collectNearbyDrops('oak_sapling', 12);
                    } catch (error) {
                        console.log('Fidan icin agac govdesi kirilamadi:', error.message);
                    }
                    attempts++;
                    continue;
                }
                await this.explore({
                    resource: 'mese_yapraklari',
                    candidates: ['oak_leaves', 'oak_log']
                });
                attempts++;
                continue;
            }

            try {
                let current = this.bot.blockAt(leaves.position);
                if (!current || !this.bot.canDigBlock(current)) {
                    await this.goto(new goals.GoalNearXZ(
                        leaves.position.x,
                        leaves.position.z,
                        2
                    ), 10000);
                }
                current = this.bot.blockAt(leaves.position);
                if (current?.name !== 'oak_leaves') {
                    attempts++;
                    continue;
                }
                if (!this.bot.canDigBlock(current)) {
                    throw new Error('yaprak menzil disinda');
                }
                await this.bot.lookAt(current.position.offset(0.5, 0.5, 0.5), true);
                await this.equipBestTool(current);
                await this.bot.dig(current);
                await sleep(900);
                await this.collectNearbyDrops('oak_sapling', 12);
            } catch (error) {
                skippedLeaves.add(this.positionKey(leaves.position));
                console.log(
                    `Fidan yapragi atlandi ${leaves.position.toString()}:`,
                    error.message
                );
            }
            attempts++;
        }
    }

    findReachableLeaves(leavesId, skipped = new Set()) {
        return this.bot.findBlocks({
                matching: leavesId,
                maxDistance: 48,
                count: 192
            })
            .map(position => this.bot.blockAt(position))
            .filter(block =>
                block?.name === 'oak_leaves' &&
                !skipped.has(this.positionKey(block.position)) &&
                this.hasOpenMiningFace(block.position)
            )
            .sort((a, b) => {
                const currentY = Math.floor(this.bot.entity.position.y);
                const yDelta =
                    Math.abs(a.position.y - currentY) -
                    Math.abs(b.position.y - currentY);
                if (yDelta !== 0) return yDelta;
                return this.mineTargetScore(a) - this.mineTargetScore(b);
            })[0] || null;
    }

    positionKey(position) {
        return `${position.x},${position.y},${position.z}`;
    }

    async establishTreeGarden() {
        const base = this.memory?.data.base;
        if (!base) throw new Error('Agac bahcesi icin ana us yok');
        const spots = [
            new Vec3(base.x - 18, base.y, base.z - 10),
            new Vec3(base.x - 18, base.y, base.z),
            new Vec3(base.x - 18, base.y, base.z + 10)
        ];
        await this.plantGardenSpots(spots);
        this.memory?.setProject(
            'treeGarden',
            spots[1],
            {
                species: 'oak',
                spots: spots.map(position => ({
                    x: position.x,
                    y: position.y,
                    z: position.z
                })),
                harvests: 0
            }
        );
    }

    async maintainTreeGarden() {
        const garden = this.memory?.data.treeGarden;
        if (!garden) throw new Error('Bakimi yapilacak agac bahcesi yok');
        const spots = garden.spots.map(
            spot => new Vec3(spot.x, spot.y, spot.z)
        );
        let harvested = 0;

        for (const spot of spots) {
            const logs = () => this.bot.findBlocks({
                matching: block =>
                    block?.name === 'oak_log' || block?.name === 'oak_wood',
                maxDistance: 6,
                count: 64,
                point: spot
            });
            let positions = logs();
            if (positions.length > 0) {
                harvested++;
                for (const position of positions.sort((a, b) => a.y - b.y)) {
                    try {
                        let block = this.bot.blockAt(position);
                        if (!block || !['oak_log', 'oak_wood'].includes(block.name)) {
                            continue;
                        }
                        if (!this.bot.canDigBlock(block)) {
                            await this.goto(new goals.GoalNearXZ(
                                position.x,
                                position.z,
                                2
                            ), 10000);
                        }
                        block = this.bot.blockAt(position);
                        if (!block || !this.bot.canDigBlock(block)) {
                            throw new Error('govde menzil disinda');
                        }
                        await this.bot.lookAt(
                            block.position.offset(0.5, 0.5, 0.5),
                            true
                        );
                        await this.equipBestTool(block);
                        await this.bot.dig(block);
                    } catch (error) {
                        console.log(
                            `Bahce govdesi atlandi ${position.toString()}:`,
                            error.message
                        );
                    }
                }
                await sleep(1500);
            }
        }

        await this.plantGardenSpots(spots, false);
        garden.harvests = (garden.harvests || 0) + harvested;
        garden.lastMaintainedAt = new Date().toISOString();
        this.memory.save();
        console.log(`Agac bahcesi bakimi: ${harvested} agac hasat edildi.`);
    }

    async establishDeepMine() {
        const targetY = -32;
        if ((this.memory?.data.mine?.lowestY ?? 0) <= -27) {
            this.memory?.setProject('deepMine', this.memory.data.mine, {
                targetY,
                reachedY: this.memory.data.mine.lowestY
            });
            return;
        }
        let attempts = 0;
        while (this.bot.entity.position.y > targetY && attempts < 14) {
            await this.mineTunnel({
                resource: 'diamond',
                candidates: []
            });
            attempts++;
        }
        if (this.bot.entity.position.y > -27) {
            throw new Error(
                `Derin maden yeterince inemedi: Y=${Math.floor(
                    this.bot.entity.position.y
                )}`
            );
        }
        this.memory?.setProject('deepMine', this.bot.entity.position, {
            targetY,
            reachedY: Math.floor(this.bot.entity.position.y)
        });
    }

    async ensureProjectBlock(target, itemName, replace = false) {
        let current = this.bot.blockAt(target);
        if (current?.name === itemName) return current;

        const feet = this.bot.entity.position.floored();
        const occupiesTargetColumn =
            feet.x === target.x &&
            feet.z === target.z &&
            (feet.y === target.y || feet.y - 1 === target.y);
        if (
            occupiesTargetColumn ||
            this.bot.entity.position.distanceTo(target) > 4.2
        ) {
            await this.gotoProjectWorkPosition(target);
        }

        current = this.bot.blockAt(target);
        if (current?.name !== 'air') {
            if (!replace && current?.boundingBox === 'block') {
                throw new Error(
                    `${target.toString()} konumu ${current.name} ile dolu`
                );
            }
            await this.goto(new goals.GoalLookAtBlock(
                target,
                this.bot.world,
                { reach: 4.5 }
            ), 20000);
            current = this.bot.blockAt(target);
            if (!current || !this.bot.canDigBlock(current)) {
                throw new Error(
                    `${current?.name || 'blok'} proje alanindan kaldirilamiyor`
                );
            }
            await this.equipBestTool(current);
            await this.bot.dig(current);
        }

        await this.placeItemAt(target, itemName);
        await sleep(150);
        const placed = this.bot.blockAt(target);
        if (placed?.name !== itemName) {
            throw new Error(`${itemName} yerlestirilemedi: ${target.toString()}`);
        }
        return placed;
    }

    async gotoProjectWorkPosition(target) {
        const candidate = this.findProjectWorkPosition(target);
        if (candidate) {
            await this.goto(new goals.GoalBlock(
                candidate.x,
                candidate.y,
                candidate.z
            ), 20000);
            return;
        }
        await this.goto(new goals.GoalNear(
            target.x,
            target.y + 1,
            target.z,
            2
        ), 20000);
    }

    findProjectWorkPosition(target) {
        const offsets = [
            [2, 0], [-2, 0], [0, 2], [0, -2],
            [1, 0], [-1, 0], [0, 1], [0, -1]
        ];
        const candidates = [];
        for (const [dx, dz] of offsets) {
            for (let y = target.y + 1; y >= target.y - 4; y--) {
                const position = new Vec3(target.x + dx, y, target.z + dz);
                const feet = this.bot.blockAt(position);
                const head = this.bot.blockAt(position.offset(0, 1, 0));
                const floor = this.bot.blockAt(position.offset(0, -1, 0));
                if (
                    feet?.name === 'air' &&
                    head?.name === 'air' &&
                    floor?.boundingBox === 'block' &&
                    position.distanceTo(target) <= 4.5
                ) {
                    candidates.push(position);
                    break;
                }
            }
        }
        candidates
            .sort((a, b) =>
                a.distanceTo(this.bot.entity.position) -
                b.distanceTo(this.bot.entity.position)
            );

        return candidates[0] || null;
    }

    async collectNearbyDrops(itemName = null, maxDistance = 8) {
        const before = itemName ? inventoryCount(this.bot, itemName) : 0;
        const drops = Object.values(this.bot.entities)
            .filter(entity => entity?.name === 'item')
            .filter(entity => {
                const dx = entity.position.x - this.bot.entity.position.x;
                const dz = entity.position.z - this.bot.entity.position.z;
                const dy = Math.abs(entity.position.y - this.bot.entity.position.y);
                return Math.hypot(dx, dz) <= maxDistance && dy <= 12;
            })
            .filter(entity => {
                if (!itemName) return true;
                const dropped = typeof entity.getDroppedItem === 'function'
                    ? entity.getDroppedItem()
                    : null;
                return dropped?.name === itemName;
            })
            .sort((a, b) =>
                a.position.distanceTo(this.bot.entity.position) -
                b.position.distanceTo(this.bot.entity.position)
            );

        for (const drop of drops.slice(0, 8)) {
            try {
                try {
                    const yDistance = Math.abs(
                        drop.position.y - this.bot.entity.position.y
                    );
                    if (yDistance > 2) {
                        await this.goto(new goals.GoalNearXZ(
                            drop.position.x,
                            drop.position.z,
                            1
                        ), 8000);
                    } else {
                        await this.goto(new goals.GoalNear(
                            drop.position.x,
                            drop.position.y,
                            drop.position.z,
                            1
                        ), 8000);
                    }
                } catch (error) {
                    await this.goto(new goals.GoalNearXZ(
                        drop.position.x,
                        drop.position.z,
                        1
                    ), 8000);
                }
                await this.nudgeTowardDrop(drop, itemName, before);
                if (itemName) {
                    await this.waitForInventoryIncrease(itemName, before, 1200);
                } else {
                    await sleep(800);
                }
                if (itemName && inventoryCount(this.bot, itemName) > before) {
                    return true;
                }
            } catch (error) {
                console.log('Dusurulen item toplanamadi:', error.message);
            }
        }

        return itemName ? inventoryCount(this.bot, itemName) > before : drops.length > 0;
    }

    async nudgeTowardDrop(drop, itemName = null, beforeCount = 0) {
        const deadline = Date.now() + 1800;
        try {
            while (drop?.isValid !== false && Date.now() < deadline) {
                if (itemName && inventoryCount(this.bot, itemName) > beforeCount) return true;
                const distance = drop.position.distanceTo(this.bot.entity.position);
                if (distance <= 0.9) break;

                await Promise.race([
                    this.bot.lookAt(drop.position.offset(0, 0.2, 0), true),
                    sleep(200)
                ]);
                this.bot.setControlState('forward', true);
                this.bot.setControlState('sprint', distance > 2);
                this.bot.setControlState('jump', Math.abs(drop.position.y - this.bot.entity.position.y) > 1);
                await sleep(180);
            }
        } finally {
            this.bot.setControlState('forward', false);
            this.bot.setControlState('sprint', false);
            this.bot.setControlState('jump', false);
        }
        if (!itemName) {
            await sleep(500);
            return true;
        }
        return this.waitForInventoryIncrease(itemName, beforeCount, 800);
    }

    async recoverItems(action = {}) {
        const death = this.memory?.data.deathPosition;
        if (!death) return;
        if (!this.isDeathRecoveryWorthwhile(death)) {
            this.memory?.setFlag('deathPosition', null);
            console.log('Olum noktasinda kayda deger esya yok; kurtarma atlandi.');
            return;
        }

        const target = new Vec3(death.x, death.y, death.z);
        console.log(
            `Olum esyalari kurtariliyor: ${target.toString()} ` +
            `sebep=${action.reason || 'olum sonrasi toparlanma'}`
        );

        this.bot.pathfinder.setMovements(this.createMovements(true, true));
        await this.goto(new goals.GoalNear(
            target.x,
            target.y,
            target.z,
            4
        ), 90000);

        let collectedAny = false;
        for (let attempt = 0; attempt < 8; attempt++) {
            const collected = await this.collectNearbyDrops(null, 16);
            collectedAny = collectedAny || collected;
            await sleep(700);
        }

        this.memory?.setFlag('deathPosition', null);
        console.log(
            collectedAny
                ? 'Olum noktasindaki dusen esyalar toplandi.'
                : 'Olum noktasinda dusen esya gorulmedi; hedef temizlendi.'
        );
    }

    isDeathRecoveryWorthwhile(death) {
        if (!death || (death.itemCount || 0) <= 0) return false;
        if (death.damageSource === 'drowned') return false;
        const items = Array.isArray(death.items) ? death.items : [];
        if (items.length === 0) return (death.itemCount || 0) >= 16;

        const valuable = /(_pickaxe|_axe|_sword|_helmet|_chestplate|_leggings|_boots|diamond|iron|bucket|bed|furnace|crafting_table|torch|cooked_|porkchop|beef|mutton|bread|apple)/;
        return items.some(item => valuable.test(item.name)) ||
            (death.itemCount || 0) >= 16;
    }

    countFarmCropsRadius(center, radius) {
        let count = 0;
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (dx === 0 && dz === 0) continue;
                if (this.bot.blockAt(center.offset(dx, 0, dz))?.name === 'wheat') {
                    count++;
                }
            }
        }
        return count;
    }

    async plantGardenSpots(spots, requireAll = true) {
        let planted = 0;
        for (const spot of spots) {
            let current = this.bot.blockAt(spot);
            if (['oak_sapling', 'oak_log', 'oak_wood'].includes(current?.name)) {
                planted++;
                continue;
            }

            await this.goto(
                new goals.GoalNear(spot.x, spot.y, spot.z, 2),
                30000
            );
            current = this.bot.blockAt(spot);
            if (current?.name !== 'air') {
                if (!this.bot.canDigBlock(current)) {
                    if (requireAll) {
                        throw new Error(`Fidan noktasi temizlenemiyor: ${spot}`);
                    }
                    continue;
                }
                await this.equipBestTool(current);
                await this.bot.dig(current);
            }

            let floor = this.bot.blockAt(spot.offset(0, -1, 0));
            if (!['dirt', 'grass_block'].includes(floor?.name)) {
                const dirt = this.bot.inventory.items().find(
                    item => item.name === 'dirt' || item.name === 'grass_block'
                );
                if (!dirt) {
                    if (requireAll) throw new Error('Fidan zemini icin toprak yok');
                    continue;
                }
                await this.ensureProjectBlock(
                    spot.offset(0, -1, 0),
                    dirt.name,
                    true
                );
                floor = this.bot.blockAt(spot.offset(0, -1, 0));
            }

            const sapling = this.bot.inventory.items()
                .find(item => item.name === 'oak_sapling');
            if (!sapling) {
                if (requireAll) throw new Error('Bahce icin mese fidani bitti');
                continue;
            }
            await this.bot.equip(sapling, 'hand');
            await this.bot.placeBlock(floor, new Vec3(0, 1, 0));
            await sleep(250);
            if (this.bot.blockAt(spot)?.name === 'oak_sapling') planted++;
        }

        if (requireAll && planted < spots.length) {
            throw new Error(`Agac bahcesi eksik dikildi: ${planted}/${spots.length}`);
        }
        return planted;
    }

    async equipDiamondArmor() {
        const slots = {
            diamond_helmet: 'head',
            diamond_chestplate: 'torso',
            diamond_leggings: 'legs',
            diamond_boots: 'feet'
        };
        for (const [name, slot] of Object.entries(slots)) {
            const item = this.bot.inventory.items()
                .find(entry => entry.name === name);
            if (!item) throw new Error(`${name} envanterde yok`);
            await this.bot.equip(item, slot);
        }
        this.memory?.setFlag('diamondArmorEquipped', true);
        console.log('Tam elmas zirh kusanildi.');
    }

    async buildNetherPortal() {
        const base = this.memory?.data.base || this.memory?.data.shelter;
        if (!base) throw new Error('Nether portali icin ana us yok');
        const flintAndSteel = this.bot.inventory.items()
            .find(item => item.name === 'flint_and_steel');
        if (!flintAndSteel) throw new Error('Portal yakmak icin flint_and_steel yok');

        const origin = new Vec3(base.x + 10, base.y, base.z + 4);
        await this.goto(new goals.GoalNear(origin.x, origin.y, origin.z, 4), 30000);

        const interior = [];
        for (let x = 1; x <= 2; x++) {
            for (let y = 1; y <= 3; y++) {
                interior.push(origin.offset(x, y, 0));
            }
        }
        for (const target of interior) {
            await this.clearPortalSpace(target);
        }

        const frame = [];
        for (let y = 1; y <= 3; y++) {
            frame.push(origin.offset(0, y, 0));
            frame.push(origin.offset(3, y, 0));
        }
        for (let x = 1; x <= 2; x++) {
            frame.push(origin.offset(x, 0, 0));
            frame.push(origin.offset(x, 4, 0));
        }

        for (const target of frame) {
            await this.ensureProjectBlock(target, 'obsidian', true);
        }

        await this.bot.equip(flintAndSteel, 'hand');
        const ignitionBlock = this.bot.blockAt(origin.offset(1, 0, 0));
        if (!ignitionBlock) throw new Error('Portal yakma blogu bulunamadi');
        await this.gotoProjectWorkPosition(origin.offset(1, 1, 0));
        await this.useItemOnBlock(ignitionBlock, new Vec3(0, 1, 0));
        await sleep(2000);

        const portalBlocks = interior
            .map(position => this.bot.blockAt(position))
            .filter(block => block?.name === 'nether_portal');
        if (portalBlocks.length === 0) {
            throw new Error('Nether portali alev aldi ama portal blogu olusmadi');
        }

        this.memory?.setProject('netherPortal', origin, {
            frame: '10_obsidian',
            lit: true
        });
    }

    async clearPortalSpace(target) {
        const current = this.bot.blockAt(target);
        if (['air', 'cave_air', 'void_air', 'fire', 'nether_portal'].includes(current?.name)) {
            return;
        }
        if (!current || !this.bot.canDigBlock(current)) {
            throw new Error(`Portal ici temizlenemiyor: ${target.toString()}`);
        }
        await this.gotoProjectWorkPosition(target);
        await this.equipBestTool(current);
        await this.bot.dig(current);
        await sleep(150);
    }

    async enterNether() {
        if (this.isInNether()) {
            this.memory?.setFlag('enteredNether', true);
            console.log('Ajan Nether boyutunda.');
            return;
        }

        const portalId = this.bot.registry.blocksByName.nether_portal?.id;
        const portal = portalId
            ? this.bot.findBlock({ matching: portalId, maxDistance: 64 })
            : null;
        if (!portal) {
            if (!this.memory?.data.netherPortal) {
                return this.buildNetherPortal();
            }
            throw new Error('Yakinda aktif Nether portali yok');
        }

        await this.goto(new goals.GoalNear(
            portal.position.x,
            portal.position.y,
            portal.position.z,
            1
        ), 30000);
        await this.bot.lookAt(portal.position.offset(0.5, 0.5, 0.5), true);
        this.bot.setControlState('forward', true);

        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
            if (this.isInNether()) {
                this.bot.clearControlStates();
                this.memory?.setFlag('enteredNether', true);
                console.log('Nether boyutuna gecildi.');
                return;
            }
            await sleep(500);
        }
        this.bot.clearControlStates();
        throw new Error('Nether gecisi zaman asimina ugradi');
    }

    isInNether() {
        const dimension = String(this.bot.game?.dimension || '').toLowerCase();
        return dimension.includes('nether');
    }

    shouldReturnToBase(action) {
        const base = this.memory?.data.base || this.memory?.data.shelter;
        if (!base) return false;

        const baseActions = new Set([
            'upgrade_base',
            'build_farm',
            'build_house',
            'organize_storage',
            'prepare_loadout',
            'expand_farm',
            'establish_tree_garden',
            'maintain_tree_garden',
            'establish_deep_mine',
            'place_workstation',
            'smelt',
            'equip_iron_armor',
            'equip_diamond_armor',
            'build_nether_portal',
            'enter_nether'
        ]);
        if (!baseActions.has(action.type)) return false;

        if (this.bot.entity.position.y <= base.y - 4) return false;

        const projectRadius = new Set([
            'build_house',
            'organize_storage',
            'prepare_loadout',
            'expand_farm',
            'establish_tree_garden',
            'maintain_tree_garden'
        ]).has(action.type)
            ? 28
            : 10;

        return this.bot.entity.position.distanceTo(
            new Vec3(base.x, base.y, base.z)
        ) > projectRadius;
    }

    findMineEntrance(base) {
        const offsets = [
            [8, 0], [0, 8], [-8, 0], [0, -8],
            [6, 6], [-6, 6], [6, -6], [-6, -6]
        ];
        for (const [dx, dz] of offsets) {
            const candidate = base.offset(dx, 0, dz);
            const feet = this.bot.blockAt(candidate);
            const head = this.bot.blockAt(candidate.offset(0, 1, 0));
            const floor = this.bot.blockAt(candidate.offset(0, -1, 0));
            if (
                feet?.name === 'air' &&
                head?.name === 'air' &&
                floor?.boundingBox === 'block'
            ) {
                return candidate;
            }
        }
        return this.bot.entity.position.floored();
    }

    async maybePlaceTorch(force = false) {
        if (!force && this.blocksSinceTorch < 4) return;
        const torch = this.bot.inventory.items()
            .find(item => item.name === 'torch');
        if (!torch) return;

        const origin = this.bot.entity.position.floored();
        const feet = this.bot.blockAt(origin);
        const floor = this.bot.blockAt(origin.offset(0, -1, 0));
        const lowLight = (feet?.light ?? 15) < 8;
        if (!force && !lowLight) return;
        if (feet?.name !== 'air' || floor?.boundingBox !== 'block') return;

        try {
            await this.bot.equip(torch, 'hand');
            await this.bot.placeBlock(floor, new Vec3(0, 1, 0));
            this.blocksSinceTorch = 0;
            console.log(`Mesale yerlestirildi: ${origin.toString()}`);
        } catch (error) {
            console.log('Mesale yerlestirilemedi:', error.message);
        }
    }

    findNearbyBlock(name, maxDistance) {
        const id = this.bot.registry.blocksByName[name]?.id;
        if (id == null) return null;
        return this.bot.findBlock({ matching: id, maxDistance });
    }

    findWaterSources(maxDistance) {
        const waterId = this.bot.registry.blocksByName.water?.id;
        if (waterId == null) return [];

        return this.bot.findBlocks({
            matching: waterId,
            maxDistance,
            count: 256
        })
            .map(position => this.bot.blockAt(position))
            .filter(block => {
                const level = block?.getProperties?.().level;
                return block?.name === 'water' &&
                    (level == null || Number(level) === 0);
            })
            .sort((a, b) =>
                a.position.distanceTo(this.bot.entity.position) -
                b.position.distanceTo(this.bot.entity.position)
            );
    }

    nearestKnownWaterSource() {
        const sources = this.memory?.data.waterSources || [];
        return sources
            .map(source => new Vec3(source.x, source.y, source.z))
            .sort((a, b) =>
                a.distanceTo(this.bot.entity.position) -
                b.distanceTo(this.bot.entity.position)
            )[0] || null;
    }

    async moveToward(destination, stepDistance, timeoutMs) {
        const current = this.bot.entity.position;
        const dx = destination.x - current.x;
        const dz = destination.z - current.z;
        const horizontal = Math.hypot(dx, dz);
        if (horizontal < 1) return;

        const step = Math.min(stepDistance, horizontal);
        const x = Math.floor(current.x + dx / horizontal * step);
        const z = Math.floor(current.z + dz / horizontal * step);
        console.log(`Ara rota hedefi: (${x}, ${z})`);
        await this.goto(new goals.GoalXZ(x, z), timeoutMs);
    }

    async descendFromHighSpot(reason = 'Yuksek noktadan in') {
        const current = this.bot.entity.position.floored();
        const target = this.findLowerStandingSpot(current);
        if (!target) return false;

        console.log(`${reason}; guvenli inis noktasi: ${target.toString()}`);
        this.bot.pathfinder.setMovements(this.createMovements(true, true));
        try {
            await this.goto(new goals.GoalBlock(target.x, target.y, target.z), 30000);
            return true;
        } catch (error) {
            console.log(`Guvenli inis basarisiz: ${error.message}`);
            return await this.carveDescentStaircase(target.y);
        } finally {
            this.bot.pathfinder.setMovements(this.createMovements(false));
        }
    }

    async carveDescentStaircase(targetY) {
        const startY = Math.floor(this.bot.entity.position.y);
        const desiredY = Math.max(1, targetY ?? startY - 8);
        const anchor = new Vec3(
            Math.floor(this.bot.entity.position.x),
            desiredY,
            Math.floor(this.bot.entity.position.z)
        );

        console.log(`Guvenli inis icin asagi merdiven deneniyor: hedefY=${desiredY}`);
        for (let step = 0; step < 16; step++) {
            this.assertActionActive();
            this.abortIfImmediateThreat('Inis merdiveni');
            const current = this.bot.entity.position.floored();
            if (current.y <= desiredY + 1) return true;

            const directions = this.orderedEscapeDirections(current, anchor);
            let moved = false;
            for (const direction of directions) {
                const standAt = current.offset(direction.x, -1, direction.z);
                try {
                    const prepared = await this.prepareDescentStep(standAt);
                    if (!prepared) continue;
                    this.bot.pathfinder.setMovements(this.createMovements(true, true));
                    await this.goto(
                        new goals.GoalBlock(standAt.x, standAt.y, standAt.z),
                        8000
                    );
                    moved = true;
                    break;
                } catch (error) {
                    this.stop();
                    console.log(
                        `Inis merdiveni yonu denenemedi ${direction.x},${direction.z}: ${error.message}`
                    );
                } finally {
                    this.bot.pathfinder.setMovements(this.createMovements(false));
                }
            }

            if (!moved) break;
        }

        const lowered = startY - Math.floor(this.bot.entity.position.y);
        if (lowered > 0) {
            console.log(`Guvenli inis ${lowered} blok alcakliga indi.`);
            return true;
        }
        return false;
    }

    async prepareDescentStep(standAt) {
        const floor = this.bot.blockAt(standAt.offset(0, -1, 0));
        if (
            !floor ||
            floor.boundingBox !== 'block' ||
            ['water', 'lava', 'cactus', 'fire', 'magma_block'].includes(floor.name)
        ) {
            return false;
        }

        await this.clearDescentSpace(standAt);
        await this.clearDescentSpace(standAt.offset(0, 1, 0));

        const feet = this.bot.blockAt(standAt);
        const head = this.bot.blockAt(standAt.offset(0, 1, 0));
        return feet?.boundingBox !== 'block' && head?.boundingBox !== 'block';
    }

    async clearDescentSpace(position) {
        this.abortIfImmediateThreat('Inis kazisi');
        const block = this.bot.blockAt(position);
        if (!block || block.boundingBox !== 'block') return;
        if (!block.diggable || !this.bot.canDigBlock(block)) {
            throw new Error(`Inis yolu kazilamiyor: ${block?.name}`);
        }
        await this.equipBestTool(block);
        await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        await this.bot.dig(block);
        await sleep(150);
    }

    abortIfImmediateThreat(context, maxDistance = 5) {
        const threat = this.nearestImmediateHostile(maxDistance);
        if (!threat) return;
        throw new Error(
            `${context} yakin tehdit nedeniyle kesildi: ${entityName(threat)}`
        );
    }

    shouldDescendFromHighSpot() {
        const current = this.bot.entity.position;
        const anchorY =
            this.surfaceAnchor?.y ??
            this.memory?.data.base?.y ??
            this.memory?.data.shelter?.y;
        const floor = this.bot.blockAt(current.floored().offset(0, -1, 0));

        return this.isUnstableStandingFloor(floor) ||
            (anchorY != null && current.y > anchorY + 6);
    }

    findLowerStandingSpot(origin = this.bot.entity.position.floored()) {
        const candidates = [];
        const minY = Math.max(1, origin.y - 32);
        for (let radius = 1; radius <= 18; radius++) {
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
                    for (let y = origin.y - 1; y >= minY; y--) {
                        const position = new Vec3(origin.x + dx, y, origin.z + dz);
                        const feet = this.bot.blockAt(position);
                        const head = this.bot.blockAt(position.offset(0, 1, 0));
                        const floor = this.bot.blockAt(position.offset(0, -1, 0));
                        if (
                            ['air', 'cave_air', 'void_air'].includes(feet?.name) &&
                            ['air', 'cave_air', 'void_air'].includes(head?.name) &&
                            floor?.boundingBox === 'block' &&
                            !this.isUnstableStandingFloor(floor)
                        ) {
                            candidates.push(position);
                            break;
                        }
                    }
                }
            }
            if (candidates.length > 0) break;
        }

        return candidates
            .sort((a, b) =>
                a.distanceTo(this.bot.entity.position) -
                b.distanceTo(this.bot.entity.position)
            )[0] || null;
    }

    isUnstableStandingFloor(block) {
        return !block ||
            block.name.endsWith('_leaves') ||
            block.name.endsWith('_log') ||
            block.name.endsWith('_wood') ||
            ['water', 'lava', 'cactus', 'fire', 'magma_block'].includes(block.name);
    }

    interactionFace(delta) {
        const axes = [
            { value: Math.abs(delta.y), face: new Vec3(0, Math.sign(delta.y), 0) },
            { value: Math.abs(delta.x), face: new Vec3(Math.sign(delta.x), 0, 0) },
            { value: Math.abs(delta.z), face: new Vec3(0, 0, Math.sign(delta.z)) }
        ];
        return axes
            .filter(axis => axis.value > 0.01)
            .sort((a, b) => b.value - a.value)[0]?.face ||
            new Vec3(0, 1, 0);
    }

    async placeInventoryBlock(item) {
        const placement = this.findPlacement();
        const targetPlacement = placement || await this.createPlacementNook();
        if (!targetPlacement) throw new Error(`${item.name} icin bos zemin yok`);
        await this.bot.equip(item, 'hand');
        await this.bot.placeBlock(targetPlacement.reference, new Vec3(0, 1, 0));
        await sleep(500);
        const block = this.bot.blockAt(targetPlacement.target);
        if (!block || block.name !== item.name) {
            throw new Error(`${item.name} yerlestirilemedi`);
        }
        return block;
    }

    async placeWorkstationNearBase(item) {
        const base = this.memory?.data.base || this.memory?.data.shelter;
        if (base) {
            const center = new Vec3(base.x, base.y, base.z);
            const offsets = [
                [2, 0], [-2, 0], [0, 2], [0, -2],
                [3, 0], [-3, 0], [0, 3], [0, -3],
                [2, 2], [-2, 2], [2, -2], [-2, -2]
            ];

            for (const [dx, dz] of offsets) {
                const target = center.offset(dx, 0, dz);
                const current = this.bot.blockAt(target);
                const floor = this.bot.blockAt(target.offset(0, -1, 0));
                if (current?.name === item.name) return current;
                if (current?.name !== 'air' || floor?.boundingBox !== 'block') {
                    continue;
                }

                await this.gotoProjectWorkPosition(target);
                await this.bot.equip(item, 'hand');
                try {
                    await this.bot.placeBlock(floor, new Vec3(0, 1, 0));
                } catch (error) {
                    await this.useItemOnBlock(floor, new Vec3(0, 1, 0));
                }
                await sleep(500);
                const placed = this.bot.blockAt(target);
                if (placed?.name === item.name) return placed;
            }
        }

        return this.placeInventoryBlock(item);
    }

    findSmeltingFuel() {
        const priority = [
            'coal',
            'charcoal',
            'oak_planks',
            'spruce_planks',
            'birch_planks'
        ];
        for (const name of priority) {
            const item = this.bot.inventory.items()
                .find(entry => entry.name === name);
            if (item) return item;
        }
        return null;
    }

    findFarmCenter(base) {
        for (let radius = 5; radius <= 14; radius++) {
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
                    for (let dy = -2; dy <= 4; dy++) {
                        const center = base.offset(dx, dy, dz);
                        let valid = true;
                        for (let x = -1; x <= 1 && valid; x++) {
                            for (let z = -1; z <= 1; z++) {
                                const feet = this.bot.blockAt(center.offset(x, 0, z));
                                const head = this.bot.blockAt(center.offset(x, 1, z));
                                const floor = this.bot.blockAt(center.offset(x, -1, z));
                                if (
                                    !this.isFarmAir(feet) ||
                                    !this.isFarmAir(head) ||
                                    !this.isFarmSoilBase(floor)
                                ) {
                                    valid = false;
                                    break;
                                }
                            }
                        }
                        if (valid) return center;
                    }
                }
            }
        }
        return this.findBuildableFarmCenter(base);
    }

    findBuildableFarmCenter(base) {
        const hasDirt = this.bot.inventory.items()
            .some(item => item.name === 'dirt' || item.name === 'grass_block');
        let best = null;

        for (let radius = 5; radius <= 18; radius++) {
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
                    for (let dy = -2; dy <= 5; dy++) {
                        const center = base.offset(dx, dy, dz);
                        const score = this.farmBuildScore(center, hasDirt);
                        if (score == null) continue;
                        if (!best || score < best.score) {
                            best = { center, score };
                        }
                    }
                }
            }
            if (best) return best.center;
        }

        return null;
    }

    farmBuildScore(center, hasDirt) {
        let score = 0;
        for (let x = -1; x <= 1; x++) {
            for (let z = -1; z <= 1; z++) {
                const feet = this.bot.blockAt(center.offset(x, 0, z));
                const head = this.bot.blockAt(center.offset(x, 1, z));
                const floor = this.bot.blockAt(center.offset(x, -1, z));

                for (const clearBlock of [feet, head]) {
                    if (this.isFarmAir(clearBlock)) continue;
                    if (!clearBlock?.diggable || !this.bot.canDigBlock(clearBlock)) {
                        return null;
                    }
                    score += clearBlock.boundingBox === 'block' ? 4 : 1;
                }

                if (this.isFarmSoilBase(floor)) continue;
                if (floor?.name === 'air' || floor?.name === 'water') {
                    if (!hasDirt) return null;
                    score += 3;
                    continue;
                }
                if (!floor?.diggable || !this.bot.canDigBlock(floor)) return null;
                if (!hasDirt) return null;
                score += floor.boundingBox === 'block' ? 6 : 2;
            }
        }
        return score;
    }

    isFarmAir(block) {
        return [
            'air',
            'cave_air',
            'void_air',
            'short_grass',
            'tall_grass',
            'fern',
            'large_fern',
            'dead_bush',
            'snow'
        ].includes(block?.name);
    }

    isFarmSoilBase(block) {
        return [
            'dirt',
            'grass_block',
            'coarse_dirt',
            'podzol',
            'rooted_dirt',
            'farmland'
        ].includes(block?.name);
    }

    findExistingFarmCenter(base) {
        const waterId = this.bot.registry.blocksByName.water?.id;
        if (waterId == null) return null;
        return this.bot.findBlocks({
            matching: waterId,
            maxDistance: 20,
            count: 64,
            point: base
        })
            .map(position => position.offset(0, 1, 0))
            .find(center => this.countFarmCrops(center) > 0) || null;
    }

    findFarmWaterSource(center, radius = 3) {
        const waterId = this.bot.registry.blocksByName.water?.id;
        if (waterId == null) return null;
        const candidates = [];
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                for (let dy = -2; dy <= 0; dy++) {
                    const block = this.bot.blockAt(center.offset(dx, dy, dz));
                    const level = block?.getProperties?.().level;
                    if (
                        block?.type === waterId &&
                        (level == null || Number(level) === 0)
                    ) {
                        candidates.push(block);
                    }
                }
            }
        }
        return candidates.sort((a, b) =>
            a.position.distanceTo(center) -
            b.position.distanceTo(center)
        )[0] || null;
    }

    async placeFarmSoil(position) {
        const dirt = this.bot.inventory.items()
            .find(item => item.name === 'dirt' || item.name === 'grass_block');
        if (!dirt) throw new Error('Yukseltilmis tarla icin toprak yok');

        let support = null;
        for (let depth = 1; depth <= 4; depth++) {
            const candidate = this.bot.blockAt(position.offset(0, -depth, 0));
            if (candidate?.boundingBox === 'block') {
                support = candidate;
                break;
            }
        }
        if (!support) {
            throw new Error(`Tarla topragi icin taban yok: ${position}`);
        }

        for (let y = support.position.y + 1; y <= position.y; y++) {
            const target = new Vec3(position.x, y, position.z);
            let placed = this.bot.blockAt(target);
            if (placed?.boundingBox === 'block') {
                support = placed;
                continue;
            }
            const currentDirt = this.bot.inventory.items()
                .find(item => item.name === 'dirt' || item.name === 'grass_block');
            if (!currentDirt) throw new Error('Tarla destek topragi bitti');
            await this.bot.equip(currentDirt, 'hand');
            try {
                await this.bot.placeBlock(support, new Vec3(0, 1, 0));
            } catch (error) {
                placed = this.bot.blockAt(target);
                if (!['dirt', 'grass_block'].includes(placed?.name)) {
                    await this.useItemOnBlock(support, new Vec3(0, 1, 0));
                    await sleep(500);
                    placed = this.bot.blockAt(target);
                    if (!['dirt', 'grass_block'].includes(placed?.name)) {
                        throw error;
                    }
                }
            }
            await sleep(200);
            support = this.bot.blockAt(target);
        }

        return this.bot.blockAt(position);
    }

    async useItemOnBlock(block, face) {
        await this.bot.lookAt(
            block.position.offset(
                0.5 + face.x * 0.5,
                0.5 + face.y * 0.5,
                0.5 + face.z * 0.5
            ),
            true
        );
        const direction = face.y < 0 ? 0
            : face.y > 0 ? 1
                : face.z < 0 ? 2
                    : face.z > 0 ? 3
                        : face.x < 0 ? 4 : 5;
        this.bot._client.write('block_place', {
            location: block.position,
            direction,
            hand: 0,
            cursorX: 0.5 + face.x * 0.5,
            cursorY: 0.5 + face.y * 0.5,
            cursorZ: 0.5 + face.z * 0.5,
            insideBlock: false,
            sequence: this.interactionSequence++,
            worldBorderHit: false
        });
        this.bot.swingArm('right');
    }

    countFarmCrops(center) {
        let count = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (dx === 0 && dz === 0) continue;
                if (this.bot.blockAt(center.offset(dx, 0, dz))?.name === 'wheat') {
                    count++;
                }
            }
        }
        return count;
    }

    async placeItemAt(target, itemName) {
        const existing = this.bot.blockAt(target);
        if (existing?.name === itemName) return;
        if (existing?.name !== 'air') return;

        const item = this.bot.inventory.items()
            .find(entry => entry.name === itemName);
        if (!item) throw new Error(`${itemName} envanterde bitti`);

        const references = [
            { offset: [0, -1, 0], face: new Vec3(0, 1, 0) },
            { offset: [-1, 0, 0], face: new Vec3(1, 0, 0) },
            { offset: [1, 0, 0], face: new Vec3(-1, 0, 0) },
            { offset: [0, 0, -1], face: new Vec3(0, 0, 1) },
            { offset: [0, 0, 1], face: new Vec3(0, 0, -1) }
        ]
            .map(candidate => ({
                block: this.bot.blockAt(target.offset(...candidate.offset)),
                face: candidate.face
            }))
            .find(candidate => candidate.block?.boundingBox === 'block');
        if (!references) {
            throw new Error(`${itemName} icin referans yok: ${target.toString()}`);
        }

        if (this.bot.entity.position.distanceTo(target) > 4.5) {
            await this.goto(new goals.GoalNear(
                target.x,
                target.y,
                target.z,
                3
            ), 12000);
        }
        await this.bot.equip(item, 'hand');
        try {
            await this.bot.placeBlock(references.block, references.face);
        } catch (error) {
            await sleep(250);
            if (this.bot.blockAt(target)?.name !== itemName) {
                throw error;
            }
        }
        await sleep(150);
    }

    findFlatShelterCenter() {
        const origins = [
            this.bot.entity.position.floored(),
            this.surfaceAnchor?.floored()
        ]
            .filter(Boolean)
            .filter((origin, index, list) =>
                list.findIndex(other =>
                    other.x === origin.x &&
                    other.y === origin.y &&
                    other.z === origin.z
                ) === index
            );

        for (const origin of origins) {
            for (let radius = 0; radius <= 10; radius++) {
                for (let dy = -1; dy <= 3; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        for (let dz = -radius; dz <= radius; dz++) {
                            const center = origin.offset(dx, dy, dz);
                            if (this.isUsableShelterCenter(center)) return center;
                        }
                    }
                }
            }
        }

        return null;
    }

    isUsableShelterCenter(center) {
        if (!this.hasOpenSkyAt(center)) return false;

        for (let x = -1; x <= 1; x++) {
            for (let z = -1; z <= 1; z++) {
                const feet = this.bot.blockAt(center.offset(x, 0, z));
                const head = this.bot.blockAt(center.offset(x, 1, z));
                const roof = this.bot.blockAt(center.offset(x, 2, z));
                const floor = this.bot.blockAt(center.offset(x, -1, z));
                if (
                    !this.isOpenShelterSpace(feet) ||
                    !this.isOpenShelterSpace(head) ||
                    !this.isOpenShelterSpace(roof) ||
                    floor?.boundingBox !== 'block'
                ) {
                    return false;
                }
            }
        }
        return true;
    }

    hasOpenSkyAt(center) {
        for (let dy = 3; dy <= 16; dy++) {
            const block = this.bot.blockAt(center.offset(0, dy, 0));
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

    async placeAt(target) {
        let existing = this.bot.blockAt(target);
        if (existing?.name === 'cobblestone') return;
        if (existing?.name !== 'air') {
            if (!existing?.diggable || existing.boundingBox === 'block') {
                throw new Error(`Barinak hedefi dolu: ${target.toString()}`);
            }
            if (this.bot.entity.position.distanceTo(existing.position) > 4.5) {
                await this.gotoProjectWorkPosition(existing.position);
            }
            await this.bot.lookAt(existing.position.offset(0.5, 0.5, 0.5), true);
            await this.equipBestTool(existing);
            await this.bot.dig(existing);
            await sleep(150);
            existing = this.bot.blockAt(target);
            if (existing?.name !== 'air') {
                throw new Error(`Barinak hedefi temizlenemedi: ${target.toString()}`);
            }
        }

        const references = [
            { offset: [0, -1, 0], face: new Vec3(0, 1, 0) },
            { offset: [-1, 0, 0], face: new Vec3(1, 0, 0) },
            { offset: [1, 0, 0], face: new Vec3(-1, 0, 0) },
            { offset: [0, 0, -1], face: new Vec3(0, 0, 1) },
            { offset: [0, 0, 1], face: new Vec3(0, 0, -1) }
        ];
        const reference = references
            .map(candidate => ({
                block: this.bot.blockAt(target.offset(...candidate.offset)),
                face: candidate.face
            }))
            .find(candidate => candidate.block?.boundingBox === 'block');

        if (!reference) {
            throw new Error(`Blok yerlestirme referansi yok: ${target.toString()}`);
        }

        if (this.bot.entity.position.distanceTo(target) > 4.5) {
            await this.gotoProjectWorkPosition(target);
        }
        await this.bot.lookAt(
            target.offset(0.5, 0.5, 0.5),
            true
        );
        try {
            await this.bot.placeBlock(reference.block, reference.face);
        } catch (error) {
            await this.useItemOnBlock(reference.block, reference.face);
        }
        await sleep(120);
        const placed = this.bot.blockAt(target);
        if (placed?.name !== 'cobblestone') {
            throw new Error(`Cobblestone yerlestirilemedi: ${target.toString()}`);
        }
    }

    isOpenShelterSpace(block) {
        return [
            'air',
            'cave_air',
            'void_air',
            'short_grass',
            'tall_grass',
            'fern',
            'large_fern',
            'dead_bush'
        ].includes(block?.name);
    }

    keepInInventory(item) {
        if (this.bot.registry.foodsByName[item.name]) return Math.min(item.count, 16);
        if ([
            'diamond',
            'iron_ingot',
            'raw_iron',
            'oak_sapling',
            'wheat_seeds'
        ].includes(item.name)) return item.count;
        if (
            item.name.endsWith('_pickaxe') ||
            item.name.endsWith('_axe') ||
            item.name.endsWith('_shovel') ||
            item.name.endsWith('_sword') ||
            item.name.endsWith('_hoe') ||
            item.name.endsWith('_helmet') ||
            item.name.endsWith('_chestplate') ||
            item.name.endsWith('_leggings') ||
            item.name.endsWith('_boots')
        ) return item.count;
        if (item.name === 'torch' || item.name === 'stick') {
            return Math.min(item.count, 16);
        }
        if (
            item.name === 'cobblestone' ||
            item.name.endsWith('_planks') ||
            item.name === 'dirt'
        ) return Math.min(item.count, 32);
        return 0;
    }

    keepForLoadout(item, context = 'general') {
        const needs = this.loadoutNeeds(context);
        const directNeed = needs.find(need => need.name === item.name);
        if (directNeed) return Math.min(item.count, directNeed.count);

        if (this.bot.registry.foodsByName[item.name]) return Math.min(item.count, 16);
        if (this.isBestHeldTool(item.name)) return 1;
        if (item.name.endsWith('_helmet') ||
            item.name.endsWith('_chestplate') ||
            item.name.endsWith('_leggings') ||
            item.name.endsWith('_boots')) return 1;
        if (['water_bucket', 'bucket', 'flint_and_steel'].includes(item.name)) return 1;
        if (item.name === 'torch') return Math.min(item.count, context === 'mining' ? 32 : 16);
        if (item.name === 'cobblestone' || item.name === 'dirt') {
            return Math.min(item.count, context === 'building' ? 64 : 24);
        }
        if (item.name.endsWith('_planks') || item.name.endsWith('_log')) {
            return Math.min(item.count, context === 'building' ? 64 : 16);
        }
        if (item.name === 'stick') return Math.min(item.count, 16);
        return 0;
    }

    loadoutNeeds(context = 'general') {
        const needs = [
            { name: 'torch', count: context === 'mining' ? 32 : 16 },
            { name: 'cobblestone', count: context === 'building' ? 64 : 24 },
            { name: 'stick', count: 8 }
        ];

        const bestPickaxe = this.bestInventoryName('_pickaxe');
        const bestAxe = this.bestInventoryName('_axe');
        const bestSword = this.bestInventoryName('_sword');
        if (bestPickaxe) needs.push({ name: bestPickaxe, count: 1 });
        if (bestAxe) needs.push({ name: bestAxe, count: 1 });
        if (bestSword) needs.push({ name: bestSword, count: 1 });

        const food = this.bestInventoryFoodName();
        if (food) needs.push({ name: food, count: 16 });

        return needs;
    }

    bestInventoryName(suffix) {
        return this.bot.inventory.items()
            .filter(item => item.name.endsWith(suffix))
            .sort((a, b) => this.toolTier(b.name) - this.toolTier(a.name))[0]?.name ||
            null;
    }

    bestInventoryFoodName() {
        return this.bot.inventory.items()
            .map(item => ({
                name: item.name,
                food: this.bot.registry.foodsByName[item.name]
            }))
            .filter(entry => entry.food)
            .sort((a, b) => b.food.effectiveQuality - a.food.effectiveQuality)[0]?.name ||
            null;
    }

    foodInventoryCount() {
        return safeFoodInventoryCount(this.bot);
    }

    isBestHeldTool(name) {
        if (!['_pickaxe', '_axe', '_sword', '_shovel', '_hoe'].some(suffix => name.endsWith(suffix))) {
            return false;
        }
        const suffix = ['_pickaxe', '_axe', '_sword', '_shovel', '_hoe']
            .find(toolSuffix => name.endsWith(toolSuffix));
        return this.bestInventoryName(suffix) === name;
    }

    shouldReturnToSurface(action) {
        const needsSurfaceWood =
            (action.type === 'explore' && action.resource === 'herhangi_bir_odun') ||
            (action.type === 'mine' && this.isWoodBlock(action.block));
        const needsSurfaceFood =
            action.type === 'hunt_food' ||
            (
                action.type === 'explore' &&
                typeof action.resource === 'string' &&
                (
                    action.resource.includes('cow') ||
                    action.resource.includes('pig') ||
                    action.resource.includes('sheep') ||
                    action.resource.includes('rabbit') ||
                    action.resource.includes('cod') ||
                    action.resource.includes('salmon')
                )
            );

        const undergroundResources = new Set([
            'stone',
            'deepslate',
            'cobblestone',
            'coal',
            'raw_iron',
            'iron_ore',
            'diamond',
            'diamond_ore',
            'deepslate_diamond_ore'
        ]);
        const needsSurfaceExploration =
            action.type === 'explore' &&
            !undergroundResources.has(action.resource);

        const needsSurfaceProject = new Set([
            'build_shelter',
            'upgrade_base',
            'build_farm',
            'build_house',
            'organize_storage',
            'expand_farm',
            'establish_tree_garden',
            'maintain_tree_garden',
            'smelt',
            'equip_iron_armor',
            'equip_diamond_armor',
            'build_nether_portal',
            'enter_nether'
        ]).has(action.type);

        if (
            (
                needsSurfaceWood ||
                needsSurfaceFood ||
                needsSurfaceExploration ||
                needsSurfaceProject
            ) &&
            this.hasOpenSky()
        ) {
            return false;
        }

        const baseY =
            this.memory?.data.base?.y ??
            this.memory?.data.shelter?.y ??
            this.surfaceAnchor?.y;
        const referenceY = baseY == null ? null : Math.max(1, baseY);
        const surfaceThreshold = (needsSurfaceWood || needsSurfaceFood || needsSurfaceExploration)
            ? referenceY - 1
            : referenceY - 4;
        return (
            needsSurfaceWood ||
            needsSurfaceFood ||
            needsSurfaceExploration ||
            needsSurfaceProject
        ) &&
            referenceY != null &&
            this.bot.entity.position.y <= surfaceThreshold;
    }

    isWoodBlock(name) {
        return typeof name === 'string' && (
            name.endsWith('_log') ||
            name.endsWith('_wood') ||
            name.endsWith('_stem') ||
            name.endsWith('_hyphae') ||
            name === 'bamboo_block'
        );
    }

    primaryDropName(block) {
        const dropId = block?.drops?.[0];
        return dropId ? this.bot.registry.items[dropId]?.name : null;
    }

    async flee(action = {}) {
        if (this.bot.entity.isInWater) {
            console.log('Suda kacis yerine once kiyiya/yuzeye cikiliyor.');
            return this.swim(action);
        }

        if (this.isBelowSurfaceReference(1)) {
            return this.escapePit({
                ...action,
                reason: action.reason || 'Tehdit var ama bot cukurda; once yukari cik'
            });
        }

        this.stop();
        const awayVector = this.combinedThreatEscapeVector(action);
        if (awayVector) {
            await this.bot.lookAt(
                this.bot.entity.position.plus(awayVector).offset(0, 1, 0),
                true
            );
        } else {
            await this.bot.look(this.bot.entity.yaw + Math.PI, 0, true);
        }

        const threatDistance = Number(action.distance) || 0;
        const immediateThreat = threatDistance === 0 || threatDistance <= 8;
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', true);
        if (this.bot.health > 8 && immediateThreat) {
            this.bot.setControlState('jump', true);
        }
        if (['skeleton', 'stray', 'pillager'].includes(action.threat)) {
            const strafeLeft = this.interactionSequence++ % 2 === 0;
            this.bot.setControlState(strafeLeft ? 'left' : 'right', true);
        }
        const longEscape =
            this.bot.health <= 10 ||
            [
                'skeleton',
                'stray',
                'creeper',
                'slime',
                'magma_cube'
            ].includes(action.threat);
        const cautiousEscape = !immediateThreat && this.bot.health > 14;
        await sleep(cautiousEscape ? 3000 : longEscape ? 8000 : 5000);
        this.bot.clearControlStates();
    }

    async shortDisengage(durationMs = 2200) {
        if (this.bot.entity.isInWater) {
            return this.swim();
        }

        const awayVector = this.combinedThreatEscapeVector({});
        if (awayVector) {
            await this.bot.lookAt(
                this.bot.entity.position.plus(awayVector).offset(0, 1, 0),
                true
            );
        } else {
            await this.bot.look(this.bot.entity.yaw + Math.PI, 0, true);
        }

        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', true);
        this.bot.setControlState('jump', true);
        await sleep(durationMs);
        this.bot.clearControlStates();
    }

    isBelowSurfaceReference(margin = 1) {
        const referenceY =
            this.memory?.data.base?.y ??
            this.memory?.data.shelter?.y ??
            this.surfaceAnchor?.y ??
            this.memory?.data.surfaceAnchor?.y ??
            this.memory?.data.home?.y;
        if (referenceY == null) return false;
        if (this.bot.entity.position.y <= Math.max(1, referenceY) - margin) {
            return true;
        }
        return !this.hasOpenSky() &&
            this.bot.entity.position.y <= Math.max(1, referenceY) - 3;
    }

    combinedThreatEscapeVector(action = {}) {
        const directThreat = this.resolveTarget(action.targetId, action.threat);
        const threats = Object.values(this.bot.entities)
            .filter(entity => entity !== this.bot.entity)
            .filter(entity => {
                const name = entityName(entity);
                if (!name) return false;
                if (directThreat && entity.id === directThreat.id) return true;
                return [
                    'zombie', 'drowned', 'husk', 'skeleton', 'stray',
                    'zombie_villager', 'creeper', 'enderman', 'spider',
                    'cave_spider', 'slime', 'witch', 'phantom', 'pillager'
                ].includes(name) &&
                    entity.position.distanceTo(this.bot.entity.position) <= 24;
            });
        if (threats.length === 0) return null;

        const origin = this.bot.entity.position;
        let x = 0;
        let z = 0;
        for (const threat of threats) {
            const delta = origin.minus(threat.position);
            const distance = Math.max(1, Math.hypot(delta.x, delta.z));
            const weight = 1 / distance;
            x += delta.x / distance * weight;
            z += delta.z / distance * weight;
        }
        const length = Math.hypot(x, z);
        if (length < 0.01) {
            const yaw = this.bot.entity.yaw + Math.PI;
            return new Vec3(Math.cos(yaw) * 20, 0, Math.sin(yaw) * 20);
        }
        return new Vec3(x / length * 24, 0, z / length * 24);
    }

    async fight(action) {
        this.stop();
        const target = this.resolveTarget(action.targetId, action.threat);
        if (!target) throw new Error(`${action.threat || 'Tehdit'} kayboldu`);
        const targetName = entityName(target);
        if (targetName === 'creeper') {
            return this.flee(action);
        }

        const weapon = this.bestCombatWeapon();
        if (!weapon && !action.allowUnarmed) return this.flee(action);
        if (weapon) await this.bot.equip(weapon, 'hand');
        console.log(
            `Savas aleti: ${weapon?.name || 'bos el'}, hedef: ${targetName}`
        );

        const minimumFightHealth = action.standGround
            ? 0
            : targetName === 'slime'
                ? 8
                : 12;
        if (this.isMeleeCombatTarget(targetName)) {
            return this.fightMeleeManually(
                action,
                target,
                targetName,
                minimumFightHealth
            );
        }

        const deadline = Date.now() + 10000;
        while (
            target.isValid &&
            Date.now() < deadline &&
            this.bot.health > minimumFightHealth
        ) {
            this.assertActionActive();
            const distance = target.position.distanceTo(this.bot.entity.position);
            if (targetName === 'slime' && distance <= 4.2) {
                await this.bot.lookAt(target.position.offset(0, 0.8, 0), true);
                this.bot.attack(target);
                this.bot.setControlState('back', true);
                this.bot.setControlState('jump', true);
                await sleep(550);
                this.bot.clearControlStates();
                continue;
            }

            if (distance > 3.2) {
                try {
                    await this.goto(
                        new goals.GoalNear(
                            target.position.x,
                            target.position.y,
                            target.position.z,
                            2
                        ),
                        4000
                    );
                } catch {
                    if (target.isValid) return this.flee(action);
                }
            }

            if (!target.isValid) break;
            await this.bot.lookAt(target.position.offset(0, 1, 0), true);
            this.bot.attack(target);
            await sleep(650);
        }

        if (target.isValid && this.bot.health <= minimumFightHealth) {
            return this.flee(action);
        }
    }

    async fightMeleeManually(action, target, targetName, minimumFightHealth) {
        const deadline = Date.now() + 12000;
        while (
            target.isValid &&
            Date.now() < deadline &&
            this.bot.health > minimumFightHealth
        ) {
            this.assertActionActive();
            const distance = target.position.distanceTo(this.bot.entity.position);
            await Promise.race([
                this.bot.lookAt(target.position.offset(0, 1, 0), true),
                sleep(250)
            ]);

            if (distance > 3.2) {
                this.bot.setControlState('forward', true);
                this.bot.setControlState('sprint', true);
                if (distance > 4 || this.bot.entity.isInWater) {
                    this.bot.setControlState('jump', true);
                }
                await sleep(300);
                this.bot.clearControlStates();
                await sleep(120);
                continue;
            }

            this.bot.attack(target);
            if (!action.standGround) {
                this.bot.setControlState('back', true);
                this.bot.setControlState('jump', true);
                await sleep(380);
                this.bot.clearControlStates();
                await sleep(260);
            } else {
                await sleep(650);
            }
        }

        this.bot.clearControlStates();
        if (target.isValid && this.bot.health <= minimumFightHealth) {
            return this.flee(action);
        }
        if (target.isValid) {
            throw new Error(`${targetName} savasi sonuclanmadi`);
        }
    }

    isMeleeCombatTarget(name) {
        return [
            'zombie',
            'zombie_villager',
            'drowned',
            'husk',
            'spider',
            'cave_spider',
            'slime',
            'magma_cube'
        ].includes(name);
    }

    nearbyImmediateHostile(maxDistance = 6) {
        return Boolean(this.nearestImmediateHostile(maxDistance));
    }

    nearestImmediateHostile(maxDistance = 6, options = {}) {
        const { visibleOnly = false } = options;
        const hostileNames = new Set([
            'zombie',
            'zombie_villager',
            'drowned',
            'husk',
            'skeleton',
            'stray',
            'creeper',
            'enderman',
            'spider',
            'cave_spider',
            'slime',
            'magma_cube',
            'witch',
            'phantom',
            'pillager'
        ]);

        return Object.values(this.bot.entities || {})
            .filter(entity =>
                entity !== this.bot.entity &&
                entity.isValid !== false &&
                hostileNames.has(entityName(entity)) &&
                (!visibleOnly || this.canSeeEntity(entity)) &&
                entity.position.distanceTo(this.bot.entity.position) <= maxDistance
            )
            .sort((a, b) =>
                a.position.distanceTo(this.bot.entity.position) -
                b.position.distanceTo(this.bot.entity.position)
            )[0] || null;
    }

    canSeeEntity(entity) {
        if (!entity) return false;
        if (typeof this.bot.canSeeEntity !== 'function') return true;
        return this.bot.canSeeEntity(entity);
    }

    resolveTarget(targetId, targetName) {
        const byId = targetId != null
            ? this.bot.entities[targetId]
            : null;
        if (byId?.isValid) return byId;

        return Object.values(this.bot.entities)
            .filter(entity =>
                entity !== this.bot.entity &&
                entity.isValid &&
                (!targetName || entityName(entity) === targetName)
            )
            .sort((a, b) =>
                a.position.distanceTo(this.bot.entity.position) -
                b.position.distanceTo(this.bot.entity.position)
            )[0] || null;
    }

    bestCombatWeapon() {
        const typeRank = name => {
            if (name.endsWith('_sword')) return 20;
            if (name.endsWith('_axe')) return 10;
            return 0;
        };

        return this.bot.inventory.items()
            .filter(item =>
                item.name.endsWith('_sword') ||
                item.name.endsWith('_axe')
            )
            .sort((a, b) =>
                typeRank(b.name) + this.toolTier(b.name) -
                typeRank(a.name) - this.toolTier(a.name)
            )[0] || null;
    }

    async swim(action = {}) {
        this.stop();
        const timeoutMs = action.timeoutMs || 8500;
        const shore = this.findNearbyShore();
        if (shore) {
            try {
                await this.goto(
                    new goals.GoalNear(
                        shore.position.x,
                        shore.position.y + 1,
                        shore.position.z,
                        1
                    ),
                    Math.min(timeoutMs, 12000)
                );
                if (!this.bot.entity.isInWater) return;
            } catch (error) {
                console.log('Kiyiya cikis yolu bulunamadi:', error.message);
            }
        } else if (
            this.surfaceAnchor &&
            this.horizontalDistance(this.surfaceAnchor, this.bot.entity.position) <= 96
        ) {
            try {
                await this.returnSurface();
                if (!this.bot.entity.isInWater) return;
            } catch (error) {
                console.log('Su altindan yuzeye cikis basarisiz:', error.message);
            }
        }

        const current = this.bot.entity.position;
        if (shore) {
            await this.bot.lookAt(shore.position.offset(0, 2, 0), true);
        } else if (this.surfaceAnchor) {
            await this.bot.lookAt(
                new Vec3(
                    this.surfaceAnchor.x,
                    Math.max(this.surfaceAnchor.y + 1, current.y + 5),
                    this.surfaceAnchor.z
                ),
                true
            );
        } else {
            await this.bot.look(this.bot.entity.yaw, -Math.PI / 4, true);
        }
        this.bot.setControlState('forward', true);
        this.bot.setControlState('jump', true);
        this.bot.setControlState('sprint', true);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            this.assertActionActive();
            if (!this.bot.entity.isInWater) break;
            await sleep(500);
        }
        this.bot.clearControlStates();
    }

    findNearbyShore() {
        return this.bot.findBlocks({
            matching: block => block.boundingBox === 'block',
            maxDistance: 40,
            count: 512
        })
            .map(position => this.bot.blockAt(position))
            .filter(block => {
                const feet = this.bot.blockAt(block.position.offset(0, 1, 0));
                const head = this.bot.blockAt(block.position.offset(0, 2, 0));
                const standingY = block.position.y + 1;
                const nearbyHeight =
                    Math.abs(standingY - this.bot.entity.position.y) <= 10;
                const unstableSurface =
                    block.name.endsWith('_leaves') ||
                    block.name.endsWith('_log');
                return nearbyHeight &&
                    !unstableSurface &&
                    feet?.name === 'air' &&
                    head?.name === 'air';
            })
            .sort((a, b) =>
                this.horizontalDistance(a.position, this.bot.entity.position) +
                Math.abs((a.position.y + 1) - this.bot.entity.position.y) * 0.5 -
                (
                    this.horizontalDistance(b.position, this.bot.entity.position) +
                    Math.abs((b.position.y + 1) - this.bot.entity.position.y) * 0.5
                )
            )[0] || null;
    }

    horizontalDistance(a, b) {
        return Math.hypot(a.x - b.x, a.z - b.z);
    }

    async goto(goal, timeoutMs) {
        this.assertActionActive();
        const pathPromise = this.bot.pathfinder.goto(goal)
            .then(() => ({ reached: true }))
            .catch(error => ({ error }));
        const timeoutPromise = sleep(timeoutMs)
            .then(() => ({ timeout: true }));

        const result = await Promise.race([pathPromise, timeoutPromise]);
        this.assertActionActive();
        if (result.reached) return;

        this.bot.pathfinder.setGoal(null);
        this.bot.clearControlStates();

        if (result.error) throw result.error;
        await this.unstick();
        throw new Error('Navigasyon zaman asimina ugradi');
    }

    async unstick() {
        this.bot.setControlState('back', true);
        this.bot.setControlState('jump', true);
        await sleep(600);
        this.bot.clearControlStates();

        await this.bot.look(this.bot.entity.yaw + Math.PI / 2, 0, true);
        this.bot.setControlState('forward', true);
        this.bot.setControlState('jump', true);
        await sleep(900);
        this.bot.clearControlStates();
    }

    async equipTool(block) {
        const toolIds = Object.keys(block.harvestTools || {}).map(Number);
        if (toolIds.length === 0) return;

        const tool = this.bot.inventory.items()
            .filter(item => toolIds.includes(item.type))
            .sort((a, b) =>
                this.toolTier(b.name) - this.toolTier(a.name)
            )[0];
        if (!tool) throw new Error(`${block.name} icin uygun alet yok`);
        await this.bot.equip(tool, 'hand');
    }

    async equipBestTool(block) {
        const toolIds = Object.keys(block.harvestTools || {}).map(Number);
        const explicitTool = toolIds.length > 0
            ? this.bot.inventory.items()
                .filter(item => toolIds.includes(item.type))
                .sort((a, b) => this.toolTier(b.name) - this.toolTier(a.name))[0]
            : null;
        const fallback = this.bot.pathfinder.bestHarvestTool(block);
        const tool = explicitTool || (
            fallback && this.isHarvestTool(fallback.name) ? fallback : null
        );
        if (tool) {
            await this.bot.equip(tool, 'hand');
        }
        return tool;
    }

    createMovements(canDig, canPlace = false) {
        const movements = new Movements(this.bot, this.bot.registry);
        movements.canDig = canDig;
        movements.allow1by1towers = canPlace;
        movements.scafoldingBlocks = canPlace
            ? this.scaffoldingBlockIds()
            : [];
        movements.placeCost = canPlace ? 6 : 1000;
        movements.dontCreateFlow = true;
        movements.dontMineUnderFallingBlock = true;
        return movements;
    }

    scaffoldingBlockIds() {
        return [
            'cobblestone',
            'cobbled_deepslate',
            'dirt',
            'tuff',
            'deepslate',
            'stone',
            'oak_planks'
        ]
            .map(name => this.bot.registry.blocksByName[name]?.id)
            .filter(id => id != null);
    }

    toolTier(name) {
        const tiers = [
            'wooden_',
            'golden_',
            'stone_',
            'iron_',
            'diamond_',
            'netherite_'
        ];
        const rank = tiers.findIndex(tier => name.startsWith(tier));
        return rank === -1 ? -1 : rank;
    }

    isHarvestTool(name) {
        return [
            '_pickaxe',
            '_axe',
            '_shovel',
            '_hoe',
            '_sword',
            'shears'
        ].some(suffix => name.endsWith(suffix));
    }

    findSafeMineTarget(blockType) {
        const positions = this.bot.findBlocks({
            matching: blockType.id,
            maxDistance: 64,
            count: 128
        });

        const blocks = positions
            .map(position => this.bot.blockAt(position))
            .filter(Boolean)
            .filter(block => !this.isRecentlyFailedMineTarget(block))
            .filter(block => !this.isRecentlyFailedMineArea(block));
        const preferred = blocks.filter(block => {
            if (!this.isWoodBlock(block.name)) return this.isSafeMineTarget(block);
            return this.isReachableWoodTarget(block);
        });
        const candidates = preferred.length > 0
            ? preferred
            : blocks.filter(block =>
                !this.isWoodBlock(block.name) && this.isSafeMineTarget(block)
            );

        return candidates.sort((a, b) =>
            this.mineTargetScore(a) - this.mineTargetScore(b)
        )[0] || null;
    }

    rememberFailedMineTarget(block) {
        const now = Date.now();
        this.failedMineTargets.set(
            block.position.toString(),
            now
        );
        this.failedMineEvents = this.failedMineEvents
            .filter(event => now - event.failedAt <= 120000);
        this.failedMineEvents.push({
            name: block.name,
            position: block.position.clone(),
            failedAt: now
        });

        const nearbyFailures = this.failedMineEvents
            .filter(event =>
                event.name === block.name &&
                event.position.distanceTo(block.position) <= 28
            );
        if (nearbyFailures.length >= 3) {
            this.failedMineAreas.push({
                name: block.name,
                position: block.position.clone(),
                failedAt: now
            });
            this.failedMineAreas = this.failedMineAreas.slice(-12);
            console.log(
                `Kaynak alani gecici kara listeye alindi: ${block.name} ${block.position.toString()}`
            );
        }
    }

    isRecentlyFailedMineTarget(block) {
        const failedAt = this.failedMineTargets.get(block.position.toString());
        if (!failedAt) return false;
        if (Date.now() - failedAt > 120000) {
            this.failedMineTargets.delete(block.position.toString());
            return false;
        }
        return true;
    }

    isRecentlyFailedMineArea(block) {
        const now = Date.now();
        this.failedMineAreas = this.failedMineAreas
            .filter(area => now - area.failedAt <= 300000);
        return this.failedMineAreas.some(area =>
            area.name === block.name &&
            area.position.distanceTo(block.position) <= 32
        );
    }

    isReachableWoodTarget(block) {
        const verticalDelta = Math.abs(
            block.position.y - Math.floor(this.bot.entity.position.y)
        );
        if (verticalDelta > 4) return false;
        if (!this.hasOpenMiningFace(block.position)) return false;

        const workPosition = this.findProjectWorkPosition(block.position);
        if (!workPosition) return false;

        const eyePosition = workPosition.offset(0, 1.6, 0);
        const blockCenter = block.position.offset(0.5, 0.5, 0.5);
        return eyePosition.distanceTo(blockCenter) <= 4.6;
    }

    lowestReachableWoodBlock(block) {
        if (!block || !this.isWoodBlock(block.name)) return null;

        let lowest = block;
        for (let y = block.position.y - 1; y >= Math.max(1, block.position.y - 8); y--) {
            const candidate = this.bot.blockAt(new Vec3(block.position.x, y, block.position.z));
            if (!candidate || candidate.name !== block.name) break;
            if (this.isReachableWoodTarget(candidate)) {
                lowest = candidate;
            }
        }
        return lowest;
    }

    mineTargetScore(block) {
        const distance = block.position.distanceTo(this.bot.entity.position);
        if (!this.isWoodBlock(block.name)) return distance;
        const verticalDelta = Math.abs(
            block.position.y - Math.floor(this.bot.entity.position.y)
        );
        const hasWoodBelow = this.bot.blockAt(block.position.offset(0, -1, 0))?.name === block.name;
        const workPosition = this.findProjectWorkPosition(block.position);
        const workDistance = workPosition
            ? workPosition.distanceTo(this.bot.entity.position)
            : distance + 32;
        return workDistance + verticalDelta * 24 + (hasWoodBelow ? 96 : 0);
    }

    hasOpenMiningFace(position) {
        const faces = [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1]
        ];
        return faces.some(([x, y, z]) => {
            const neighbor = this.bot.blockAt(position.offset(x, y, z));
            return ['air', 'cave_air', 'void_air'].includes(neighbor?.name);
        });
    }

    isSafeMineTarget(block) {
        const faces = [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1]
        ];
        const openFace = faces.some(([x, y, z]) => {
            const neighbor = this.bot.blockAt(block.position.offset(x, y, z));
            return neighbor?.name === 'air' || neighbor?.name === 'cave_air';
        });
        if (!openFace) return false;

        const above = this.bot.blockAt(block.position.offset(0, 1, 0));
        const below = this.bot.blockAt(block.position.offset(0, -1, 0));
        const unsafeAbove = ['sand', 'red_sand', 'gravel'].includes(above?.name);
        const unsafeBelow = ['lava', 'water'].includes(below?.name);

        return !unsafeAbove && !unsafeBelow;
    }

    findUndergroundStone() {
        const ids = ['stone', 'deepslate']
            .map(name => this.bot.registry.blocksByName[name]?.id)
            .filter(Boolean);
        const blocks = this.bot.findBlocks({
            matching: ids,
            maxDistance: 48,
            count: 256
        })
            .map(position => this.bot.blockAt(position))
            .filter(Boolean)
            .sort((a, b) =>
                a.position.distanceTo(this.bot.entity.position) -
                b.position.distanceTo(this.bot.entity.position)
            );

        const below = blocks.find(block =>
            block.position.y < this.bot.entity.position.y - 1
        );
        return below || blocks[0] || null;
    }

    findNearbyCraftingTable(maxDistance = 4) {
        const id = this.bot.registry.blocksByName.crafting_table?.id;
        if (!id) return null;
        return this.bot.findBlock({ matching: id, maxDistance });
    }

    findVisibleCraftingTable(maxDistance = 16) {
        return this.findNearbyCraftingTable(maxDistance);
    }

    nearestKnownCraftingTable(maxDistance = 64) {
        const tables = this.memory?.data.craftingTables || [];
        if (tables.length === 0) return null;

        const origin = this.bot.entity.position;
        return tables
            .map(table => new Vec3(table.x, table.y, table.z))
            .filter(position =>
                Math.hypot(position.x - origin.x, position.z - origin.z) <= maxDistance &&
                Math.abs(position.y - origin.y) <= 24
            )
            .sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin))[0] ||
            null;
    }

    rememberCraftingTable(position) {
        if (!position) return;
        this.memory?.remember('craftingTables', position);
    }

    forgetCraftingTable(position) {
        if (!position || !Array.isArray(this.memory?.data?.craftingTables)) return;
        const before = this.memory.data.craftingTables.length;
        this.memory.data.craftingTables = this.memory.data.craftingTables.filter(table =>
            table.x !== Math.floor(position.x) ||
            table.y !== Math.floor(position.y) ||
            table.z !== Math.floor(position.z)
        );
        if (this.memory.data.craftingTables.length !== before) {
            this.memory.save();
            console.log(
                `Gecersiz crafting table hafizadan silindi: ` +
                `(${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})`
            );
        }
    }

    findPlacement() {
        const origin = this.bot.entity.position.floored();
        const offsets = [
            [1, 0], [-1, 0], [0, 1], [0, -1],
            [1, 1], [-1, 1], [1, -1], [-1, -1]
        ];

        for (const [dx, dz] of offsets) {
            const target = origin.offset(dx, 0, dz);
            const empty = this.bot.blockAt(target);
            const reference = this.bot.blockAt(target.offset(0, -1, 0));

            if (empty?.name === 'air' && reference?.boundingBox === 'block') {
                return { target, reference };
            }
        }

        return null;
    }

    async createPlacementNook() {
        const origin = this.bot.entity.position.floored();
        const offsets = [
            [1, 0], [-1, 0], [0, 1], [0, -1]
        ];

        for (const [dx, dz] of offsets) {
            const target = origin.offset(dx, 0, dz);
            const head = target.offset(0, 1, 0);
            const floor = this.bot.blockAt(target.offset(0, -1, 0));
            if (floor?.boundingBox !== 'block') continue;

            const blocksToClear = [target, head]
                .map(position => this.bot.blockAt(position))
                .filter(block => block && block.name !== 'air');
            if (blocksToClear.some(block =>
                !block.diggable || !this.bot.canDigBlock(block)
            )) {
                continue;
            }

            for (const block of blocksToClear) {
                await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
                await this.equipBestTool(block);
                await this.bot.dig(block);
                await sleep(150);
            }

            const empty = this.bot.blockAt(target);
            const emptyHead = this.bot.blockAt(head);
            if (empty?.name === 'air' && emptyHead?.name === 'air') {
                return {
                    target,
                    reference: this.bot.blockAt(target.offset(0, -1, 0))
                };
            }
        }

        return null;
    }

    stop() {
        this.bot.pathfinder?.setGoal(null);
        if (typeof this.bot.stopDigging === 'function') {
            try {
                this.bot.stopDigging();
            } catch {
                // Best-effort interrupt; pathfinder/control cleanup below still matters.
            }
        }
        this.bot.clearControlStates();
    }
}

module.exports = Skills;
