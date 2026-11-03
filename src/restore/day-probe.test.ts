import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dayProbeClaimLine, dayProbeReleaseLine, formatDayProbe, gateDayProbe, parseDayProbe, releaseDayProbe, type DayProbe, type DayProbeGate, type DayProbeReply } from './day-probe.ts';
import { LOGIN_PROBE_STALE_MS } from './login.ts';

const TAB_A = '0123abcd-0000-4000-8000-00000000000a';
const TAB_B = '0123abcd-0000-4000-8000-00000000000b';
const MOMENT = Date.parse('2030-01-08T06:00:00Z');
const AT = MOMENT + 2_000;

/** The probe `tab` claimed at `at` for `moment`, with no reply yet. */
function probeOf(tab: string = TAB_A, at: number = AT, moment: number = MOMENT): DayProbe {
  return { moment, tab, at, releasedAt: undefined };
}

function reply(kind: DayProbeReply['kind'], tab: string, at: number): DayProbeReply {
  return { kind, tab, at };
}

/** A gate as its kind, with why a claim claims. */
function verdictOf(gate: DayProbeGate): string {
  return gate.kind === 'claim' ? `claim ${gate.why}` : gate.kind;
}

describe('day-start probe: the gate', () => {
  it('has the first due tab claim the probe for its moment, and holds the next until the claim goes stale', () => {
    const first = gateDayProbe(undefined, MOMENT, TAB_A, AT);
    assert.deepEqual(first, { kind: 'claim', why: 'first', probe: probeOf() });
    const probe = first.kind === 'claim' ? first.probe : undefined;
    assert.deepEqual(gateDayProbe(probe, MOMENT, TAB_B, AT + 1_000), { kind: 'hold', until: AT + LOGIN_PROBE_STALE_MS, probe });
  });

  it('wakes the probe tab again on its own claim when its wake did not turn, and still hands the probe over at the stale line', () => {
    assert.deepEqual(gateDayProbe(probeOf(), MOMENT, TAB_A, AT + 60_000), { kind: 'claim', why: 'again', probe: probeOf() }, 'the first claim keeps its time');
    assert.equal(verdictOf(gateDayProbe(probeOf(), MOMENT, TAB_A, AT + 10 * LOGIN_PROBE_STALE_MS)), 'claim again');
    assert.equal(verdictOf(gateDayProbe(probeOf(), MOMENT, TAB_B, AT + LOGIN_PROBE_STALE_MS)), 'claim stale', 'however often the probe tab asked again');
    assert.equal(verdictOf(gateDayProbe({ ...probeOf(), releasedAt: AT + 1_000 }, MOMENT, TAB_A, AT + 2_000)), 'free', 'a released probe frees its own tab too');
  });

  it('wakes every tab due for the moment once a reply released the probe', () => {
    const released = { ...probeOf(), releasedAt: AT + 15_000 };
    assert.deepEqual(gateDayProbe(released, MOMENT, TAB_B, AT + 20_000), { kind: 'free' });
    assert.deepEqual(gateDayProbe(released, MOMENT, TAB_B, AT + 10 * LOGIN_PROBE_STALE_MS), { kind: 'free' }, 'a released probe never goes stale');
  });

  it('hands a probe with no reply in time to the next due tab, for the same moment', () => {
    const stale = gateDayProbe(probeOf(), MOMENT, TAB_B, AT + LOGIN_PROBE_STALE_MS);
    assert.deepEqual(stale, { kind: 'claim', why: 'stale', probe: probeOf(TAB_B, AT + LOGIN_PROBE_STALE_MS) });
    assert.equal(verdictOf(gateDayProbe(probeOf(), MOMENT, TAB_B, AT + LOGIN_PROBE_STALE_MS - 1)), 'hold');
  });

  it("claims anew for a newer moment, and has a tab due for an older one follow the newer moment's probe", () => {
    const later = MOMENT + 30 * 60_000;
    assert.deepEqual(verdictOf(gateDayProbe({ ...probeOf(), releasedAt: AT + 1_000 }, later, TAB_B, later)), 'claim newer');
    const newer = probeOf(TAB_B, later, later);
    assert.equal(verdictOf(gateDayProbe(newer, MOMENT, TAB_A, later + 1_000)), 'hold');
    assert.equal(verdictOf(gateDayProbe({ ...newer, releasedAt: later + 5_000 }, MOMENT, TAB_A, later + 6_000)), 'free');
    const takenOver = gateDayProbe(newer, MOMENT, TAB_A, later + LOGIN_PROBE_STALE_MS);
    assert.equal(takenOver.kind === 'claim' ? takenOver.probe.moment : undefined, later, 'a stale claim keeps the newer moment');
  });
});

