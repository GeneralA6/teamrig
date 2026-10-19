/** The config format this code reads and writes. Older files are migrated in memory on load. */
export const CONFIG_VERSION = 4;
export const VERIFY_GATES = ['refuse', 'warn'];
export function isVerifyGate(value) {
    return VERIFY_GATES.some((gate) => gate === value);
}
export const CONFLICT_WINNERS = ['local', 'teamrig'];
export function isConflictWinner(value) {
    return CONFLICT_WINNERS.some((winner) => winner === value);
}
export const PUSH_TO_PROTECTED = ['ask', 'allow'];
export function isPushToProtected(value) {
    return PUSH_TO_PROTECTED.some((choice) => choice === value);
}
export const AD_HOC_RUNNERS = ['deny', 'ask', 'allow'];
export function isAdHocRunners(value) {
    return AD_HOC_RUNNERS.some((choice) => choice === value);
}
export const SKIP_HOOKS = ['deny', 'ask', 'allow'];
export function isSkipHooks(value) {
    return SKIP_HOOKS.some((choice) => choice === value);
}
export const COMMIT_GATES = ['off', 'warn', 'refuse'];
export function isCommitGate(value) {
    return COMMIT_GATES.some((gate) => gate === value);
}
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function isWeekday(value) {
    return WEEKDAYS.some((day) => day === value);
}
export const OVER_ACTIONS = ['warn', 'ask-lead', 'ask', 'block'];
export function isOverAction(value) {
    return OVER_ACTIONS.some((action) => action === value);
}
export const ESCALATIONS = ['session', 'session-and-fleet'];
export function isEscalation(value) {
    return ESCALATIONS.some((escalation) => escalation === value);
}
/**
 * Who may hire a session onto the team (`teamrig hire`): `off` nobody; `owner` the lead, once the owner
 * approved (`--approved-by`, kept with the hire); `lead` the lead, within the caps; `automatic` as `lead`,
 * and a hired session whose tasks are all closed may also retire itself (`teamrig retire`).
 */
export const HIRING_POLICIES = ['off', 'owner', 'lead', 'automatic'];
export function isHiringPolicy(value) {
    return HIRING_POLICIES.some((policy) => policy === value);
}
/**
 * Who may start a burst (`teamrig burst start`), a time-boxed scale-out onto helpers and hired sessions
 * that spends more of the week: `off` nobody; `owner` the lead, once the owner approved (`--approved-by`,
 * kept with the burst); `lead` the lead, within the caps. No policy starts a burst on its own: it spends
 * more of the week, a decision the owner gates, so a person always starts it by command.
 */
export const BURST_POLICIES = ['off', 'owner', 'lead'];
export function isBurstPolicy(value) {
    return BURST_POLICIES.some((policy) => policy === value);
}
/**
 * Where `teamrig open` opens a session's tab: `auto` picks tmux inside tmux, else the platform's
 * terminal; `print` opens nothing and prints the command to run.
 */
export const TERMINALS = ['auto', 'tmux', 'windows-terminal', 'macos-terminal', 'gnome-terminal', 'konsole', 'x-terminal-emulator', 'print'];
export function isTerminalChoice(value) {
    return TERMINALS.some((terminal) => terminal === value);
}
/** Claude Code's effort levels, lowest first: what `claude --effort` and `/effort` take. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function isEffortLevel(value) {
    return EFFORT_LEVELS.some((level) => level === value);
}
