import { autoTerminals, tabCommand } from "./terminals.js";
function candidatesOf(choice, deps) {
    switch (choice) {
        case 'auto':
            return autoTerminals(deps.env, deps.platform);
        case 'print':
            return [];
        default:
            return [choice];
    }
}
/** Opens the tab in the chosen terminal, or the first `auto` finds that works; `print` tries none. */
export async function openTab(deps, choice, tab) {
    const reasons = [];
    for (const terminal of candidatesOf(choice, deps)) {
        const planned = tabCommand(terminal, tab);
        if (planned.kind === 'unusable') {
            reasons.push(planned.why);
            continue;
        }
        const outcome = await deps.processes.start(planned.request);
        switch (outcome.kind) {
            case 'started':
                return { kind: 'opened', terminal };
            case 'missing':
                reasons.push(`${terminal} is not installed`);
                break;
            case 'failed':
                reasons.push(`${terminal} failed: ${outcome.error}`);
                break;
        }
    }
    return { kind: 'none', reasons: reasons.length === 0 ? ['the terminal setting is print'] : reasons };
}
