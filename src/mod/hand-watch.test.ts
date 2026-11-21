import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HandWatch, STALL_MS, TRACE_ERROR_CHARS, TRACE_EVERY_MS, type HandTrace } from './hand-watch.ts';

class Host {
  time = 1_000_000;
  readonly traces: HandTrace[] = [];
  now = (): number => this.time;
  trace = (trace: HandTrace): void => {
    this.traces.push(trace);
  };
}

/** A tick that settles only when told to. */
function held(): { readonly tick: () => Promise<string>; readonly settle: () => void } {
  let settle = (): void => undefined;
  const promise = new Promise<string>((resolve) => {
    settle = () => resolve('done');
  });
  return { tick: () => promise, settle };
}

describe('HandWatch', () => {
  it("passes a tick's result through and traces nothing for a tick that settles", async () => {
    const host = new Host();
    const watch = new HandWatch(host);
    assert.equal(await watch.run('wake', async () => 'waited'), 'waited');
    assert.deepEqual(host.traces, []);
  });

  it('traces a tick that throws or rejects, by its hand, and resolves undefined so the clock goes on (#920)', async () => {
    const host = new Host();
    const watch = new HandWatch(host);
    assert.equal(await watch.run('clear', async () => Promise.reject(new Error('band write refused'))), undefined);
    assert.equal(
      await watch.run('wake', () => {
        throw new TypeError('no session');
      }),
      undefined,
    );
    assert.deepEqual(host.traces, [
      { kind: 'threw', hand: 'clear', error: 'band write refused' },
      { kind: 'threw', hand: 'wake', error: 'no session' },
    ]);
  });

  it("cuts a long error to the trace's length", async () => {
    const host = new Host();
    await new HandWatch(host).run('meeting', async () => Promise.reject('x'.repeat(TRACE_ERROR_CHARS + 50)));
    assert.equal(host.traces[0]?.kind === 'threw' ? host.traces[0].error.length : 0, TRACE_ERROR_CHARS);
  });

  it('traces a hand whose earlier tick stayed unsettled past the limit from the run that first found it so, with how long', async () => {
    const host = new Host();
    const watch = new HandWatch(host);
    const first = held();
    const firstRun = watch.run('clear', first.tick);
    host.time += 1_000;
    await watch.run('clear', async () => 'quick');
    host.time += STALL_MS - 1;
    await watch.run('clear', async () => 'quick');
    assert.deepEqual(host.traces, []);
    host.time += 1;
    await watch.run('clear', async () => 'quick');
    assert.deepEqual(host.traces, [{ kind: 'stalled', hand: 'clear', ms: STALL_MS }]);
    first.settle();
    assert.equal(await firstRun, 'done');
    host.time += STALL_MS * 2;
    await watch.run('clear', async () => 'quick');
    assert.equal(host.traces.length, 1, 'a settled tick no longer counts as stalled');
  });

  it('holds a tick to its own limit when the hand names one', async () => {
    const host = new Host();
    const watch = new HandWatch(host);
    void watch.run('update', held().tick, STALL_MS * 5);
    await watch.run('update', async () => 'quick', STALL_MS * 5);
    host.time += STALL_MS * 5 - 1;
    await watch.run('update', async () => 'quick', STALL_MS * 5);
    assert.deepEqual(host.traces, []);
    host.time += 1;
    await watch.run('update', async () => 'quick', STALL_MS * 5);
    assert.deepEqual(host.traces, [{ kind: 'stalled', hand: 'update', ms: STALL_MS * 5 }]);
  });

  it('traces the same hand and kind at most once per window, and each hand apart', async () => {
    const host = new Host();
    const watch = new HandWatch(host);
    const fail = async (): Promise<never> => Promise.reject(new Error('boom'));
    await watch.run('wake', fail);
    host.time += TRACE_EVERY_MS - 1;
    await watch.run('wake', fail);
    await watch.run('meeting', fail);
    host.time += 1;
    await watch.run('wake', fail);
    assert.deepEqual(
      host.traces.map((trace) => trace.hand),
      ['wake', 'meeting', 'wake'],
    );
  });

  it('reads the clock only while a tick of the hand is unsettled, or for a throw', async () => {
    let reads = 0;
    const watch = new HandWatch({
      now: () => {
        reads += 1;
        return 0;
      },
      trace: () => undefined,
    });
    for (let tick = 0; tick < 5; tick += 1) {
      await watch.run('clear', async () => 'quick');
    }
    assert.equal(reads, 0);
    void watch.run('clear', held().tick);
    await watch.run('clear', async () => 'quick');
    await watch.run('wake', async () => Promise.reject(new Error('boom')));
    assert.equal(reads, 2);
  });

  it('keeps going when the trace itself throws', async () => {
    const watch = new HandWatch({
      now: () => 0,
      trace: () => {
        throw new Error('sink gone');
      },
    });
    assert.equal(await watch.run('wake', async () => Promise.reject(new Error('boom'))), undefined);
  });
});
