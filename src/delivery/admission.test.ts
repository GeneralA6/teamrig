import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { admissionOrder, agedPriority, isAdmissionMode, placeInLine, UNNAMED_PRIORITY, type AdmissionRules, type InLine } from './admission.ts';

const MINUTE = 60_000;
const NOW = Date.parse('2026-11-08T12:00:00.000Z');

const PIPELINE: AdmissionRules = { mode: 'pipeline', agingMinutes: 15, perSessionRunning: 2, maxHeavyParallel: 2, defaultClass: 'Improvements' };
const SERIAL: AdmissionRules = { ...PIPELINE, mode: 'serial' };

const NO_TURNS: ReadonlyMap<string, number> = new Map();

interface Asked {
  readonly session?: string;
  readonly waitedMinutes?: number;
  readonly priority?: number;
  readonly class?: string;
}

/** A ticket that arrived `waitedMinutes` before NOW, its name in arrival order like the line's; a request only when a class is given. */
function ticket(id: string, asked: Asked = {}): InLine {
  const arrived = NOW - (asked.waitedMinutes ?? 0) * MINUTE;
  const request = asked.class === undefined ? undefined : asked.priority === undefined ? { class: asked.class } : { class: asked.class, priority: asked.priority };
  return {
    name: `${String(arrived).padStart(15, '0')}-${id}.json`,
    waiter: { session: asked.session ?? 'alpha', arrivedAt: new Date(arrived).toISOString(), ...(request === undefined ? {} : { request }) },
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
    assert.deepEqual(idsOf(placeInLine(order, order[2]?.name ?? '', new Map([['alpha', 1]]), PIPELINE)?.ahead ?? []), ['first', 'second']);
  });

  it('passes a waiter whose session runs perSessionRunning steps', () => {
    const place = placeInLine(order, order[2]?.name ?? '', new Map([['alpha', 2]]), PIPELINE);
    assert.equal(place?.kind, 'inLine');
    assert.deepEqual(idsOf(place?.ahead ?? []), ['second']);
  });

  it('waits on its own session cap, with the running count, while it passes no one', () => {
    const place = placeInLine(order, order[1]?.name ?? '', new Map([['beta', 3]]), PIPELINE);
    assert.deepEqual(place === undefined ? undefined : { ...place, ahead: idsOf(place.ahead) }, { kind: 'sessionCap', ahead: ['first'], running: 3, cap: 2 });
  });

  it('caps no session in serial mode, without rules, or with perSessionRunning 0', () => {
    const running = new Map([['alpha', 5], ['bravo', 5]]);
    for (const rules of [SERIAL, undefined, { ...PIPELINE, perSessionRunning: 0 }]) {
      const place = placeInLine(order, order[2]?.name ?? '', running, rules);
      assert.equal(place?.kind, 'inLine');
      assert.deepEqual(idsOf(place?.ahead ?? []), ['first', 'second']);
    }
  });

  it('is undefined for a ticket not in line', () => {
    assert.equal(placeInLine(order, 'gone.json', new Map(), PIPELINE), undefined);
  });
});
