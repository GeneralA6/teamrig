import { isRecord } from "../core/guards.js";
/**
 * The budget keys `budget setup` manages, in the order a preview lists them. No daily number among them: the
 * team's daily budget is the pace, recomputed at every reading.
 */
export const SETUP_KEYS = ['enabled', 'overAction', 'escalate', 'quietHours'];
/** Leaves a key as the config has it. */
const KEEP = Symbol('keep');
/** The quiet hours a config already has, with its action, or undefined. */
function quietHoursOf(budget) {
    const quiet = budget['quietHours'];
    if (!isRecord(quiet)) {
        return undefined;
    }
    const { startUtc, endUtc } = quiet;
    return typeof startUtc === 'string' && typeof endUtc === 'string' ? { window: { startUtc, endUtc }, action: quiet['action'] } : undefined;
}
/** The next `quietHours` value: undefined removes it; KEEP leaves it as it is. */
function nextQuietHours(budget, choices) {
    const { quiet, quietAction } = choices;
    if (quiet === 'off') {
        return quietAction === undefined ? { ok: true, value: undefined } : { ok: false, problem: '--quiet-action needs quiet hours, not --quiet off' };
    }
    if (quiet === undefined && quietAction === undefined) {
        return { ok: true, value: KEEP };
    }
    const current = quietHoursOf(budget);
    const window = quiet ?? current?.window;
    if (window === undefined) {
        return { ok: false, problem: '--quiet-action needs --quiet <HH:MM-HH:MM>: the team has no quiet hours yet' };
    }
    const action = quietAction ?? current?.action;
    if (action === undefined) {
        return { ok: false, problem: '--quiet needs --quiet-action <warn|ask-lead|ask|block>: the team has no quiet hours yet' };
    }
    return { ok: true, value: { startUtc: window.startUtc, endUtc: window.endUtc, action } };
}
/** Sets `key` to `value`, or removes it for undefined; KEEP leaves it. */
function apply(budget, key, value) {
    if (value === KEEP) {
        return;
    }
    if (value === undefined) {
        delete budget[key];
        return;
    }
    budget[key] = value;
}
function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
/** The config with the choices written into its `budget` block, and what that changes per key. */
export function planBudgetSetup(config, choices) {
    const before = isRecord(config['budget']) ? config['budget'] : {};
    const quietHours = nextQuietHours(before, choices);
    if (!quietHours.ok) {
        return quietHours;
    }
    const budget = { ...before };
    apply(budget, 'enabled', choices.enabled);
    apply(budget, 'overAction', choices.overAction ?? KEEP);
    apply(budget, 'escalate', choices.escalate ?? KEEP);
    apply(budget, 'quietHours', quietHours.value);
    const keys = SETUP_KEYS.map((key) => ({ key, from: before[key], to: budget[key], changed: !sameValue(before[key], budget[key]) }));
    return { ok: true, value: { config: { ...config, budget }, keys } };
}
