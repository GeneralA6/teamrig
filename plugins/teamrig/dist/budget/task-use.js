function sum(values) {
    let total = 0;
    for (const value of values) {
        total += value;
    }
    return total;
}
/** The open turns of a session's transcripts that named a task. */
function namingTurns(state) {
    return Object.values(state.cursors)
        .map(({ turn }) => turn)
        .filter((turn) => turn.tasks.length > 0);
}
/** W per UTC day on `task` in one session's usage, its open turns' share included. */
function daysOf(state, task) {
    const days = new Map();
    const add = (day, w) => {
        days.set(day, (days.get(day) ?? 0) + w);
    };
    for (const [day, tasks] of Object.entries(state.byTask)) {
        const w = tasks[task];
        if (w !== undefined) {
            add(day, w);
        }
    }
    for (const turn of namingTurns(state)) {
        if (turn.tasks.includes(task)) {
            for (const [day, w] of Object.entries(turn.held)) {
                add(day, w / turn.tasks.length);
            }
        }
    }
    return days;
}
/** The W the meter keeps on `task`, per session, from each session's usage by its id. */
export function taskUseOf(bySession, task) {
    const sessions = [];
    for (const [session, state] of bySession) {
        const days = daysOf(state, task);
        if (days.size > 0) {
            const byDay = Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b)));
            sessions.push({ session, byDay, w: sum(days.values()) });
        }
    }
    sessions.sort((a, b) => b.w - a.w);
    return { task, sessions, w: sum(sessions.map((session) => session.w)) };
}
/** The W of a UTC day a session's turns put on some task, its open turns that named one included. */
export function attributedW(state, day) {
    return sum(Object.values(state.byTask[day] ?? {})) + sum(namingTurns(state).map((turn) => turn.held[day] ?? 0));
}
