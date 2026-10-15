import { errorMessage } from "../core/guards.js";
import { findProgram } from "../core/path-search.js";
/**
 * The oldest Claude Code teamrig runs on: every hook in hooks.json uses the exec form (`args`), which
 * Claude Code added in 2.1.139. Below it the hooks never start, so only a command run by hand says so.
 */
export const MIN_CLAUDE_CODE = { major: 2, minor: 1, patch: 139 };
/**
 * The oldest Node.js teamrig supports: package.json's `engines.node`. No older one is tested (the tests run
 * on Node.js 22 and 24); the built CLI may still start on one.
 */
export const MIN_NODE = { major: 22, minor: 18, patch: 0 };
/** Set by Claude Code 2.1.120 and later for the processes it starts, as `claude-code_2-1-300_harness`. */
export const AI_AGENT = 'AI_AGENT';
/** `22.18`, `v22.19.0` or `2.1.300` as a version; undefined for anything else. */
export function parseVersion(text) {
    const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
    return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? '0') };
}
/** The running Claude Code's version, from `$AI_AGENT`; undefined when it is missing or not Claude Code's. */
export function claudeCodeVersion(env) {
    const match = /^claude-code_(\d+)-(\d+)-(\d+)(?:_|$)/.exec(env[AI_AGENT] ?? '');
    return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}
export function versionText(version) {
    return `${version.major}.${version.minor}.${version.patch}`;
}
export function isOlder(version, minimum) {
    const order = version.major - minimum.major || version.minor - minimum.minor || version.patch - minimum.patch;
    return order < 0;
}
/** A version under its minimum as a problem; none when the version is unknown. */
function tooOld(running, minimum, problem) {
    return running === undefined || !isOlder(running, minimum) ? undefined : problem(versionText(running));
}
const CHECKS = [
    ['git', async (deps) => ((await findProgram('git', deps)) === undefined ? { kind: 'git-missing' } : undefined)],
    ['Claude Code', async (deps) => tooOld(claudeCodeVersion(deps.env), MIN_CLAUDE_CODE, (running) => ({ kind: 'claude-code-old', running }))],
    ['Node.js', async (deps) => tooOld(parseVersion(deps.nodeVersion), MIN_NODE, (running) => ({ kind: 'node-old', running }))],
];
/**
 * What is missing or too old, each check on its own: one that throws is a `check-failed` problem and the
 * others still run. It reads variables and stats files on PATH; it starts no process.
 */
export async function requirementProblems(deps) {
    const found = await Promise.all(CHECKS.map(async ([requirement, check]) => {
        try {
            return await check(deps);
        }
        catch (error) {
            return { kind: 'check-failed', requirement, reason: errorMessage(error) };
        }
    }));
    return found.filter((problem) => problem !== undefined);
}
export function requirementsCheck(deps) {
    return { problems: () => requirementProblems(deps) };
}
/** One plain line: what is wrong, then how to fix it. `command` is the CLI's name. */
export function describeRequirement(problem, command) {
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
