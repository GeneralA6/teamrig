import type { StarterWatch, StarterWatching } from '../delivery/starter-watch.ts';
import type { ProcessInfo } from '../open/session-processes.ts';

/** The Bash tool's shell a tab's step runs in. */
export const SHELL: ProcessInfo = { pid: 4100, parentPid: 4000, name: 'bash.exe', commandLine: 'bash -c teamrig queue' };
/** The tab's Claude Code, which started `SHELL`. */
export const CLAUDE: ProcessInfo = { pid: 4000, parentPid: 3000, name: 'claude.exe', commandLine: 'claude' };

/**
 * Starters in memory: each watch lists `starters` (default `SHELL` and `CLAUDE`) and runs until `end` ends one, which
 * aborts every open watch, as the real checks would find it gone.
 */
export class FakeStarterWatch implements StarterWatch {
  private readonly starters: readonly ProcessInfo[];
  private readonly open = new Set<(starter: ProcessInfo) => void>();

  constructor(starters: readonly ProcessInfo[] = [SHELL, CLAUDE]) {
    this.starters = starters;
  }

  /** The watches not closed yet. */
  get openWatches(): number {
    return this.open.size;
  }

  /** Ends `starter` (default the first), for every open watch. */
  end(starter: ProcessInfo | undefined = this.starters[0]): void {
    if (starter === undefined) {
      throw new Error('no starter to end: this watch lists none');
    }
    for (const ended of [...this.open]) {
      ended(starter);
    }
  }

  async watch(): Promise<StarterWatching> {
    const controller = new AbortController();
    let found: ProcessInfo | undefined;
    const ended = (starter: ProcessInfo): void => {
      if (found === undefined) {
        found = starter;
        controller.abort();
      }
    };
    this.open.add(ended);
    return { starters: this.starters, stop: controller.signal, ended: () => found, close: () => this.open.delete(ended) };
  }
}
