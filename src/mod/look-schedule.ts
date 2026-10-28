/**
 * When a hand of the plugin's mod asks the CLI again: at its first look, once a file or folder the CLI named changed,
 * once the time the CLI named came, or `recheckMs` after its last ask, so a change the files do not show (the config,
 * the budget's quiet hours) is seen. The wake hand and the meeting hand each keep one.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time.
 */

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export class LookSchedule {
  private readonly recheckMs: number;
  /** When the file or folder last changed, epoch ms; undefined when it is missing. */
  private readonly changedAt: (path: string) => Promise<number | undefined>;
  /** The files the CLI named (undefined: ask at the next look), and when each had changed at the last ask. */
  private watch: readonly string[] | undefined;
  private seenChanges: readonly (number | undefined)[] = [];
  /** When the last ask ran, and when the CLI asked to be asked again. */
  private lastAsk: number | undefined;
  private recheckAt: number | undefined;

  constructor(recheckMs: number, changedAt: (path: string) => Promise<number | undefined>) {
    this.recheckMs = recheckMs;
    this.changedAt = changedAt;
  }

  /** Whether the CLI named its files yet. */
  get watching(): boolean {
    return this.watch !== undefined;
  }

  /**
   * Whether to ask the CLI now; when so, the ask is taken as made at `now`, the change times read before it, so a
   * change made while it runs is seen at the next look.
   */
  async due(now: number): Promise<boolean> {
    const changed = this.watch === undefined ? [] : await Promise.all(this.watch.map((path) => this.changedAt(path)));
    const isDue =
      this.lastAsk === undefined ||
      !sameList(changed, this.seenChanges) ||
      (this.recheckAt !== undefined && now >= this.recheckAt) ||
      now >= this.lastAsk + this.recheckMs;
    if (isDue) {
      this.seenChanges = changed;
      this.lastAsk = now;
      this.recheckAt = undefined;
    }
    return isDue;
  }

  /** The CLI's answer: the files to watch and when to ask again (null: no time set). */
  waitFor(watch: readonly string[], recheckAt: number | null): void {
    if (this.watch === undefined || !sameList(watch, this.watch)) {
      // Files first named now: ask once more at the next look, which takes their change times first.
      this.watch = watch;
      this.seenChanges = [];
      this.lastAsk = undefined;
    }
    this.recheckAt = recheckAt ?? undefined;
  }

  /** Ask again at the next look. */
  askAgain(): void {
    this.lastAsk = undefined;
  }
}
