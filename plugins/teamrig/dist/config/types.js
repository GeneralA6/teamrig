/** The config format this code reads and writes. Older files are migrated in memory on load. */
export const CONFIG_VERSION = 7;
export const VERIFY_GATES = ['refuse', 'warn'];
export function isVerifyGate(value) {
    return VERIFY_GATES.some((gate) => gate === value);
}
export const REVIEW_MODES = ['refuse', 'warn', 'off'];
export function isReviewMode(value) {
    return REVIEW_MODES.some((mode) => mode === value);
}
export const CONFLICT_WINNERS = ['local', 'teamrig'];
export function isConflictWinner(value) {
    return CONFLICT_WINNERS.some((winner) => winner === value);
}
/**
 * How a launched session's Claude Code lists a skill of another session's area, as its `skillOverrides` setting takes
 * it: `on` in full, `name-only` without its description, `user-invocable-only` only as a `/name` command the model is
 * not shown, `off` not at all.
 */
export const OTHER_AREA_LISTINGS = ['on', 'name-only', 'user-invocable-only', 'off'];
export function isOtherAreaListing(value) {
    return OTHER_AREA_LISTINGS.some((listing) => listing === value);
}
export const PUSH_TO_PROTECTED = ['ask', 'allow', 'lead', 'gated'];
export function isPushToProtected(value) {
    return PUSH_TO_PROTECTED.some((choice) => choice === value);
}
export const REVIEW_PATH_MODES = ['always', 'check'];
export function isReviewPathMode(value) {
    return REVIEW_PATH_MODES.some((mode) => mode === value);
}
export const REVIEW_CLASSES = ['security', 'leader'];
export function isReviewClass(value) {
    return REVIEW_CLASSES.some((reviewer) => reviewer === value);
}
export const AD_HOC_RUNNERS = ['deny', 'ask', 'allow'];
export function isAdHocRunners(value) {
    return AD_HOC_RUNNERS.some((choice) => choice === value);
}
export const PACKAGE_INSTALLS = ['deny', 'ask', 'allow'];
export function isPackageInstalls(value) {
    return PACKAGE_INSTALLS.some((choice) => choice === value);
}
export const SKIP_HOOKS = ['deny', 'ask', 'allow'];
export function isSkipHooks(value) {
    return SKIP_HOOKS.some((choice) => choice === value);
}
export const HOOK_ASKS = ['ask', 'refuse'];
export function isHookAsks(value) {
    return HOOK_ASKS.some((choice) => choice === value);
}
export const SECRET_READS = ['deny', 'ask', 'allow'];
export function isSecretReads(value) {
    return SECRET_READS.some((choice) => choice === value);
}
export const SECRET_WRITES = ['deny', 'ask', 'allow'];
export function isSecretWrites(value) {
    return SECRET_WRITES.some((choice) => choice === value);
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
export const ASK_WITH = ['text', 'picker'];
export function isAskWith(value) {
    return ASK_WITH.some((way) => way === value);
}
/**
 * Who may hire a session onto the team (`teamrig hire`): `off` nobody; `owner` a lead (the lead, or a sub-lead
 * into its own group), once the owner approved (`--approved-by`, kept with the hire); `lead` a lead; `automatic` as
 * `lead`, and a hired session whose last open task closes is asked to write its handover (hiring/last-task-ask.ts).
 * Under every policy only a lead over a session retires it (`teamrig retire`).
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
/**
 * What the idle pass does with a session it would close or reopen (src/cli/idle-pass.ts): `off` runs no pass,
 * `dry-run` logs each step it would take and takes none, `on` also starts each close and reopen its steps ask for.
 */
export const IDLE_MODES = ['off', 'dry-run', 'on'];
export function isIdleMode(value) {
    return IDLE_MODES.some((mode) => mode === value);
}
/** Claude Code's effort levels, lowest first: what `claude --effort` and `/effort` take. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function isEffortLevel(value) {
    return EFFORT_LEVELS.some((level) => level === value);
}
