const Status = require('./status');
const { PrioritySelector, Action } = require('./nodes');

function createColonyBodyTree() {
    return new PrioritySelector('colony_body_root', [
        new Action('local_survival', context => {
            if (!context.safetyCall) return null;
            return decision('safety', context.safetyCall);
        }),
        new Action('scheduled_work', context => {
            if (!context.workCall) return null;
            return decision('scheduler', context.workCall);
        }),
        new Action('idle', () => decision('idle', {
            tool: 'wait_safe', args: { ms: 750 }, reason: 'No safe assigned colony work'
        }))
    ]);
}

function decision(source, toolCall) {
    return { status: Status.RUNNING, value: { source, toolCall } };
}

module.exports = { createColonyBodyTree };
