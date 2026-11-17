import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { admissionOrder, agedPriority, isAdmissionMode, laneOf, placeInLine, UNNAMED_PRIORITY, type AdmissionRules, type InLine, type RunningStep } from './admission.ts';
import type { StepKind } from './process-request.ts';
import type { WaitCause } from './wait-cause.ts';

const MINUTE = 60_000;
const NOW = Date.parse('2026-11-08T12:00:00.000Z');

const PIPELINE: AdmissionRules = { mode: 'pipeline', agingMinutes: 15, memoryPassMinutes: 15, perSessionRunning: 2, maxHeavyParallel: 2, maxSmallParallel: 4, defaultClass: 'Improvements' };
const SERIAL: AdmissionRules = { ...PIPELINE, mode: 'serial' };

const NO_TURNS: ReadonlyMap<string, number> = new Map();

/** The steps running now: `counts` heavy steps of each session, then `small` small steps of each. */
function runs(counts: Readonly<Record<string, number>>, small: Readonly<Record<string, number>> = {}): RunningStep[] {
  const steps = (by: Readonly<Record<string, number>>, isSmall: boolean): RunningStep[] => Object.entries(by).flatMap(([session, count]) => Array.from({ length: count }, () => ({ session, small: isSmall })));
  return [...steps(counts, false), ...steps(small, true)];
}

interface Asked {
  readonly session?: string;
  readonly waitedMinutes?: number;
  readonly priority?: number;
  readonly class?: string;
  /** Its step's kind, on its request; a request is made for it with the default class when no class is given. */
  readonly kind?: StepKind;
  /** Whether its step is small (`--small`), on its request: true puts it in the small line, false in the heavy one. */
  readonly small?: boolean;
  /** When its task was put at the front of the line, this many minutes before NOW, on its request. */
  readonly frontedMinutes?: number;
  /** What its last look found it waiting on, for this many minutes before NOW. */
  readonly waitingOn?: { readonly reason: WaitCause; readonly forMinutes: number };
}

/** A ticket that arrived `waitedMinutes` before NOW, its name in arrival order like the line's; a request only when a class or kind is given. */
function ticket(id: string, asked: Asked = {}): InLine {
  const arrived = NOW - (asked.waitedMinutes ?? 0) * MINUTE;
  const asks = asked.class !== undefined || asked.kind !== undefined || asked.small !== undefined || asked.frontedMinutes !== undefined;
  const request = asks
    ? {
        class: asked.class ?? PIPELINE.defaultClass,
        ...(asked.priority === undefined ? {} : { priority: asked.priority }),
        ...(asked.kind === undefined ? {} : { kind: asked.kind }),
        ...(asked.small === undefined ? {} : { heavy: !asked.small }),
        ...(asked.frontedMinutes === undefined ? {} : { frontAt: new Date(NOW - asked.frontedMinutes * MINUTE).toISOString() }),
      }
    : undefined;
  const waitingOn = asked.waitingOn === undefined ? undefined : { reason: asked.waitingOn.reason, since: new Date(NOW - asked.waitingOn.forMinutes * MINUTE).toISOString() };
  return {
    name: `${String(arrived).padStart(15, '0')}-${id}.json`,
    waiter: {
      session: asked.session ?? 'alpha',
      arrivedAt: new Date(arrived).toISOString(),
      ...(request === undefined ? {} : { request }),
      ...(waitingOn === undefined ? {} : { waitingOn }),
    },
  };
}

function idsOf(line: readonly InLine[]): string[] {
  return line.map((entry) => entry.name.replace(/^\d+-/, '').replace(/\.json$/, ''));
}

describe('isAdmissionMode', () => {
  it('takes pipeline and serial only', () => {
    assert.deepEqual(['pipeline', 'serial', 'fifo', undefined].map(isAdmissionMode), [true, true, false, false]);
  });
});

describe('agedPriority', () => {
  it('raises a priority one level per agingMinutes waited, never to p0', () => {
    assert.deepEqual(
      [0, 14, 15, 29, 30, 45, 600].map((minutes) => agedPriority(3, minutes * MINUTE, 15)),
      [3, 3, 2, 2, 1, 1, 1],
    );
  });

  it('keeps p0 at p0 and counts a step with no priority at p2', () => {
    assert.equal(agedPriority(0, 600 * MINUTE, 15), 0);
    assert.equal(agedPriority(undefined, 0, 15), UNNAMED_PRIORITY);
    assert.equal(agedPriority(undefined, 15 * MINUTE, 15), 1);
  });

  it('ages nothing with agingMinutes 0, and reads a clock that went back as no wait', () => {
    assert.equal(agedPriority(3, 600 * MINUTE, 0), 3);
    assert.equal(agedPriority(3, -60 * MINUTE, 15), 3);
  });
});

