class TaskQueue {
    constructor(store, options = {}) {
        this.store = store;
        this.preconditionResolver = options.preconditionResolver || null;
        this.tasks = normalizeTasks(store?.getTaskQueue?.() || []);
    }

    enqueue(goal) {
        const task = normalizeTask({
            id: goal.id || `goal_${Date.now()}`,
            goal: goal.goal || goal.id || 'player_request',
            requestedBy: goal.requestedBy || null,
            status: 'running',
            createdAt: Date.now(),
            steps: goal.steps || []
        });
        this.tasks.push(task);
        this.store?.addCommitment?.({
            id: task.id,
            player: task.requestedBy,
            summary: task.goal,
            status: 'active'
        });
        this.save();
        return task;
    }

    active() {
        return this.tasks.find(task => ['running', 'suspended'].includes(task.status)) || null;
    }

    currentStep() {
        const task = this.active();
        if (!task) return null;
        if (task.status === 'suspended') task.status = 'running';
        return task.steps.find(step => ['pending', 'running'].includes(step.status)) || null;
    }

    toolCall(context = {}) {
        const task = this.active();
        let step = this.currentStep();
        if (!task || !step) return null;
        for (let depth = 0; depth < 8 && step.status === 'pending' && this.preconditionResolver; depth++) {
            const prerequisites = this.preconditionResolver.resolve(step, {
                ...context,
                task,
                preconditionCounts: countPreconditions(task, step.id)
            });
            if (prerequisites.length > 0) {
                this.insertBefore(task, step, prerequisites);
                step = this.currentStep();
                continue;
            }
            break;
        }
        step.status = 'running';
        step.attempts = Number(step.attempts || 0) + 1;
        this.save();
        return { tool: step.tool, args: step.args || {}, reason: `${task.goal}: ${step.reason || step.tool}` };
    }

    completeCurrentStep(verification = null) {
        const task = this.active();
        const step = this.currentStep();
        if (!task || !step) return;
        step.status = 'completed';
        step.completedAt = Date.now();
        step.verification = verification ? normalizeVerification(verification) : null;
        if (task.steps.every(entry => entry.status === 'completed')) {
            task.status = 'completed';
            task.completedAt = Date.now();
            this.store?.addEpisode?.('task_completed', `Completed ${task.goal}.`, 0.8, { taskId: task.id });
            this.store?.resolveCommitment?.(task.id, 'completed');
        }
        this.save();
        return { taskCompleted: task.status === 'completed', task: { ...task } };
    }

    failCurrentStep(error) {
        const task = this.active();
        const step = this.currentStep();
        if (!task || !step) return;
        step.lastError = String(error?.message || error || 'unknown error').slice(0, 300);
        if (step.attempts >= Number(step.maxAttempts || 3)) {
            step.status = 'failed';
            task.status = 'failed';
            this.store?.addEpisode?.('task_failed', `Failed ${task.goal}: ${step.lastError}`, 0.75, { taskId: task.id });
            this.store?.resolveCommitment?.(task.id, 'failed', { error: step.lastError });
        } else {
            step.status = 'pending';
        }
        this.save();
        return { taskFailed: task.status === 'failed', task: { ...task } };
    }

    suspend(reason) {
        const task = this.active();
        if (!task || task.status !== 'running') return;
        task.status = 'suspended';
        task.suspendReason = reason || 'safety override';
        this.save();
    }

    cancelAll(reason = 'cancelled by player') {
        for (const task of this.tasks) {
            if (['running', 'suspended'].includes(task.status)) {
                task.status = 'cancelled';
                task.cancelReason = reason;
                this.store?.resolveCommitment?.(task.id, 'cancelled', { reason });
            }
        }
        this.save();
    }

    summary() {
        const task = this.active();
        if (!task) return null;
        const step = task.steps.find(entry => ['pending', 'running'].includes(entry.status));
        return { id: task.id, goal: task.goal, status: task.status, currentStep: step?.tool || null };
    }

    insertBefore(task, targetStep, steps) {
        const index = task.steps.indexOf(targetStep);
        if (index < 0) return;
        const normalized = steps.map((step, offset) => normalizeStep(step, task.steps.length + offset));
        task.steps.splice(index, 0, ...normalized);
        this.save();
    }

    save() {
        this.store?.setTaskQueue?.(this.tasks);
    }
}

function normalizeTasks(tasks) {
    return tasks.map(normalizeTask).filter(task => task.steps.length > 0);
}

function normalizeTask(task) {
    return {
        ...task,
        id: String(task.id || `goal_${Date.now()}`),
        status: task.status || 'running',
        steps: (task.steps || []).map(normalizeStep).filter(step => typeof step.tool === 'string')
    };
}

function normalizeStep(step, index) {
    return {
        ...step,
        id: step.id || `step_${index + 1}_${Date.now()}`,
        tool: step.tool,
        args: step.args && typeof step.args === 'object' ? step.args : {},
        reason: step.reason || '',
        status: step.status || 'pending',
        attempts: Number(step.attempts || 0),
        maxAttempts: Number(step.maxAttempts || 3),
        lastError: step.lastError || null,
        preconditionFor: step.preconditionFor || null,
        preconditionKey: step.preconditionKey || null,
        verification: step.verification || null
    };
}

function countPreconditions(task, parentId) {
    return task.steps.filter(step => step.preconditionFor === parentId).reduce((counts, step) => {
        const key = step.preconditionKey || step.tool;
        counts[key] = (counts[key] || 0) + 1;
        return counts;
    }, {});
}

function normalizeVerification(value) {
    return {
        ok: Boolean(value.ok),
        reason: String(value.reason || '').slice(0, 300),
        details: value.details && typeof value.details === 'object' ? value.details : {}
    };
}

module.exports = TaskQueue;
