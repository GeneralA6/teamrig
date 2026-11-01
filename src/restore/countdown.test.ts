import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countdownLine,
  keyChoice,
  stdioCountdownTerminal,
  terminalCountdown,
  type CountdownTerminal,
  type KeyInput,
  type TextOutput,
} from './countdown.ts';

/** A keyboard stream the test types into, which records what the terminal asked of it. */
class FakeKeyInput implements KeyInput {
  readonly isTTY: boolean;
  readonly calls: string[] = [];
  private readonly listeners = new Set<(chunk: Buffer | string) => void>();

  constructor(isTTY: boolean) {
    this.isTTY = isTTY;
  }

  setRawMode(mode: boolean): void {
    this.calls.push(`raw ${mode}`);
  }

  resume(): void {
    this.calls.push('resume');
  }

  pause(): void {
    this.calls.push('pause');
  }

  on(event: 'data', listener: (chunk: Buffer | string) => void): void {
    this.calls.push(`on ${event}`);
    this.listeners.add(listener);
  }

  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): void {
    this.calls.push(`off ${event}`);
    this.listeners.delete(listener);
  }

  type(chunk: Buffer | string): void {
    this.listeners.forEach((listener) => listener(chunk));
  }
}

class FakeTextOutput implements TextOutput {
  readonly written: string[] = [];

  write(text: string): void {
    this.written.push(text);
  }
}

/** A terminal the test drives: it presses keys and ticks the clock by hand. */
class FakeTerminal implements CountdownTerminal {
  readonly written: string[] = [];
  listening = false;
  ticking = false;
  private onKey: ((key: string) => void) | undefined;
  private tick: (() => void) | undefined;

  write(text: string): void {
    this.written.push(text);
  }

  listen(onKey: (key: string) => void): () => void {
    this.onKey = onKey;
    this.listening = true;
    return () => {
      this.listening = false;
      this.onKey = undefined;
    };
  }

  everySecond(tick: () => void): () => void {
    this.tick = tick;
    this.ticking = true;
    return () => {
      this.ticking = false;
      this.tick = undefined;
    };
  }

  press(key: string): void {
    this.onKey?.(key);
  }

  second(): void {
    this.tick?.();
  }
}

describe('keyChoice', () => {
  it('reads Enter as go, i as idle, a as all, and q, Escape or Ctrl+C as cancel', () => {
    assert.equal(keyChoice('\r'), 'go');
    assert.equal(keyChoice('I'), 'idle');
    assert.equal(keyChoice('a'), 'all');
    assert.equal(keyChoice('A'), 'all');
    assert.equal(keyChoice('q'), 'cancel');
    assert.equal(keyChoice('\u001b'), 'cancel');
    assert.equal(keyChoice('\u0003'), 'cancel');
    assert.equal(keyChoice('x'), undefined);
  });
});

describe('countdownLine', () => {
  it('offers a only when there are closed tabs to reopen', () => {
    assert.equal(countdownLine(5, 0), '\rStarting in  5s   [Enter] start now   [i] reopen all with no prompt   [q] cancel ');
    assert.equal(countdownLine(5, 3), '\rStarting in  5s   [Enter] start now   [i] reopen all with no prompt   [a] also reopen the 3 closed   [q] cancel ');
  });
});

describe('terminalCountdown', () => {
  it('counts down each second and goes when time runs out', async () => {
    const terminal = new FakeTerminal();
    const choice = terminalCountdown(terminal).choose(2, 0);
    terminal.second();
    terminal.second();
    assert.equal(await choice, 'go');
    assert.deepEqual(terminal.written, [countdownLine(2, 0), countdownLine(1, 0), '\n']);
    assert.equal(terminal.listening, false);
    assert.equal(terminal.ticking, false);
  });

  it('takes the first key that makes a choice and ignores the rest', async () => {
    const terminal = new FakeTerminal();
    const choice = terminalCountdown(terminal).choose(60, 0);
    terminal.press('x');
    terminal.press('i');
    terminal.press('q');
    terminal.second();
    assert.equal(await choice, 'idle');
    assert.deepEqual(terminal.written, [countdownLine(60, 0), '\n']);
  });

  it('takes a only when closed tabs are on offer', async () => {
    const none = new FakeTerminal();
    const ignored = terminalCountdown(none).choose(1, 0);
    none.press('a');
    none.second();
    assert.equal(await ignored, 'go');
    const some = new FakeTerminal();
    const taken = terminalCountdown(some).choose(60, 2);
    some.press('a');
    assert.equal(await taken, 'all');
    assert.deepEqual(some.written, [countdownLine(60, 2), '\n']);
  });
});

describe('stdioCountdownTerminal', () => {
  it('writes the line to the output', () => {
    const output = new FakeTextOutput();
    stdioCountdownTerminal(new FakeKeyInput(true), output).write(countdownLine(5, 0));
    assert.deepEqual(output.written, [countdownLine(5, 0)]);
  });

  it('reads keys in raw mode until stopped, then gives the terminal back', () => {
    const input = new FakeKeyInput(true);
    const keys: string[] = [];
    const stop = stdioCountdownTerminal(input, new FakeTextOutput()).listen((key) => keys.push(key));
    input.type(Buffer.from('i'));
    input.type('q');
    stop();
    input.type('x');
    assert.deepEqual(keys, ['i', 'q']);
    assert.deepEqual(input.calls, ['raw true', 'resume', 'on data', 'off data', 'raw false', 'pause']);
  });

  it('reads no keys, and leaves the input alone, when it is not a terminal', () => {
    const input = new FakeKeyInput(false);
    const stop = stdioCountdownTerminal(input, new FakeTextOutput()).listen(() => assert.fail('no key is read'));
    input.type('q');
    stop();
    assert.deepEqual(input.calls, []);
  });

  it('ticks each second until stopped', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let ticks = 0;
    const stop = stdioCountdownTerminal(new FakeKeyInput(true), new FakeTextOutput()).everySecond(() => {
      ticks += 1;
    });
    t.mock.timers.tick(999);
    assert.equal(ticks, 0);
    t.mock.timers.tick(2_001);
    assert.equal(ticks, 3);
    stop();
    t.mock.timers.tick(5_000);
    assert.equal(ticks, 3);
  });
});