describe('admissionOrder', () => {
  it('keeps arrival order in serial mode and without rules, whatever the tickets ask', () => {
    const line = [ticket('late-p0', { waitedMinutes: 1, priority: 0, class: 'Roadmap' }), ticket('early-p3', { waitedMinutes: 5, priority: 3, class: 'Improvements' })];
    assert.deepEqual(idsOf(admissionOrder(line, NOW, SERIAL, NO_TURNS)), ['early-p3', 'late-p0']);
    assert.deepEqual(idsOf(admissionOrder(line, NOW, undefined, NO_TURNS)), ['early-p3', 'late-p0']);
  });

  it('puts p0 steps first, in arrival order, before any class turn or priority', () => {
    const line = [
      ticket('roadmap-p1', { waitedMinutes: 9, priority: 1, class: 'Roadmap' }),
      ticket('p0-later', { waitedMinutes: 2, priority: 0, class: 'Improvements' }),
      ticket('p0-first', { waitedMinutes: 3, priority: 0, class: 'Maintenance' }),
    ];
    const turns = new Map([['Roadmap', 0], ['Improvements', 50], ['Maintenance', 90]]);
    assert.deepEqual(idsOf(admissionOrder(line, NOW, PIPELINE, turns)), ['p0-first', 'p0-later', 'roadmap-p1']);
  });

  it("puts the steps of a task its lead put at the front before p0 ones, the earliest front first; serial mode keeps arrival order (T4082)", () => {
    const line = [
      ticket('p0', { waitedMinutes: 9, priority: 0, class: 'Roadmap' }),
      ticket('p1', { waitedMinutes: 8, priority: 1, class: 'Roadmap' }),
      ticket('fronted-later', { waitedMinutes: 2, priority: 2, class: 'Improvements', frontedMinutes: 1 }),
      ticket('fronted-first', { waitedMinutes: 1, priority: 2, class: 'Improvements', frontedMinutes: 5 }),
    ];
    assert.deepEqual(idsOf(admissionOrder(line, NOW, PIPELINE, NO_TURNS)), ['fronted-first', 'fronted-later', 'p0', 'p1']);
    assert.deepEqual(idsOf(admissionOrder(line, NOW, SERIAL, NO_TURNS)), ['p0', 'p1', 'fronted-later', 'fronted-first']);
  });

  it('orders by priority inside a class, then by arrival', () => {
    const line = [
      ticket('p3-oldest', { waitedMinutes: 10, priority: 3, class: 'Roadmap' }),
      ticket('p1-new', { waitedMinutes: 1, priority: 1, class: 'Roadmap' }),
      ticket('p1-older', { waitedMinutes: 2, priority: 1, class: 'Roadmap' }),
    ];
    assert.deepEqual(idsOf(admissionOrder(line, NOW, PIPELINE, NO_TURNS)), ['p1-older', 'p1-new', 'p3-oldest']);
  });

  it('lets a step that waited agingMinutes per level catch up with a more urgent later one', () => {
    const line = [ticket('p3-waited-30', { waitedMinutes: 30, priority: 3, class: 'Roadmap' }), ticket('p1-new', { waitedMinutes: 0, priority: 1, class: 'Roadmap' })];
    assert.deepEqual(idsOf(admissionOrder(line, NOW, PIPELINE, NO_TURNS)), ['p3-waited-30', 'p1-new']);
    const younger = [ticket('p3-waited-29', { waitedMinutes: 29, priority: 3, class: 'Roadmap' }), ticket('p1-new', { waitedMinutes: 0, priority: 1, class: 'Roadmap' })];
    assert.deepEqual(idsOf(admissionOrder(younger, NOW, PIPELINE, NO_TURNS)), ['p1-new', 'p3-waited-29']);
  });

  it('counts a ticket with no request as the default class at p2', () => {
    const line = [ticket('older-kit', { waitedMinutes: 5 }), ticket('improvements-p1', { waitedMinutes: 1, priority: 1, class: 'Improvements' }), ticket('improvements-p3', { waitedMinutes: 2, priority: 3, class: 'Improvements' })];
    assert.deepEqual(idsOf(admissionOrder(line, NOW, PIPELINE, NO_TURNS)), ['improvements-p1', 'older-kit', 'improvements-p3']);
  });

  it('takes the class with the least virtual time first, whatever its priorities', () => {
    const line = [ticket('roadmap-p1', { waitedMinutes: 5, priority: 1, class: 'Roadmap' }), ticket('maintenance-p3', { waitedMinutes: 1, priority: 3, class: 'Maintenance' })];
    const turns = new Map([['Roadmap', 4], ['Maintenance', 2]]);
    assert.deepEqual(idsOf(admissionOrder(line, NOW, PIPELINE, turns)), ['maintenance-p3', 'roadmap-p1']);
  });

  it('starts a class the turns lack at the least virtual time of the waiting classes, so it banks no turns while idle', () => {
    const line = [ticket('roadmap', { waitedMinutes: 5, priority: 2, class: 'Roadmap' }), ticket('new-class', { waitedMinutes: 1, priority: 2, class: 'Maintenance' })];
    const turns = new Map([['Roadmap', 7], ['Improvements', 1]]);
    assert.deepEqual(idsOf(admissionOrder(line, NOW, PIPELINE, turns)), ['roadmap', 'new-class']);
  });

  it('leaves the line it was given as it was', () => {
    const line = [ticket('b', { waitedMinutes: 1 }), ticket('a', { waitedMinutes: 2 })];
    admissionOrder(line, NOW, PIPELINE, NO_TURNS);
    assert.deepEqual(idsOf(line), ['b', 'a']);
  });
});

