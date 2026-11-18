import { GUARD_LIMIT_MS } from "./guard-runner.js";
/**
 * Each `hook <name>` command's time limit, in ms: what Claude Code gives it in plugins/teamrig/hooks/hooks.json (for a
 * guard that runs through guard-main.js, the runner's own shorter GUARD_LIMIT_MS, which blocks the call at its end), or
 * what the plugin's mod gives the hooks its hands run (src/mod/*-hand.ts); null for one run with no limit (the clear
 * hand's). The one place that knows them (#737): hook-timeouts.test.ts holds hooks.json and the hands to it, and
 * that every `hook` command has one.
 */
export const HOOK_TIMEOUT_MS = {
    'push-guard': GUARD_LIMIT_MS,
    'package-guard': GUARD_LIMIT_MS,
    'secret-guard': GUARD_LIMIT_MS,
    'db-write-guard': GUARD_LIMIT_MS,
    'exec-guard': GUARD_LIMIT_MS,
    'pass-record-guard': GUARD_LIMIT_MS,
    'service-role-guard': GUARD_LIMIT_MS,
    'cold-send': GUARD_LIMIT_MS,
    'helper-gate': GUARD_LIMIT_MS,
    'picker-guard': GUARD_LIMIT_MS,
    'failed-send': 15_000,
    'missing-cli': 15_000,
    'route-reminder': 15_000,
    'loop-nudge': 15_000,
    'secret-redact': 15_000,
    'inbox-reminder': 15_000,
    'session-start': 15_000,
    stop: 15_000,
    'subagent-start': 15_000,
    'subagent-stop': 15_000,
    'refresh-wake': 30_000,
    'restore-track': 15_000,
    'effort-writeback': 15_000,
    'tab-status': 15_000,
    'tool-end': 5_000,
    'readonly-allow': 15_000,
    'prompt-refuse': 15_000,
    'route-allow': 15_000,
    'pre-compact': 15_000,
    'clear-dir': null,
    'clear-claim': null,
    'wake-check': 30_000,
    'wake-dropped': 30_000,
    'meeting-due': 30_000,
    'meeting-panel': 30_000,
    'needs-you': 30_000,
    'needs-you-focus': 30_000,
    'update-check': 90_000,
    'update-dismiss': 90_000,
    'update-apply': 400_000,
    'refresh-mid': 15_000,
    'compact-check': 15_000,
    'slash-command': 180_000,
};
// A map, so a name such as `constructor` reads as no hook rather than the object's own fields.
const LIMITS = new Map(Object.entries(HOOK_TIMEOUT_MS));
/** The time a hook keeps after its last lock wait to print its output and exit, Node's start included. */
export const HOOK_OUTPUT_MARGIN_MS = 3_000;
/**
 * The time by which every lock wait of `hook <name>` (the command's name, `hook <name>`) started at `startedAt` gives
 * up, so a busy lock never outlasts the hook's time limit and the hook still prints its output (#737); undefined for
 * any other command, or a hook with no limit.
 */
export function hookLockDeadline(command, startedAt) {
    const name = command.startsWith('hook ') ? command.slice('hook '.length) : undefined;
    const limit = name === undefined ? undefined : LIMITS.get(name);
    return limit === undefined || limit === null ? undefined : startedAt + Math.max(0, limit - HOOK_OUTPUT_MARGIN_MS);
}
