const PROFILES = {
    farmer: {
        id: 'farmer',
        aliases: ['farmer', 'ciftci', 'çiftçi', 'yemekci', 'yemekçi'],
        primaryJobs: ['establish_wheat_farm', 'maintain_food_supply'],
        secondaryJobs: ['care_for_animals', 'cook_food', 'store_food'],
        storageCategory: 'food',
        stockTargets: { bread: 32, wheat: 32, wheat_seeds: 16 }
    },
    rancher: {
        id: 'rancher',
        aliases: ['rancher', 'hayvanci', 'hayvancı'],
        primaryJobs: ['care_for_animals', 'breed_animals'],
        secondaryJobs: ['maintain_food_supply', 'store_food'],
        storageCategory: 'food'
    },
    miner: {
        id: 'miner',
        aliases: ['miner', 'madenci'],
        primaryJobs: ['prepare_mining_kit', 'mine_iron'],
        secondaryJobs: ['organize_storage'],
        storageCategory: 'ores'
    },
    lumberjack: {
        id: 'lumberjack',
        aliases: ['lumberjack', 'oduncu'],
        primaryJobs: ['mine_block', 'replant_saplings'],
        secondaryJobs: ['organize_storage'],
        storageCategory: 'wood'
    },
    fisher: {
        id: 'fisher',
        aliases: ['fisher', 'balikci', 'balıkçı'],
        primaryJobs: ['fish'],
        secondaryJobs: ['cook_food', 'store_food'],
        storageCategory: 'food'
    },
    builder: {
        id: 'builder',
        aliases: ['builder', 'insaatci', 'inşaatçı'],
        primaryJobs: ['build_shelter', 'repair_structures'],
        secondaryJobs: ['organize_storage'],
        storageCategory: 'building'
    },
    guard: {
        id: 'guard',
        aliases: ['guard', 'muhafiz', 'muhafız'],
        primaryJobs: ['patrol', 'fight_mob'],
        secondaryJobs: ['return_base'],
        storageCategory: 'combat'
    },
    quartermaster: {
        id: 'quartermaster',
        aliases: ['quartermaster', 'depocu'],
        primaryJobs: ['organize_storage'],
        secondaryJobs: ['count_shared_storage'],
        storageCategory: 'all'
    }
};

function resolveProfession(value) {
    const normalized = String(value || '').toLocaleLowerCase('tr-TR');
    return Object.values(PROFILES).find(profile =>
        profile.id === normalized || profile.aliases.includes(normalized)
    ) || null;
}

module.exports = { PROFILES, resolveProfession };
