/**
 * What the person chose at the restore's countdown: reopen now, reopen every session with no prompt, reopen the
 * tabs closed outside a shutdown too, end the hung tabs and reopen them too, or nothing.
 */
export type RestoreChoice = 'go' | 'idle' | 'all' | 'kill' | 'cancel';

/** The countdown before the restore reopens its tabs, which lets the person change their mind. */
export interface Countdown {
  /**
   * Counts `seconds` down on the terminal; resolves with the key pressed, or `go` when time runs out. `closed` is
   * how many tabs closed outside a shutdown are on offer: only then does `a` take them too; `hung` how many live tabs
   * hung mid-turn are: only then does `k` end and reopen them too.
   */
  choose(seconds: number, closed: number, hung: number): Promise<RestoreChoice>;
}

/**
 * The choice a key makes: Enter starts now, `i` reopens idle, `a` reopens the closed tabs too, `k` ends the hung
 * tabs and reopens them too, `q`, Escape or Ctrl+C cancels; any other none.
 */
export function keyChoice(key: string): RestoreChoice | undefined {
  if (key === '\r' || key === '\n') {
    return 'go';
  }
  const lower = key.toLowerCase();
  if (lower === 'i') {
    return 'idle';
  }
  if (lower === 'k') {
    return 'kill';
  }
  if (lower === 'a') {
    return 'all';
  }
  return lower === 'q' || key === '\u0003' || key === '\u001b' ? 'cancel' : undefined;
}

/** The countdown's line, redrawn in place each second; it offers `a` and `k` only when there are tabs for them. */
export function countdownLine(remaining: number, closed: number, hung: number): string {
  const all = closed > 0 ? `   [a] also reopen the ${closed} closed` : '';
  const kill = hung > 0 ? `   [k] also end and reopen the ${hung} hung` : '';
  return `\rStarting in ${String(remaining).padStart(2)}s   [Enter] start now   [i] reopen all with no prompt${all}${kill}   [q] cancel `;
}

/** The terminal a countdown runs on. */
export interface CountdownTerminal {
  write(text: string): void;
  /** Reads keys one at a time until the returned function stops it; with no keyboard (not a TTY) it reads none. */
  listen(onKey: (key: string) => void): () => void;
  /** Calls `tick` each second until the returned function stops it. */
  everySecond(tick: () => void): () => void;
}

export function terminalCountdown(terminal: CountdownTerminal): Countdown {
  return {
    choose(seconds, closed, hung) {
      return new Promise((resolve) => {
        let remaining = seconds;
        let done = false;
        const stops: (() => void)[] = [];
        const finish = (choice: RestoreChoice): void => {
          if (done) {
            return;
          }
          done = true;
          stops.forEach((stop) => stop());
          terminal.write('\n');
          resolve(choice);
        };
        terminal.write(countdownLine(remaining, closed, hung));
        stops.push(
          terminal.listen((key) => {
            const choice = keyChoice(key);
            if (choice !== undefined && (choice !== 'all' || closed > 0) && (choice !== 'kill' || hung > 0)) {
              finish(choice);
            }
          }),
        );
        stops.push(
          terminal.everySecond(() => {
            remaining -= 1;
            if (remaining <= 0) {
              finish('go');
            } else {
              terminal.write(countdownLine(remaining, closed, hung));
            }
          }),
        );
      });
    },
  };
}

/** The parts of a keyboard stream the countdown uses: stdin, or a fake in the tests. */
export interface KeyInput {
  readonly isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/** Where the countdown writes its line: stdout, or a fake in the tests. */
export interface TextOutput {
  write(text: string): unknown;
}

/** The process's own terminal: keys from stdin in raw mode, when it is one, and the line on stdout. */
export function stdioCountdownTerminal(input: KeyInput, output: TextOutput): CountdownTerminal {
  return {
    write(text) {
      output.write(text);
    },
    listen(onKey) {
      if (!input.isTTY) {
        return () => undefined;
      }
      const onData = (chunk: Buffer | string): void => onKey(String(chunk));
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      return () => {
        input.removeListener('data', onData);
        input.setRawMode(false);
        input.pause();
      };
    },
    everySecond(tick) {
      const timer = setInterval(tick, 1000);
      return () => clearInterval(timer);
    },
  };
}
