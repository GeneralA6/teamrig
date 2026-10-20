import { pathToFileURL } from 'node:url';
import { isRecord } from './json.ts';

/**
 * The small-commits rule over <base>..HEAD of the current folder, as a local check: exit 1 naming each
 * commit over the rule with no reason line. The rule and its reader come from a teamrig checkout's own
 * modules (the ones its push guard applies), so this copies no logic and follows the rule when it changes.
 * Usage: node size-rule.ts --teamrig <teamrig dir> [--base <ref>, default origin/main]
 */

/** The size rule as loaded from teamrig; a commit list is passed through untouched. */
export interface SizeRule {
  /** The commits in base..tip; null when git cannot list them. */
  between(dir: string, base: string, tip: string): unknown[] | null;
  /** The commits over the rule with no reason line. */
  large(commits: readonly unknown[]): unknown[];
  /** One message naming the large commits and what would let each through. */
  describe(large: readonly unknown[]): string;
}

type Call = (...args: readonly unknown[]) => unknown;

function callable(owner: Record<string, unknown>, key: string, where: string): Call {
  const fn = owner[key];
  if (typeof fn !== 'function') throw new Error(`${where} has no ${key}()`);
  return (...args) => Reflect.apply(fn, owner, args);
}

function recordIn(owner: unknown, key: string, where: string): Record<string, unknown> {
  const value = isRecord(owner) ? owner[key] : undefined;
  if (!isRecord(value)) throw new Error(`${where} has no ${key}`);
  return value;
}

function moduleRecord(module: unknown, where: string): Record<string, unknown> {
  if (!isRecord(module)) throw new Error(`${where} is not a module`);
  return module;
}

/** Imports a module by URL; a test stands in for it. */
export type Load = (url: string) => Promise<unknown>;

export async function loadSizeRule(teamrigDir: string, load: Load = url => import(url)): Promise<SizeRule> {
  const where = (path: string): string => `${teamrigDir}/src/${path}`;
  const url = (path: string): string => pathToFileURL(where(path)).href;
  const size = moduleRecord(await load(url('push-guard/commit-size.ts')), where('push-guard/commit-size.ts'));
  const git = await load(url('push-guard/git.ts'));
  const rule = recordIn(await load(url('config/defaults.ts')), 'DEFAULT_COMMITS', where('config/defaults.ts'));
  const between = callable(recordIn(git, 'GIT_COMMIT_LOG', where('push-guard/git.ts')), 'between', `${where('push-guard/git.ts')} GIT_COMMIT_LOG`);
  const largeCommits = callable(size, 'largeCommits', where('push-guard/commit-size.ts'));
  const describeLargeCommits = callable(size, 'describeLargeCommits', where('push-guard/commit-size.ts'));
  return {
    between: (dir, base, tip) => {
      const commits = between(dir, base, tip);
      return Array.isArray(commits) ? commits : null;
    },
    large: commits => {
      const large = largeCommits(commits, rule);
      if (!Array.isArray(large)) throw new Error('largeCommits() did not return a list');
      return large;
    },
    describe: large => {
      const text = describeLargeCommits(large, rule);
      if (typeof text !== 'string') throw new Error('describeLargeCommits() did not return text');
      return text;
    },
  };
}

export interface SizeRuleArgs {
  teamrig: string;
  base: string;
}

export function parseSizeRuleArgs(argv: readonly string[]): SizeRuleArgs {
  const usage = 'usage: size-rule.ts --teamrig <teamrig dir> [--base <ref>]';
  let teamrig: string | null = null;
  let base = 'origin/main';
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined || value.startsWith('--')) throw new Error(usage);
    if (flag === '--teamrig') teamrig = value;
    else if (flag === '--base') base = value;
    else throw new Error(usage);
  }
  if (teamrig === null) throw new Error(usage);
  return { teamrig, base };
}

export interface SizeRuleDeps {
  cwd: string;
  load: Load;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Exit 0 when no commit in base..HEAD goes over the rule without a reason line, else 1. */
export async function runSizeRule(argv: readonly string[], deps: SizeRuleDeps): Promise<number> {
  try {
    const { teamrig, base } = parseSizeRuleArgs(argv);
    const rule = await loadSizeRule(teamrig, deps.load);
    const commits = rule.between(deps.cwd, base, 'HEAD');
    if (commits === null) {
      deps.err(`size rule: git cannot list the commits in ${base}..HEAD`);
      return 1;
    }
    const large = rule.large(commits);
    if (large.length > 0) {
      deps.err(`size rule: ${rule.describe(large)}`);
      return 1;
    }
    deps.out(`size rule: ${commits.length} commit(s) in ${base}..HEAD, none large`);
    return 0;
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export const realSizeRuleDeps = (): SizeRuleDeps => ({ cwd: process.cwd(), load: url => import(url), out: line => console.log(line), err: line => console.error(line) });

if (import.meta.main) process.exitCode = await runSizeRule(process.argv.slice(2), realSizeRuleDeps());
