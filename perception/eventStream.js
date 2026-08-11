class EventStream {
    constructor(limit = 128) {
        this.limit = Math.max(16, Number(limit) || 128);
        this.events = [];
        this.sequence = 0;
    }

    push(type, details = {}, importance = 0.3) {
        const event = {
            id: ++this.sequence,
            type,
            timestamp: Date.now(),
            importance: clamp(Number(importance) || 0),
            ...sanitize(details)
        };
        this.events.push(event);
        if (this.events.length > this.limit) {
            this.events.splice(0, this.events.length - this.limit);
        }
        return event;
    }

    recent(limit = 20, minimumImportance = 0) {
        return this.events
            .filter(event => event.importance >= minimumImportance)
            .slice(-Math.max(1, limit))
            .map(event => ({ ...event }));
    }

    since(eventId = 0, limit = 50) {
        return this.events
            .filter(event => event.id > eventId)
            .slice(-Math.max(1, limit))
            .map(event => ({ ...event }));
    }
}

function sanitize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) =>
            entry === null || ['string', 'number', 'boolean'].includes(typeof entry) ||
            (entry && typeof entry === 'object')
        )
    );
}

function clamp(value) {
    return Math.max(0, Math.min(1, value));
}

module.exports = EventStream;
