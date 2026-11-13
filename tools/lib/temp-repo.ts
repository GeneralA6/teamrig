import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The committer every temp repo is set up with. */
export const AUTHOR = { name: 'Dana Example', email: 'dana@example.com' } as const;

export interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Variables a git hook or a CI runner sets, which must never steer git or a CLI under test. */
const INHERITED_GIT = /^GIT(?:HUB)?_/i;

/**
 * A throwaway folder for one test, where the repo tools run as their own process.
 * - Git there reads no global or system config, so a developer's own settings (a configured
 *   denylist, commit signing, hooks) never leak in, and never finds a repo above the folder.
 * - Inherited `GIT_*` variables are dropped (a test run from a git hook gets GIT_DIR and
 *   GIT_INDEX_FILE, which would point git at the real repo), and so are `GITHUB_*` ones, so a
 *   CI run's own event never reaches a CLI under test.
 */
export class TempRepo {
  /** The working folder, where git and the CLIs run. */
  readonly dir: string;
  /** A folder beside `dir`, for files that must stay out of the repo, such as a CI event payload. */
  readonly outside: string;
  private readonly root: string;
  /** The environment git and the CLIs run in here, for a git adapter under test to run its own git in. */
  readonly env: Readonly<Record<string, string>>;

  constructor(prefix: string) {
    // The native realpath also spells out Windows' short 8.3 names (GitHub's runner has TEMP under RUNNER~1), as git
    // does when it prints a path: the JS realpath leaves them, and a spec's expected path would then differ from git's.
    this.root = mkdtempSync(join(realpathSync.native(tmpdir()), `teamrig-${prefix}-`));
    this.dir = join(this.root, 'repo');
    this.outside = join(this.root, 'outside');
    mkdirSync(this.dir);
    mkdirSync(this.outside);
    const globalConfig = join(this.root, 'gitconfig');
    writeFileSync(globalConfig, '');
    const inherited = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !INHERITED_GIT.test(entry[0]));
    this.env = {
      ...Object.fromEntries(inherited),
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: this.root,
    };
  }

  /** Makes `dir` a repo that commits as AUTHOR. */
  init(): this {
    this.git('init', '-q');
    this.git('config', 'user.name', AUTHOR.name);
    this.git('config', 'user.email', AUTHOR.email);
    return this;
  }

  /** Writes a file at a `/`-separated path under `dir`, creating its folders; returns its absolute path. */
  write(path: string, content: string): string {
    const absolute = join(this.dir, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    return absolute;
  }

  has(path: string): boolean {
    return existsSync(join(this.dir, ...path.split('/')));
  }

  /** Runs git in `dir`, fails the test when it fails, and returns its stdout. */
  git(...args: readonly string[]): string {
    const result = spawnSync('git', args, { cwd: this.dir, env: this.env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  }

  /**
   * Runs a tool's CLI in `dir` under this Node; `undefined` in `env` removes an inherited variable.
   * An override replaces the inherited name in any case: Windows reads names case-insensitively, and
   * Git Bash hands Node `COMSPEC` where cmd.exe hands it `ComSpec`. `input` is its stdin, which is empty when absent.
   */
  run(cli: string, args: readonly string[] = [], env: Readonly<Record<string, string | undefined>> = {}, input?: string): CliRun {
    return this.spawn(this.dir, cli, args, env, input);
  }

  /** Runs a tool's CLI as `run` does, but in `outside`, where git finds no repo. */
  runOutside(cli: string, args: readonly string[] = []): CliRun {
    return this.spawn(this.outside, cli, args, {});
  }

  private spawn(cwd: string, cli: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>, input?: string): CliRun {
    const overridden = new Set(Object.keys(env).map((name) => name.toUpperCase()));
    const inherited = Object.entries(this.env).filter(([name]) => !overridden.has(name.toUpperCase()));
    const merged = [...inherited, ...Object.entries(env)].filter((entry): entry is [string, string] => entry[1] !== undefined);
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env: Object.fromEntries(merged), encoding: 'utf8', ...(input === undefined ? {} : { input }) });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
