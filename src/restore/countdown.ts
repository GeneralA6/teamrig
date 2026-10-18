/** What the person chose at the restore's countdown: reopen now, reopen every session with no prompt, or nothing. */
export type RestoreChoice = 'go' | 'idle' | 'cancel';

/** The countdown before the restore reopens its tabs, which lets the person change their mind. */
export interface Countdown {
  /** Counts `seconds` down on the terminal; resolves with the key pressed, or `go` when time runs out. */
  choose(seconds: number): Promise<RestoreChoice>;
}

/** The choice a key makes: Enter starts now, `i` reopens idle, `q`, Escape or Ctrl+C cancels; any other none. */
export function keyChoice(key: string): RestoreChoice | undefined {
  if (key === '\r' || key === '\n') {
    return 'go';
  }
  const lower = key.toLowerCase();
  if (lower === 'i') {
    return 'idle';
  }
  return lower === 'q' || key === '\u0003' || key === '\u001b' ? 'cancel' : undefined;
}

/** The countdown's line, redrawn in place each second. */
export function countdownLine(remaining: number): string {
  return `\rStarting in ${String(remaining).padStart(2)}s   [Enter] start now   [i] reopen all with no prompt   [q] cancel `;
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
    choose(seconds) {
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
        terminal.write(countdownLine(remaining));
        stops.push(
          terminal.listen((key) => {
            const choice = keyChoice(key);
            if (choice !== undefined) {
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
              terminal.write(countdownLine(remaining));
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
