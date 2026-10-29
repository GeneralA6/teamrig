import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processStopWatch, STOP_SIGNALS, type SignalTarget } from './stops.ts';

/** A process that keeps its signal listeners and records each exit instead of ending. */
class FakeSignalTarget implements SignalTarget {
  readonly listeners = new Map<NodeJS.Signals, NodeJS.SignalsListener[]>();
  readonly exits: number[] = [];

  on(signal: NodeJS.Signals, listener: NodeJS.SignalsListener): void {
    this.listeners.set(signal, [...(this.listeners.get(signal) ?? []), listener]);
  }

  off(signal: NodeJS.Signals, listener: NodeJS.SignalsListener): void {
    this.listeners.set(
      signal,
      (this.listeners.get(signal) ?? []).filter((kept) => kept !== listener),
    );
  }

  exit(code: number): void {
    this.exits.push(code);
  }

  send(signal: NodeJS.Signals): void {
    for (const listener of this.listeners.get(signal) ?? []) {
      listener(signal);
    }
  }

  count(): number {
    return [...this.listeners.values()].reduce((sum, list) => sum + list.length, 0);
  }
}

/** Lets the stop's promise chain run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('processStopWatch', () => {
  it('runs the stop once its signal comes, then exits as that signal would end the process', async () => {
    const target = new FakeSignalTarget();
    const stopped: string[] = [];
    processStopWatch(target).watch(async (signal) => {
      stopped.push(signal);
    });
    assert.equal(target.count(), STOP_SIGNALS.length);
    target.send('SIGHUP');
    target.send('SIGINT');
    await settle();
    assert.deepEqual(stopped, ['SIGHUP']);
    assert.deepEqual(target.exits, [129]);
  });

  it('exits even when the stop fails', async () => {
    const target = new FakeSignalTarget();
    processStopWatch(target).watch(async () => Promise.reject(new Error('disk full')));
    target.send('SIGTERM');
    await settle();
    assert.deepEqual(target.exits, [143]);
  });

  it('listens no more once it stops watching', async () => {
    const target = new FakeSignalTarget();
    const stopped: string[] = [];
    const unwatch = processStopWatch(target).watch(async (signal) => {
      stopped.push(signal);
    });
    unwatch();
    target.send('SIGBREAK');
    await settle();
    assert.equal(target.count(), 0);
    assert.deepEqual(stopped, []);
    assert.deepEqual(target.exits, []);
  });
});
