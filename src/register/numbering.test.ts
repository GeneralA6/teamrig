import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Mutex } from '../core/lock.ts';
import { TimeZone } from '../core/zone.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { LogNumbers, OWN_NUMBERS, TreeNumbering, type NumberSource, type TaskNumbering } from './numbering.ts';
import { RegisterPolicy } from './policy.ts';
import { NO_GOAL_RECORDS, NOTHING_ELSEWHERE, Register } from './register.ts';
import { JsonlEventLog } from './store.ts';

/** A mutex that tells whether a task is running under it. */
class HeldMutex implements Mutex {
  held = false;

  async run<T>(task: () => Promise<T>): Promise<T> {
    this.held = true;
    try {
      return await task();
    } finally {
      this.held = false;
    }
  }
}

/** Another register whose next number is `next`, noting whether the tree lock was held at each read. */
class FixedNumber implements NumberSource {
  readonly heldAtRead: boolean[] = [];
  private readonly next: number;
  private readonly mutex: HeldMutex;

  constructor(next: number, mutex: HeldMutex) {
    this.next = next;
    this.mutex = mutex;
  }

  async nextNumber(): Promise<number> {
    this.heldAtRead.push(this.mutex.held);
    return this.next;
  }
}

function registerOn(files: MemoryFiles, path: string, numbering: TaskNumbering): Register {
  return new Register({
    log: new JsonlEventLog(files, path),
    mutex: new InlineMutex(),
    numbering,
    elsewhere: NOTHING_ELSEWHERE,
    goals: NO_GOAL_RECORDS,
    clock: new FakeClock('2030-01-07T09:00:00.000Z'),
    zone: TimeZone.UTC,
    policy: new RegisterPolicy(testConfig()),
    skills: { exists: async () => false },
    autoArchive: false,
  });
}

async function addedId(register: Register, title: string): Promise<string> {
  const verdict = await register.add('lead', { title, description: 'what and why', owner: 'alpha', source: 'lead', priority: 1 });
  assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
  return verdict.value.task.id;
}

describe('OWN_NUMBERS', () => {
  it('lets a team on its own number from 1', async () => {
    assert.equal(await OWN_NUMBERS.issue(async (floor) => floor), 1);
  });
});

describe('TreeNumbering', () => {
  it('issues the highest next number of the other registers, read and written under the tree lock', async () => {
    const mutex = new HeldMutex();
    const others = [new FixedNumber(4, mutex), new FixedNumber(12, mutex), new FixedNumber(7, mutex)];
    let heldAtWrite = false;
    const floor = await new TreeNumbering(mutex, others).issue(async (given) => {
      heldAtWrite = mutex.held;
      return given;
    });
    assert.equal(floor, 12);
    assert.deepEqual([heldAtWrite, others.map((other) => other.heldAtRead)], [true, [[true], [true], [true]]]);
    assert.equal(mutex.held, false);
  });

  it('issues 1 with no other register to read', async () => {
    assert.equal(await new TreeNumbering(new HeldMutex(), []).issue(async (floor) => floor), 1);
  });

  it('gives two registers sharing it ids that never meet', async () => {
    const files = new MemoryFiles();
    const tree = new InlineMutex();
    const app = registerOn(files, 'app/events.jsonl', new TreeNumbering(tree, [new LogNumbers(new JsonlEventLog(files, 'web/events.jsonl'))]));
    const web = registerOn(files, 'web/events.jsonl', new TreeNumbering(tree, [new LogNumbers(new JsonlEventLog(files, 'app/events.jsonl'))]));
    const ids = [await addedId(app, 'One'), await addedId(web, 'Two'), await addedId(web, 'Three'), await addedId(app, 'Four')];
    assert.deepEqual(ids, ['T1', 'T2', 'T3', 'T4']);
    assert.equal(tree.runs, 4);
  });
});

describe('LogNumbers', () => {
  it('reads 1 for a register not yet written, else one past its highest id', async () => {
    const files = new MemoryFiles();
    const numbers = new LogNumbers(new JsonlEventLog(files, 'app/events.jsonl'));
    assert.equal(await numbers.nextNumber(), 1);
    const app = registerOn(files, 'app/events.jsonl', new TreeNumbering(new InlineMutex(), [{ nextNumber: async () => 40 }]));
    await addedId(app, 'One');
    assert.equal(await numbers.nextNumber(), 41);
  });
});