describe('placeInLine', () => {
  const order = [ticket('first', { session: 'alpha', waitedMinutes: 3 }), ticket('second', { session: 'beta', waitedMinutes: 2 }), ticket('third', { session: 'bravo', waitedMinutes: 1 })];

  it('names every waiter ordered before it as ahead while no session is at its cap', () => {
    assert.deepEqual(idsOf(placeInLine(order, order[2]?.name ?? '', runs({ alpha: 1 }), PIPELINE, NOW)?.ahead ?? []), ['first', 'second']);
  });

  it('passes a waiter whose session runs perSessionRunning steps', () => {
    const place = placeInLine(order, order[2]?.name ?? '', runs({ alpha: 2 }), PIPELINE, NOW);
    assert.equal(place?.kind, 'inLine');
    assert.deepEqual(idsOf(place?.ahead ?? []), ['second']);
  });

  it('waits on its own session cap, with the running count, while it passes no one', () => {
    const place = placeInLine(order, order[1]?.name ?? '', runs({ beta: 3 }), PIPELINE, NOW);
    assert.deepEqual(place === undefined ? undefined : { ...place, ahead: idsOf(place.ahead) }, { kind: 'sessionCap', ahead: ['first'], running: 3, cap: 2 });
  });

  it('counts only heavy steps toward a session cap (T3286)', () => {
    const place = placeInLine(order, order[1]?.name ?? '', runs({ beta: 1 }, { beta: 5 }), PIPELINE, NOW);
    assert.equal(place?.kind, 'inLine');
    assert.deepEqual(idsOf(place?.ahead ?? []), ['first']);
  });

  it('caps no session in serial mode, without rules, or with perSessionRunning 0', () => {
    const running = runs({ alpha: 5, bravo: 5 });
    for (const rules of [SERIAL, undefined, { ...PIPELINE, perSessionRunning: 0 }]) {
      const place = placeInLine(order, order[2]?.name ?? '', running, rules, NOW);
      assert.equal(place?.kind, 'inLine');
      assert.deepEqual(idsOf(place?.ahead ?? []), ['first', 'second']);
    }
  });

  it('is undefined for a ticket not in line', () => {
    assert.equal(placeInLine(order, 'gone.json', [], PIPELINE, NOW), undefined);
  });

  describe('the small and the heavy line (T3286)', () => {
    const line = [
      ticket('heavy-1', { session: 'alpha', waitedMinutes: 300, small: false }),
      ticket('old-kit', { session: 'alpha', waitedMinutes: 200 }),
      ticket('small-1', { session: 'beta', waitedMinutes: 100, small: true }),
      ticket('heavy-2', { session: 'gamma', waitedMinutes: 50, small: false }),
      ticket('small-2', { session: 'beta', waitedMinutes: 1, small: true }),
    ];
    const placeOf = (id: string, running: readonly RunningStep[], rules: AdmissionRules | undefined): { kind: string; ahead: string[] } | undefined => {
      const place = placeInLine(line, line.find((entry) => idsOf([entry])[0] === id)?.name ?? '', running, rules, NOW);
      return place === undefined ? undefined : { kind: place.kind, ahead: idsOf(place.ahead) };
    };

    it('puts a small step only behind the small steps ahead of it, however many heavy ones wait', () => {
      assert.deepEqual(placeOf('small-1', [], PIPELINE), { kind: 'inLine', ahead: [] });
      assert.deepEqual(placeOf('small-2', [], PIPELINE), { kind: 'inLine', ahead: ['small-1'] });
    });

    it('puts a heavy step only behind the heavy steps ahead of it, a ticket naming no request among them', () => {
      assert.deepEqual(placeOf('heavy-2', [], PIPELINE), { kind: 'inLine', ahead: ['heavy-1', 'old-kit'] });
    });

    it('never holds a small step on its session cap, as the cap counts heavy steps', () => {
      assert.deepEqual(placeOf('small-2', runs({ beta: 2 }, { beta: 3 }), PIPELINE), { kind: 'inLine', ahead: ['small-1'] });
    });

    it('keeps one line in arrival order in serial mode and without rules', () => {
      for (const rules of [SERIAL, undefined]) {
        assert.deepEqual(placeOf('small-1', [], rules), { kind: 'inLine', ahead: ['heavy-1', 'old-kit'] });
      }
    });

    it('reads a ticket as small only when its request says its step is not heavy', () => {
      assert.deepEqual(line.map(({ waiter }) => laneOf(waiter)), ['heavy', 'heavy', 'small', 'heavy', 'small']);
    });
  });

  describe('a waiter on the host memory (T2757)', () => {
    const behind = (waitingOn: Asked['waitingOn']): InLine[] => [ticket('heavy', { session: 'alpha', waitedMinutes: 90, ...(waitingOn === undefined ? {} : { waitingOn }) }), ticket('later', { session: 'beta', waitedMinutes: 1 })];
    const aheadOf = (line: readonly InLine[], running: readonly RunningStep[], rules: AdmissionRules | undefined): string[] => idsOf(placeInLine(line, line[1]?.name ?? '', running, rules, NOW)?.ahead ?? []);
    const SHARE_RUNS = runs({ charlie: 1 });

    it('is passed whatever its wait while no queued step runs, as only memory outside the queue holds it', () => {
      assert.deepEqual(aheadOf(behind({ reason: 'memory', forMinutes: 600 }), [], PIPELINE), []);
      assert.deepEqual(aheadOf(behind({ reason: 'commit', forMinutes: 600 }), runs({ charlie: 0 }), PIPELINE), []);
    });

    it('counts a small step running as a queued step whose end frees room, so a long memory wait holds the line (T3286)', () => {
      assert.deepEqual(aheadOf(behind({ reason: 'memory', forMinutes: 15 }), runs({}, { charlie: 1 }), PIPELINE), ['heavy']);
    });

    it('is passed while queued steps run, for its first memoryPassMinutes of the wait', () => {
      assert.deepEqual(aheadOf(behind({ reason: 'memory', forMinutes: 14 }), SHARE_RUNS, PIPELINE), []);
      assert.deepEqual(aheadOf(behind({ reason: 'commit', forMinutes: 0 }), SHARE_RUNS, PIPELINE), []);
    });

    it('holds the line once it waited memoryPassMinutes while a queued step runs, so the room that step frees goes to it', () => {
      assert.deepEqual(aheadOf(behind({ reason: 'memory', forMinutes: 15 }), SHARE_RUNS, PIPELINE), ['heavy']);
      assert.deepEqual(aheadOf(behind({ reason: 'memory', forMinutes: 2 }), SHARE_RUNS, { ...PIPELINE, memoryPassMinutes: 1 }), ['heavy']);
    });

    it('is never passed while it waits on anything else, or before its first look', () => {
      for (const reason of ['lock', 'line', 'draining', 'cpu', 'heavyCap', 'session'] as const) {
        assert.deepEqual(aheadOf(behind({ reason, forMinutes: 0 }), [], PIPELINE), ['heavy'], reason);
      }
      assert.deepEqual(aheadOf(behind(undefined), [], PIPELINE), ['heavy']);
    });

    it('is never passed with memoryPassMinutes 0, in serial mode or without rules', () => {
      for (const rules of [{ ...PIPELINE, memoryPassMinutes: 0 }, SERIAL, undefined]) {
        assert.deepEqual(aheadOf(behind({ reason: 'memory', forMinutes: 0 }), [], rules), ['heavy']);
      }
    });

    it('is passed with perSessionRunning 0 too, which caps no session', () => {
      assert.deepEqual(aheadOf(behind({ reason: 'memory', forMinutes: 0 }), SHARE_RUNS, { ...PIPELINE, perSessionRunning: 0 }), []);
    });

    it('still leaves a step whose own session is at its cap waiting on that cap', () => {
      const line = behind({ reason: 'memory', forMinutes: 0 });
      const place = placeInLine(line, line[1]?.name ?? '', runs({ beta: 2 }), PIPELINE, NOW);
      assert.deepEqual(place === undefined ? undefined : { ...place, ahead: idsOf(place.ahead) }, { kind: 'sessionCap', ahead: [], running: 2, cap: 2 });
    });
  });

  describe('a waiter on the ship slot (T2727)', () => {
    const behind = (kind: StepKind | undefined, reason: WaitCause = 'shipSlot'): InLine[] => [
      ticket('ship', { session: 'alpha', waitedMinutes: 30, kind: 'ship', waitingOn: { reason, forMinutes: 20 } }),
      ticket('later', { session: 'beta', waitedMinutes: 1, ...(kind === undefined ? {} : { kind }) }),
    ];
    const aheadOf = (line: readonly InLine[], rules: AdmissionRules | undefined): string[] => idsOf(placeInLine(line, line[1]?.name ?? '', runs({ charlie: 1 }), rules, NOW)?.ahead ?? []);

    it('is passed by a step that holds no ship slot, or names no kind, as the slot keeps it out whatever ends', () => {
      assert.deepEqual(aheadOf(behind('build'), PIPELINE), []);
      assert.deepEqual(aheadOf(behind('test'), PIPELINE), []);
      assert.deepEqual(aheadOf(behind('push'), PIPELINE), []);
      assert.deepEqual(aheadOf(behind(undefined), PIPELINE), []);
    });

    it('is never passed by another step that holds the slot, so ships take it in their order', () => {
      for (const kind of ['ship', 'merge', 'deploy'] as const) {
        assert.deepEqual(aheadOf(behind(kind), PIPELINE), ['ship'], kind);
      }
    });

    it('is never passed in serial mode or without rules', () => {
      assert.deepEqual(aheadOf(behind('build'), SERIAL), ['ship']);
      assert.deepEqual(aheadOf(behind('build'), undefined), ['ship']);
    });

    it('holds a later step back while it waits on anything else', () => {
      assert.deepEqual(aheadOf(behind('build', 'heavyCap'), PIPELINE), ['ship']);
    });

    it('lets a step that holds no slot pass every ship waiting behind the one on the slot, whatever its own reason (T3336)', () => {
      const line: InLine[] = [
        ticket('early', { session: 'delta', waitedMinutes: 40, kind: 'merge', waitingOn: { reason: 'heavyCap', forMinutes: 0 } }),
        ticket('ship', { session: 'alpha', waitedMinutes: 30, kind: 'ship', waitingOn: { reason: 'shipSlot', forMinutes: 20 } }),
        ticket('ship2', { session: 'gamma', waitedMinutes: 20, kind: 'ship', waitingOn: { reason: 'line', forMinutes: 10 } }),
        ticket('merge2', { session: 'gamma', waitedMinutes: 15, kind: 'merge', waitingOn: { reason: 'memory', forMinutes: 5 } }),
        ticket('build', { session: 'epsilon', waitedMinutes: 12, kind: 'build', waitingOn: { reason: 'line', forMinutes: 5 } }),
        ticket('later', { session: 'beta', waitedMinutes: 1, kind: 'test' }),
      ];
      const ahead = (id: string): string[] => {
        const name = line.find((entry) => idsOf([entry])[0] === id)?.name ?? '';
        return idsOf(placeInLine(line, name, runs({ charlie: 1 }), PIPELINE, NOW)?.ahead ?? []);
      };
      assert.deepEqual(ahead('later'), ['early', 'build'], 'a ship ahead of the slot waiter still holds it back');
      assert.deepEqual(ahead('merge2'), ['early', 'ship', 'ship2'], 'ships keep their order');
    });
  });
});
