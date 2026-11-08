import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fieldPaths } from '../testing/field-paths.ts';
import { charge, EMPTY_TURNS, endedAtOf, endedText, isNewerTurns, parseTurns, settle, TURNS_FORMAT, turnsFor, turnsText, virtualMinutes, type OpenCharge, type TurnsState } from './class-turns.ts';

const AT = '2030-01-08T10:00:00.000Z';
const AT_MS = Date.parse(AT);
const MINUTE_MS = 60_000;

/** A step of `workClass` at `pct`, admitted at AT and charged `minutes`. */
function step(ticket: string, workClass: string, pct: number, minutes: number): OpenCharge {
  return { ticket, class: workClass, pct, at: AT, minutes };
}

function state(floor: number, classes: Record<string, number>, open: readonly OpenCharge[] = []): TurnsState {
  return { floor, classes: new Map(Object.entries(classes)), open };
}

/** A state's turns as a plain record, to compare. */
function turnsOf(turns: TurnsState): Record<string, number> {
  return Object.fromEntries(turns.classes);
}

describe('class turns: virtual minutes', () => {
  it('counts run minutes times 100 over the class allocation percent', () => {
    assert.equal(virtualMinutes(10, 50), 20);
    assert.equal(virtualMinutes(10, 100), 10);
  });

  it('counts a 0% class as 1%, so it still runs when no other class waits', () => {
    assert.equal(virtualMinutes(10, 0), 1000);
  });
});

describe('class turns: the turns file', () => {
  it('reads what it wrote', () => {
    const turns = state(3, { Roadmap: 12.5, Maintenance: 3 }, [step('t1', 'Roadmap', 40, 5)]);
    assert.deepEqual(parseTurns(turnsText(turns)), turns);
  });

  it('reads a missing, damaged or ill-formed file as no turns yet, never a stuck line', () => {
    const damaged = [
      undefined,
      '{"floor": 1,',
      '[]',
      '{"floor": -1, "classes": {}, "open": []}',
      '{"floor": 0, "classes": {"Roadmap": "ten"}, "open": []}',
      '{"floor": 0, "classes": {}, "open": [{"ticket": "t1", "class": "Roadmap", "pct": 40, "at": "noon", "minutes": 5}]}',
      '{"floor": 0, "classes": {}, "open": [{"token": "t1", "class": "Roadmap", "pct": 40, "at": "2030-01-08T10:00:00.000Z", "minutes": 5}]}',
      '{"floor": 0, "classes": {}}',
    ];
    assert.deepEqual(
      damaged.map((text) => parseTurns(text)),
      damaged.map(() => EMPTY_TURNS),
    );
  });

  it('writes the pinned fields of its format: a field added to the file raises TURNS_FORMAT', () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      1: ['classes.*', 'floor', 'open[].at', 'open[].class', 'open[].minutes', 'open[].pct', 'open[].ticket', 'v'],
    };
    const turns = state(3, { Roadmap: 12.5 }, [step('t1', 'Roadmap', 40, 5)]);
    assert.deepEqual(fieldPaths(JSON.parse(turnsText(turns)), new Set(['classes'])), written[TURNS_FORMAT]);
  });

  it('reads a file a newer teamrig wrote as no turns, and tells it apart from a missing, damaged or current one', () => {
    const newer = '{"v": 2, "floor": 3, "classes": {"Roadmap": 12.5}, "open": [], "weights": {}}';
    const others = [undefined, '{"floor": 1,', '{"v": "two", "floor": 0, "classes": {}, "open": []}', turnsText(state(3, { Roadmap: 12.5 }))];
    assert.deepEqual([parseTurns(newer), isNewerTurns(newer)], [EMPTY_TURNS, true]);
    assert.deepEqual(
      others.map((text) => isNewerTurns(text)),
      others.map(() => false),
    );
  });

  it('reads a file that names no format as the first one', () => {
    const turns = state(3, { Roadmap: 12.5 });
    assert.deepEqual(parseTurns('{"floor": 3, "classes": {"Roadmap": 12.5}, "open": []}'), turns);
  });

  it('writes and reads a step\'s end marker, and reads a damaged one as no end', () => {
    assert.equal(endedAtOf(endedText(AT)), AT_MS);
    assert.equal(endedAtOf(undefined), undefined);
    assert.equal(endedAtOf('{"endedAt": "later"}'), undefined);
    assert.equal(endedAtOf('{"endedAt"'), undefined);
  });
});

