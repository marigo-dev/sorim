const fs = require('fs');
const path = require('path');

const DEFAULT_MEMORY = {
    home: null,
    surfaceAnchor: null,
    base: null,
    shelter: null,
    mine: null,
    farm: null,
    farmInProgress: null,
    expandedFarm: null,
    upgradedBase: null,
    beautifulHouse: null,
    storageSystem: null,
    treeGarden: null,
    deepMine: null,
    netherPortal: null,
    enteredNether: false,
    ironArmorEquipped: false,
    diamondArmorEquipped: false,
    beds: [],
    chests: [],
    craftingTables: [],
    waterSources: [],
    waterSearchAttempts: 0,
    waterUnavailable: false,
    exploredAreas: [],
    completedGoals: [],
    deathPosition: null,
    unsafeBaseDeaths: 0,
    lastPosition: null,
    updatedAt: null
};

class WorldMemory {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = this.load();
        this.saveTimer = null;
        this.dirty = false;
        this.saveDelayMs = 750;
    }

    load() {
        try {
            const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            const data = { ...DEFAULT_MEMORY, ...saved };
            if (!data.base && data.shelter) data.base = { ...data.shelter };
            return data;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.log('Dunya hafizasi okunamadi:', error.message);
            }
            return { ...DEFAULT_MEMORY };
        }
    }

    setHome(position) {
        if (this.data.home && this.data.shelter) return;
        this.data.home = toPosition(position);
        this.save();
        console.log('Kalici ana kamp belirlendi:', this.data.home);
    }

    setShelter(position) {
        this.data.shelter = {
            ...toPosition(position),
            builtAt: new Date().toISOString()
        };
        this.data.base = {
            ...toPosition(position),
            establishedAt: new Date().toISOString()
        };
        this.save();
        console.log('Ilk barinak tamamlandi:', this.data.shelter);
    }

    setProject(name, position, details = {}) {
        this.data[name] = {
            ...toPosition(position),
            ...details,
            completedAt: new Date().toISOString()
        };
        this.save();
        console.log(`${name} projesi tamamlandi:`, this.data[name]);
    }

    setFlag(name, value = true) {
        this.data[name] = value;
        this.save();
    }

    remember(type, position) {
        const list = this.data[type];
        if (!Array.isArray(list)) return;

        const entry = toPosition(position);
        const exists = list.some(saved =>
            saved.x === entry.x &&
            saved.y === entry.y &&
            saved.z === entry.z
        );

        if (!exists) {
            list.push(entry);
            this.data[type] = list.slice(-20);
            this.save();
        }
    }

    rememberExplored(position, resource = 'genel') {
        const entry = {
            ...toPosition(position),
            resource,
            visitedAt: new Date().toISOString()
        };
        const nearbyIndex = this.data.exploredAreas.findIndex(saved =>
            saved.resource === resource &&
            horizontalDistance(saved, entry) < 16
        );

        if (nearbyIndex >= 0) {
            this.data.exploredAreas[nearbyIndex] = entry;
        } else {
            this.data.exploredAreas.push(entry);
            this.data.exploredAreas = this.data.exploredAreas.slice(-80);
        }
        this.save();
    }

    completeGoal(description) {
        this.data.completedGoals.push(description);
        this.data.completedGoals = this.data.completedGoals.slice(-30);
        this.save();
    }

    updatePosition(position) {
        this.data.lastPosition = toPosition(position);
    }

    save() {
        this.dirty = true;
        if (this.saveTimer) return;

        this.saveTimer = setTimeout(() => {
            this.flush();
        }, this.saveDelayMs);
    }

    flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (!this.dirty) return;

        this.data.updatedAt = new Date().toISOString();
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(
            this.filePath,
            `${JSON.stringify(this.data, null, 2)}\n`,
            'utf8'
        );
        this.dirty = false;
    }
}

function toPosition(position) {
    return {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
    };
}

function horizontalDistance(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

module.exports = WorldMemory;
