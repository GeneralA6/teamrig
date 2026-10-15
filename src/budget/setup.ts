import type { Escalation, OverAction } from '../config/types.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import type { Checked } from '../setup/team-create.ts';

/**
 * The plan behind `budget setup`: the team's budget policy written into its config file. Pure: it takes
 * the file's JSON and the person's choices and returns the next JSON with one entry per policy key, so
 * the command can show a preview before it writes anything. The values are checked afterwards by the
 * config parser every command reads with, so the rules live in one place.
 */

/** The quiet hours' window, as UTC `HH:MM` times. */
export interface QuietWindow {
  readonly startUtc: string;
  readonly endUtc: string;
}

/** What `budget setup` sets; a choice left undefined keeps the config's value. */
export interface BudgetChoices {
  readonly enabled: boolean;
  /** A fixed percent of the week per day, or `pace`: worked out each midnight from what is left. */
  readonly daily?: number | 'pace' | undefined;
  /** The most a `pace` day may get, or `none`. */
  readonly maxDaily?: number | 'none' | undefined;
  readonly overAction?: OverAction | undefined;
  readonly escalate?: Escalation | undefined;
  readonly quiet?: QuietWindow | 'off' | undefined;
  readonly quietAction?: OverAction | undefined;
}

/** The budget keys `budget setup` manages, in the order a preview lists them. */
export const SETUP_KEYS = ['enabled', 'dailyPct', 'maxDailyPct', 'overAction', 'escalate', 'quietHours'] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];

export interface KeyChange {
  readonly key: SetupKey;
  /** Undefined when the key is not set, so its default applies. */
  readonly from: unknown;
  readonly to: unknown;
  readonly changed: boolean;
}

export interface BudgetSetupPlan {
  /** The whole next config file. */
  readonly config: JsonRecord;
  readonly keys: readonly KeyChange[];
}

/** Leaves a key as the config has it. */
const KEEP: unique symbol = Symbol('keep');

/** The quiet hours a config already has, with its action, or undefined. */
function quietHoursOf(budget: JsonRecord): { readonly window: QuietWindow; readonly action: unknown } | undefined {
  const quiet = budget['quietHours'];
  if (!isRecord(quiet)) {
    return undefined;
  }
  const { startUtc, endUtc } = quiet;
  return typeof startUtc === 'string' && typeof endUtc === 'string' ? { window: { startUtc, endUtc }, action: quiet['action'] } : undefined;
}

/** The next `quietHours` value: undefined removes it; KEEP leaves it as it is. */
function nextQuietHours(budget: JsonRecord, choices: BudgetChoices): Checked<JsonRecord | undefined | typeof KEEP> {
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
function apply(budget: Record<string, unknown>, key: SetupKey, value: unknown): void {
  if (value === KEEP) {
    return;
  }
  if (value === undefined) {
    delete budget[key];
    return;
  }
  budget[key] = value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The config with the choices written into its `budget` block, and what that changes per key. */
export function planBudgetSetup(config: JsonRecord, choices: BudgetChoices): Checked<BudgetSetupPlan> {
  const before = isRecord(config['budget']) ? config['budget'] : {};
  const quietHours = nextQuietHours(before, choices);
  if (!quietHours.ok) {
    return quietHours;
  }
  const budget: Record<string, unknown> = { ...before };
  apply(budget, 'enabled', choices.enabled);
  apply(budget, 'dailyPct', choices.daily === undefined ? KEEP : choices.daily === 'pace' ? undefined : choices.daily);
  apply(budget, 'maxDailyPct', choices.maxDaily === undefined ? KEEP : choices.maxDaily === 'none' ? undefined : choices.maxDaily);
  apply(budget, 'overAction', choices.overAction ?? KEEP);
  apply(budget, 'escalate', choices.escalate ?? KEEP);
  apply(budget, 'quietHours', quietHours.value);
  const keys = SETUP_KEYS.map((key) => ({ key, from: before[key], to: budget[key], changed: !sameValue(before[key], budget[key]) }));
  return { ok: true, value: { config: { ...config, budget }, keys } };
}
