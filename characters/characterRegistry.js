const DEFAULT_MICO = {
    id: 'citizen_mico',
    username: 'Bot_Mico',
    shortName: 'Mico',
    displayName: 'Miço',
    aliases: ['Mico', 'Miço', 'Bot_Mico'],
    status: 'alive',
    profession: 'lumberjack',
    traits: {
        sociability: 0.82,
        courage: 0.58,
        curiosity: 0.73,
        discipline: 0.66,
        generosity: 0.79,
        ambition: 0.41
    },
    speech: { tone: 'warm and practical', verbosity: 'short' },
    values: ['cooperation', 'safe exploration'],
    preferences: { jobs: ['lumberjack', 'builder'], dislikedJobs: ['fisher'] },
    relationships: {},
    reputation: { trust: 0.5, competence: 0.5, service: 0 }
};

class CharacterRegistry {
    constructor(store, options = {}) {
        if (!store?.load || !store?.save) throw new Error('CharacterRegistry requires a load/save store');
        this.store = store;
        this.now = options.now || (() => new Date().toISOString());
    }

    ensureDefaults() {
        if (!this.get(DEFAULT_MICO.id)) this.register(DEFAULT_MICO);
        return this.all();
    }

    register(profile) {
        validateProfile(profile);
        const state = this.store.load();
        state.characters = state.characters || {};
        const duplicate = Object.values(state.characters).find(character =>
            character.id !== profile.id && normalize(character.username) === normalize(profile.username)
        );
        if (duplicate) throw new Error(`Character username already exists: ${profile.username}`);
        const existing = state.characters[profile.id];
        state.characters[profile.id] = normalizeProfile({
            ...existing,
            ...clone(profile),
            createdAt: existing?.createdAt || profile.createdAt || this.now(),
            updatedAt: this.now()
        });
        this.store.save(state);
        return clone(state.characters[profile.id]);
    }

    get(id) {
        const value = this.store.load().characters?.[id];
        return value ? clone(value) : null;
    }

    byUsername(username) {
        return this.all().find(profile => normalize(profile.username) === normalize(username)) || null;
    }

    all(options = {}) {
        const values = Object.values(this.store.load().characters || {}).map(clone);
        return options.includeDeceased ? values : values.filter(profile => profile.status !== 'deceased');
    }

    resolveAddress(message) {
        const folded = normalize(message);
        const matches = this.all().filter(profile => profile.aliases.some(alias => containsToken(folded, normalize(alias))));
        if (matches.length !== 1) return null;
        return matches[0];
    }

    updateRelationship(id, otherId, delta, reason) {
        const profile = this.get(id);
        if (!profile) return null;
        const current = profile.relationships[otherId] || { trust: 0.5, affinity: 0.5, events: [] };
        current.trust = clamp(current.trust + Number(delta.trust || 0));
        current.affinity = clamp(current.affinity + Number(delta.affinity || 0));
        current.events = [...(current.events || []), { at: this.now(), reason }].slice(-20);
        profile.relationships[otherId] = current;
        return this.register(profile);
    }
}

function validateProfile(profile) {
    for (const key of ['id', 'username', 'shortName']) {
        if (!String(profile?.[key] || '').trim()) throw new Error(`Character ${key} is required`);
    }
    if (!/^[A-Za-z0-9_]{3,16}$/.test(profile.username)) {
        throw new Error('Character username must be Minecraft-safe and 3-16 characters');
    }
}

function normalizeProfile(profile) {
    return {
        ...profile,
        aliases: Array.from(new Set([profile.shortName, profile.displayName, profile.username, ...(profile.aliases || [])].filter(Boolean))),
        status: profile.status || 'alive',
        traits: { ...(profile.traits || {}) },
        speech: { ...(profile.speech || {}) },
        values: [...(profile.values || [])],
        preferences: { jobs: [], dislikedJobs: [], ...(profile.preferences || {}) },
        relationships: { ...(profile.relationships || {}) },
        reputation: { trust: 0.5, competence: 0.5, service: 0, ...(profile.reputation || {}) }
    };
}

function normalize(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ş/g, 's')
        .replace(/ğ/g, 'g').replace(/ö/g, 'o').replace(/ü/g, 'u');
}

function containsToken(text, token) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(text);
}

function clamp(value) {
    return Math.max(0, Math.min(1, Number(value)));
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

module.exports = CharacterRegistry;
module.exports.DEFAULT_MICO = DEFAULT_MICO;