describe('class turns: charge at admission', () => {
  it('charges the admitted step\'s class its minutes and keeps the charge open', () => {
    const admitted = step('t2', 'Roadmap', 50, 6);
    const after = charge(state(0, { Roadmap: 4, Maintenance: 2 }), admitted, ['Roadmap', 'Maintenance']);
    assert.deepEqual(turnsOf(after), { Roadmap: 16, Maintenance: 2 });
    assert.deepEqual(after.open, [admitted]);
  });

  it('starts a class the turns lack at the floor, risen to the least turn of the classes waiting', () => {
    const after = charge(state(1, { Roadmap: 8, Maintenance: 5 }), step('t1', 'Improvements', 100, 5), ['Roadmap', 'Maintenance', 'Improvements']);
    assert.equal(after.floor, 1, 'the new class, at the floor, is the least');
    assert.deepEqual(turnsOf(after), { Roadmap: 8, Maintenance: 5, Improvements: 6 });
    const later = charge(state(1, { Roadmap: 8, Maintenance: 5 }), step('t1', 'Roadmap', 100, 5), ['Roadmap', 'Maintenance']);
    assert.equal(later.floor, 5);
  });

  it('lifts a class with no step waiting or running to the floor, so idle time banks no turns', () => {
    const after = charge(state(0, { Roadmap: 20, Improvements: 2 }), step('t3', 'Roadmap', 100, 5), ['Roadmap']);
    assert.equal(after.floor, 20);
    assert.deepEqual(turnsOf(after), { Roadmap: 25, Improvements: 20 });
  });

  it('lifts no class still running a step, nor one waiting, and never lowers the floor or a turn', () => {
    const running = step('t1', 'Improvements', 50, 5);
    const after = charge(state(30, { Roadmap: 40, Improvements: 2, Maintenance: 50 }, [running]), step('t2', 'Roadmap', 100, 5), ['Roadmap']);
    assert.equal(after.floor, 40);
    assert.deepEqual(turnsOf(after), { Roadmap: 45, Improvements: 2, Maintenance: 50 });
    const waiting = charge(state(0, { Roadmap: 40, Improvements: 2 }), step('t2', 'Roadmap', 100, 5), ['Roadmap', 'Improvements']);
    assert.deepEqual(turnsOf(waiting), { Roadmap: 45, Improvements: 2 });
    assert.equal(waiting.floor, 2);
    assert.equal(charge(state(9, { Roadmap: 2 }), step('t2', 'Roadmap', 100, 5), ['Roadmap']).floor, 9);
  });
});

describe('class turns: settling at the end', () => {
  it('corrects an ended step\'s charge to the minutes it ran from admission, and closes it', () => {
    const longer = settle(state(0, { Roadmap: 10 }, [step('t1', 'Roadmap', 50, 5)]), new Map([['t1', AT_MS + 20 * MINUTE_MS]]), new Set());
    assert.deepEqual(turnsOf(longer), { Roadmap: 40 }, '15 more minutes at 50%');
    assert.deepEqual(longer.open, []);
    const shorter = settle(state(0, { Roadmap: 10 }, [step('t1', 'Roadmap', 50, 5)]), new Map([['t1', AT_MS + 2 * MINUTE_MS]]), new Set());
    assert.deepEqual(turnsOf(shorter), { Roadmap: 4 });
  });

  it('keeps a running step\'s charge open, and lets a dead step\'s estimate stand', () => {
    const open = [step('t1', 'Roadmap', 50, 5), step('t2', 'Maintenance', 50, 5)];
    const after = settle(state(0, { Roadmap: 10, Maintenance: 10 }, open), new Map(), new Set(['t1']));
    assert.deepEqual(after.open, [open[0]]);
    assert.deepEqual(turnsOf(after), { Roadmap: 10, Maintenance: 10 });
  });

  it('gives two classes at 50/50 even turns when one runs a 60-minute step beside twelve 5-minute steps of the other', () => {
    let turns = charge(EMPTY_TURNS, step('a', 'Roadmap', 50, 5), ['Roadmap', 'Maintenance']);
    for (let index = 0; index < 12; index += 1) {
      const ticket = `b${index}`;
      turns = charge(turns, { ...step(ticket, 'Maintenance', 50, 5), at: new Date(AT_MS + index * 5 * MINUTE_MS).toISOString() }, ['Maintenance']);
      turns = settle(turns, new Map([[ticket, AT_MS + (index + 1) * 5 * MINUTE_MS]]), new Set(['a']));
    }
    turns = settle(turns, new Map([['a', AT_MS + 60 * MINUTE_MS]]), new Set());
    assert.deepEqual(turnsOf(turns), { Roadmap: 120, Maintenance: 120 });
  });
});

describe('class turns: turns for the line', () => {
  it('gives each class waiting its turn, and the floor to a class the turns lack', () => {
    const turns = turnsFor(state(3, { Roadmap: 7, Maintenance: 9 }), ['Roadmap', 'Improvements']);
    assert.deepEqual(Object.fromEntries(turns), { Roadmap: 7, Improvements: 3 });
  });
});
