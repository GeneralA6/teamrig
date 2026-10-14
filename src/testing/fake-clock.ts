import type { Clock, Sleep } from '../core/lock.ts';

/** A clock that only moves when told to; its `sleep` advances time instead of waiting. */
export class FakeClock implements Clock {
  private current: number;
  readonly sleeps: number[] = [];

  constructor(start: number | string = 0) {
    this.current = typeof start === 'number' ? start : Date.parse(start);
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  readonly sleep: Sleep = async (ms) => {
    this.sleeps.push(ms);
    this.current += ms;
  };
}
