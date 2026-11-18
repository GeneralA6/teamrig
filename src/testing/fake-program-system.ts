import type { ProgramOutput, ProgramSystem } from '../worktree/files.ts';
import { systemError } from './faulty-files.ts';

/** What a `FakeProgramSystem` holds; a path missing from `folders`, `links` or `texts` throws ENOENT. */
export interface FakeProgramSystemSetup {
  readonly platform: NodeJS.Platform;
  /** This program's process id; 1000 by default. */
  readonly pid?: number;
  /** Each folder's entry names. */
  readonly folders?: Readonly<Record<string, readonly string[]>>;
  /** Where each link points. */
  readonly links?: Readonly<Record<string, string>>;
  /** Each text file's contents. */
  readonly texts?: Readonly<Record<string, string>>;
  /** What every run ends with; exit 0 and nothing printed by default. */
  readonly output?: ProgramOutput;
  /** The code each move fails with, in turn; undefined (and every move past the list) moves. */
  readonly moveCodes?: readonly (string | undefined)[];
  /** What `uniqueSuffix` returns; `fake0001` by default. */
  readonly suffix?: string;
}

/** A program run as the system was asked for it. */
export interface FakeRun {
  readonly program: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** The system a program read sees, set by the test; each run and move is recorded. */
export class FakeProgramSystem implements ProgramSystem {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly runs: FakeRun[] = [];
  readonly moves: (readonly [from: string, to: string])[] = [];
  private readonly setup: FakeProgramSystemSetup;

  constructor(setup: FakeProgramSystemSetup) {
    this.setup = setup;
    this.platform = setup.platform;
    this.pid = setup.pid ?? 1000;
  }

  async listFolder(path: string): Promise<readonly string[]> {
    return found(this.setup.folders, path);
  }

  async readLink(path: string): Promise<string> {
    return found(this.setup.links, path);
  }

  async readText(path: string): Promise<string> {
    return found(this.setup.texts, path);
  }

  async run(program: string, args: readonly string[], timeoutMs: number): Promise<ProgramOutput> {
    this.runs.push({ program, args, timeoutMs });
    return this.setup.output ?? { error: null, stdout: '' };
  }

  async move(from: string, to: string): Promise<void> {
    const code = this.setup.moveCodes?.[this.moves.length];
    this.moves.push([from, to]);
    if (code !== undefined) {
      throw systemError(code, `${code}: refused`);
    }
  }

  uniqueSuffix(): string {
    return this.setup.suffix ?? 'fake0001';
  }
}

function found<T>(store: Readonly<Record<string, T>> | undefined, path: string): T {
  const value = store?.[path];
  if (value === undefined) {
    throw systemError('ENOENT', `ENOENT: no such file or directory, '${path}'`);
  }
  return value;
}
