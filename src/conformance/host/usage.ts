import assert from 'node:assert/strict';
import type { CallUsage, RateWindow, UsageMeter } from '../../plugin-api/index.ts';
import { defineContract, type ContractCase, type Subject } from '../contract.ts';

/** The windows a case has the plan tell: each one given is told, each one left out is not. */
export interface WorldLimits {
  readonly week?: RateWindow;
  readonly fiveHour?: RateWindow;
}

/**
 * What a usage meter sees of the host: the status input that tells the plan's reading. A case hands the meter a
 * call's usage in the shape the transcript reader gives every host's, so the world holds no transcript line; only the
 * status input is the host's own text, which the world writes for the windows a case names.
 */
export interface UsageWorld {
  /** The host's status input of a session whose plan tells these windows, and no other. */
  readonly status: (limits: WorldLimits) => string;
}

export type UsageSubject = Subject<UsageMeter, UsageWorld>;
export type UsageCase = ContractCase<UsageMeter, UsageWorld, 'host'>;

const KINDS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnsplit', 'cacheRead', 'output'] as const satisfies readonly (keyof CallUsage)[];

/** The kinds the model was sent; the output is what it wrote back. */
const SENT = KINDS.filter((kind) => kind !== 'output');

const NONE: CallUsage = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, cacheRead: 0, output: 0 };
const MIXED: CallUsage = { input: 40, cacheWrite5m: 80, cacheWrite1h: 100, cacheWriteUnsplit: 200, cacheRead: 10_000, output: 300 };

/** A call that used `count` tokens of one kind and nothing else. */
function only(kind: keyof CallUsage, count: number): CallUsage {
  return { ...NONE, [kind]: count };
}

/** Two windows no liar's fixed answer equals; their resets are whole seconds, the finest a host's input may hold. */
const WEEK: RateWindow = { usedPct: 57, resetsAt: 1_900_000_400_000 };
const FIVE_HOUR: RateWindow = { usedPct: 6, resetsAt: 1_900_000_000_000 };

/** Whether two prices are one number, a rounding step of the sum apart at most. */
function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
}

const CASES: readonly UsageCase[] = [
  {
    id: 'usage.unused-call-free',
    title: 'prices a call that used no token at nothing, and reads its context as empty',
    features: ['budget.usage', 'context.size'],
    run: ({ port }) => {
      assert.equal(port.ofCall(NONE), 0);
      assert.equal(port.contextReading(NONE), 0);
    },
  },
  {
    id: 'usage.kinds-priced',
    title: 'gives every kind of token a price that is a number and never below nothing, one kind at least above it',
    features: ['budget.usage'],
    run: ({ port }) => {
      const prices = KINDS.map((kind) => port.weights[kind]);
      assert.ok(prices.every((price) => Number.isFinite(price) && price >= 0), JSON.stringify(port.weights));
      assert.ok(prices.some((price) => price > 0), 'no kind of token costs anything');
    },
  },
  {
    id: 'usage.call-sums-its-kinds',
    title: 'prices a call as the sum of its tokens, each kind at the price the meter names for it',
    features: ['budget.usage'],
    run: ({ port }) => {
      for (const kind of KINDS) {
        const cost = port.ofCall(only(kind, 12));
        assert.ok(near(cost, 12 * port.weights[kind]), `12 ${kind} tokens cost ${cost}, at a named price of ${port.weights[kind]} each`);
      }
      const sum = KINDS.reduce((total, kind) => total + MIXED[kind] * port.weights[kind], 0);
      assert.ok(near(port.ofCall(MIXED), sum), `a mixed call cost ${port.ofCall(MIXED)}, its kinds ${sum}`);
    },
  },
  {
    id: 'usage.tool-output-sized',
    title: 'says how many characters of tool output make one token, a number above nothing',
    features: ['budget.usage'],
    run: ({ port }) => {
      assert.ok(Number.isFinite(port.charsPerToken) && port.charsPerToken > 0, String(port.charsPerToken));
    },
  },
  {
    id: 'usage.context-counts-sent',
    title: 'reads tokens the model was sent, cached or not, as context',
    features: ['context.size'],
    run: ({ port }) => {
      for (const kind of SENT) {
        assert.ok(port.contextReading(only(kind, 12)) > 0, `12 ${kind} tokens read as no context`);
      }
    },
  },
  {
    id: 'usage.context-leaves-output',
    title: "leaves the reply's output out of the context the call read",
    features: ['context.size'],
    run: ({ port }) => {
      assert.equal(port.contextReading(only('output', 300)), 0);
      assert.equal(port.contextReading(MIXED), port.contextReading({ ...MIXED, output: 0 }));
    },
  },
  {
    id: 'usage.week-read',
    title: "reads the week's use and reset the status input tells",
    features: ['budget.week-reading'],
    run: ({ port, world }) => {
      assert.deepEqual(port.weekReading(world.status({ week: WEEK }))?.sevenDay, WEEK);
      assert.deepEqual(port.weekReading(world.status({ week: WEEK, fiveHour: FIVE_HOUR }))?.sevenDay, WEEK);
    },
  },
  {
    id: 'usage.week-none',
    title: 'has no reading when the status input tells no window, never a week of its own making',
    features: ['budget.week-reading'],
    run: ({ port, world }) => {
      assert.equal(port.weekReading(world.status({})), undefined);
      assert.equal(port.weekReading(world.status({ fiveHour: FIVE_HOUR }))?.sevenDay ?? null, null);
    },
  },
  {
    id: 'usage.five-hour-read',
    title: "reads the five-hour window's use and reset the status input tells",
    features: ['budget.five-hour'],
    run: ({ port, world }) => {
      assert.deepEqual(port.weekReading(world.status({ fiveHour: FIVE_HOUR }))?.fiveHour, FIVE_HOUR);
      assert.deepEqual(port.weekReading(world.status({ week: WEEK, fiveHour: FIVE_HOUR }))?.fiveHour, FIVE_HOUR);
    },
  },
  {
    id: 'usage.five-hour-none',
    title: 'reads a plan that tells its week alone as having no five-hour window',
    features: ['budget.five-hour'],
    run: ({ port, world }) => {
      assert.equal(port.weekReading(world.status({ week: WEEK }))?.fiveHour ?? null, null);
    },
  },
];

/** The liars' world: they read no input, so it writes none. */
const WORLD: UsageWorld = { status: () => '' };

/** A liar that claims the port and meters nothing: every price, every call and every context is 0, and no plan tells a reading. */
export function nothingUsage(): UsageSubject {
  return { world: WORLD, port: { weights: NONE, charsPerToken: 0, ofCall: () => 0, contextReading: () => 0, weekReading: () => undefined } };
}

/**
 * A liar that says yes to all: a call costs 1 whatever it used, everything in it, its output too, is context, and
 * every status input tells both windows, full.
 */
export function yesUsage(): UsageSubject {
  const weights = { input: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheWriteUnsplit: 1, cacheRead: 1, output: 1 };
  const all = (usage: CallUsage): number => KINDS.reduce((total, kind) => total + usage[kind], 0);
  const full: RateWindow = { usedPct: 100, resetsAt: 1 };
  return { world: WORLD, port: { weights, charsPerToken: 1, ofCall: () => 1, contextReading: all, weekReading: () => ({ fiveHour: full, sevenDay: full }) } };
}

/** What every host's usage meter must do with a call's usage. */
export const USAGE_CONTRACT = defineContract<UsageMeter, UsageWorld, 'host'>({
  port: 'usage',
  side: 'host',
  cases: CASES,
  liars: [nothingUsage, yesUsage],
});
