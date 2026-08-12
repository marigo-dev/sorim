const Status = require('./status');
const { PrioritySelector, Action } = require('./nodes');

function createRootTree(options) {
    const { taskQueue, professionManager } = options;
    return new PrioritySelector('root', [
        new Action('safety', context => {
            if (!context.safetyCall) return null;
            taskQueue.suspend('safety override');
            return decision('safety', context.safetyCall);
        }),
        new Action('owner_command', context => {
            if (!context.commandCall) return null;
            return decision('command', context.commandCall);
        }),
        new Action('persistent_directive', context => {
            if (!context.directiveCall && !context.followCall) return null;
            return decision('directive', context.directiveCall || context.followCall);
        }),
        new Action('active_task', context => {
            const call = taskQueue.toolCall({ observation: context.observation, bot: context.bot });
            return call ? decision('task', call) : null;
        }),
        new Action('profession', context => {
            const call = professionManager.nextTool(context.observation);
            return call ? decision('profession', call) : null;
        }),
        new Action('autonomous', context => {
            if (!context.autonomousCall) return null;
            return decision(context.autonomousSource || 'fallback', context.autonomousCall);
        }),
        new Action('idle', () => decision('idle', {
            tool: 'wait_safe', args: { ms: 750 }, reason: 'No active behavior'
        }))
    ]);
}

function decision(source, toolCall) {
    return { status: Status.RUNNING, value: { source, toolCall } };
}

module.exports = { createRootTree };
