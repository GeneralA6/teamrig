import { errorMessage } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import { findProgram, type PathSearchDeps } from '../core/path-search.ts';

/**
 * The oldest Claude Code teamrig runs on: every hook in hooks.json uses the exec form (`args`), which
 * Claude Code added in 2.1.139. Below it the hooks never start, so only a command run by hand says so.
 */
export const MIN_CLAUDE_CODE: Version = { major: 2, minor: 1, patch: 139 };

/**
 * The oldest Node.js teamrig supports: package.json's `engines.node`. No older one is tested (the tests run
 * on Node.js 22 and 24); the built CLI may still start on one.
 */
export const MIN_NODE: Version = { major: 22, minor: 18, patch: 0 };

/** Set by Claude Code 2.1.120 and later for the processes it starts, as `claude-code_2-1-300_harness`. */
export const AI_AGENT = 'AI_AGENT';

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** `22.18`, `v22.19.0` or `2.1.300` as a version; undefined for anything else. */
export function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? '0') };
}

/** The running Claude Code's version, from `$AI_AGENT`; undefined when it is missing or not Claude Code's. */
export function claudeCodeVersion(env: Env): Version | undefined {
  const match = /^claude-code_(\d+)-(\d+)-(\d+)(?:_|$)/.exec(env[AI_AGENT] ?? '');
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function versionText(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function isOlder(version: Version, minimum: Version): boolean {
  const order = version.major - minimum.major || version.minor - minimum.minor || version.patch - minimum.patch;
  return order < 0;
}

/** What teamrig needs beside itself. */
export type Requirement = 'git' | 'Claude Code' | 'Node.js';

/**
 * - `git-missing`: no git on PATH;
 * - `claude-code-old` / `node-old`: the running version, under the minimum;
 * - `check-failed`: the check itself failed, so it is unknown.
 */
export type RequirementProblem =
  | { readonly kind: 'git-missing' }
  | { readonly kind: 'claude-code-old'; readonly running: string }
  | { readonly kind: 'node-old'; readonly running: string }
  | { readonly kind: 'check-failed'; readonly requirement: Requirement; readonly reason: string };

/** What the requirements check reads: the variables, the operating system, the files on PATH and the running Node.js. */
export interface RequirementDeps extends PathSearchDeps {
  /** `process.versions.node` of the process running teamrig. */
  readonly nodeVersion: string;
}

/** The requirements check as a port. `problems` never rejects: a check that fails is a `check-failed` problem. */
export interface RequirementsCheck {
  problems(): Promise<readonly RequirementProblem[]>;
}

/** A version under its minimum as a problem; none when the version is unknown. */
function tooOld(running: Version | undefined, minimum: Version, problem: (running: string) => RequirementProblem): RequirementProblem | undefined {
  return running === undefined || !isOlder(running, minimum) ? undefined : problem(versionText(running));
}

const CHECKS: ReadonlyArray<readonly [Requirement, (deps: RequirementDeps) => Promise<RequirementProblem | undefined>]> = [
  ['git', async (deps) => ((await findProgram('git', deps)) === undefined ? { kind: 'git-missing' } : undefined)],
  ['Claude Code', async (deps) => tooOld(claudeCodeVersion(deps.env), MIN_CLAUDE_CODE, (running) => ({ kind: 'claude-code-old', running }))],
  ['Node.js', async (deps) => tooOld(parseVersion(deps.nodeVersion), MIN_NODE, (running) => ({ kind: 'node-old', running }))],
];

/**
 * What is missing or too old, each check on its own: one that throws is a `check-failed` problem and the
 * others still run. It reads variables and stats files on PATH; it starts no process.
 */
export async function requirementProblems(deps: RequirementDeps): Promise<RequirementProblem[]> {
  const found = await Promise.all(
    CHECKS.map(async ([requirement, check]): Promise<RequirementProblem | undefined> => {
      try {
        return await check(deps);
      } catch (error) {
        return { kind: 'check-failed', requirement, reason: errorMessage(error) };
      }
    }),
  );
  return found.filter((problem): problem is RequirementProblem => problem !== undefined);
}

export function requirementsCheck(deps: RequirementDeps): RequirementsCheck {
  return { problems: () => requirementProblems(deps) };
}

/** One plain line: what is wrong, then how to fix it. `command` is the CLI's name. */
export function describeRequirement(problem: RequirementProblem, command: string): string {
  switch (problem.kind) {
    case 'git-missing':
      return `git is not installed or not on PATH, and ${command} needs it: install it from git-scm.com, then restart Claude Code.`;
    case 'claude-code-old':
      return `Claude Code ${problem.running} is older than ${command} needs (${versionText(MIN_CLAUDE_CODE)} or later): run claude update, then restart Claude Code.`;
    case 'node-old':
      return `Node.js ${problem.running} is older than ${command} supports (${versionText(MIN_NODE)} or later): install the current LTS from nodejs.org, then restart Claude Code.`;
    case 'check-failed':
      return `The ${command} check for ${problem.requirement} failed (${problem.reason}).`;
  }
}