describe('day-start probe: the release', () => {
  it("is released by any tab's good turn end after the claim, and by the probe tab's tool end", () => {
    assert.deepEqual(releaseDayProbe(probeOf(), reply('answered', TAB_B, AT + 1)), { ...probeOf(), releasedAt: AT + 1 });
    assert.deepEqual(releaseDayProbe(probeOf(), reply('tool', TAB_A, AT + 12_000)), { ...probeOf(), releasedAt: AT + 12_000 });
  });

  it("stays out at another tab's tool end, a reply at or before the claim, and once released", () => {
    assert.equal(releaseDayProbe(probeOf(), reply('tool', TAB_B, AT + 12_000)), undefined, 'that tool may have been called before the claim');
    assert.equal(releaseDayProbe(probeOf(), reply('answered', TAB_B, AT)), undefined);
    assert.equal(releaseDayProbe({ ...probeOf(), releasedAt: AT + 1 }, reply('answered', TAB_B, AT + 2)), undefined, 'the first release stands');
    assert.equal(releaseDayProbe(undefined, reply('answered', TAB_B, AT + 2)), undefined);
  });

  it('logs who released it and how long after the claim', () => {
    const released = { ...probeOf(), releasedAt: AT + 12_400 };
    assert.equal(dayProbeReleaseLine(`app/alpha (${TAB_A})`, reply('tool', TAB_A, AT + 12_400), released), `day-probe: released, app/alpha (${TAB_A}) ran a tool 12 s after the claim`);
    assert.equal(dayProbeReleaseLine(TAB_B, reply('answered', TAB_B, AT + 30_000), released), `day-probe: released, ${TAB_B} ended a turn 30 s after the claim`);
  });
});

describe('day-start probe: the claim line', () => {
  it('logs which tab claimed it, for which moment, and why that tab', () => {
    const label = `app/alpha (${TAB_A})`;
    const lines = (['first', 'newer', 'again', 'stale'] as const).map((why) => dayProbeClaimLine(label, why, probeOf()));
    assert.deepEqual(lines, [
      `day-probe: claimed by ${label} for the moment at 2030-01-08T06:00:00.000Z, the first tab due`,
      `day-probe: claimed by ${label} for the moment at 2030-01-08T06:00:00.000Z, a newer moment than the last probe`,
      `day-probe: claimed by ${label} for the moment at 2030-01-08T06:00:00.000Z, its wake did not turn`,
      `day-probe: claimed by ${label} for the moment at 2030-01-08T06:00:00.000Z, the probe out had no reply in 5 min`,
    ]);
  });
});

describe('day-start probe: the file', () => {
  it('reads back what it wrote, released or not', () => {
    const released = { ...probeOf(), releasedAt: AT + 9_000 };
    assert.deepEqual(parseDayProbe(formatDayProbe(probeOf())), probeOf());
    assert.deepEqual(parseDayProbe(formatDayProbe(released)), released);
    assert.match(formatDayProbe(released), /"releasedAt": "2030-01-08T06:00:11.000Z"/);
  });

  it('reads a damaged file as no probe', () => {
    const good = { moment: '2030-01-08T06:00:00.000Z', tab: TAB_A, at: '2030-01-08T06:00:02.000Z' };
    assert.deepEqual(parseDayProbe(JSON.stringify(good)), probeOf(), 'the record the damaged ones start from reads');
    const damaged = ['{"moment": "soo', '[]', JSON.stringify({ ...good, tab: 'not a session' }), JSON.stringify({ ...good, at: 'soon' }), JSON.stringify({ ...good, releasedAt: 'soon' }), JSON.stringify({ ...good, moment: undefined })];
    assert.deepEqual(damaged.map(parseDayProbe), damaged.map(() => undefined));
  });
});
