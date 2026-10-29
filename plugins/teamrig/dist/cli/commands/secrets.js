import { resolve } from 'node:path';
import { secretGuardOf, secretPatternsOf } from "../../hooks/secret-guard.js";
import { CommitScanner } from "../../secret-guard/commit-scan.js";
import { messageLines } from "../../secret-guard/git-adds.js";
import { pushRanges, rangeArgs } from "../../secret-guard/push-range.js";
import { secretRulesOf } from "../../secret-guard/rules.js";
import { UsageError, noPositionals, onePositional } from "../args.js";
import { EXIT, RefusedError } from "../runtime.js";
import { guardLoadOf } from "./hook-guard-load.js";
/** The tail of every refusal: a fix in the repo does not take back a copy that already left it. */
const LEAKED = 'a value that already left this machine counts as leaked: rotate it';
/** How a secret in a change or a push comes out: read it by reference, never by value. */
const BY_REFERENCE = 'read the value by reference (an environment variable, or a file outside the repo) and build a test fixture at run time';
/**
 * `secrets staged`: the secrets the staged change adds, for a git pre-commit hook (T1480). Any one is REFUSED, exit 2,
 * named by place and shape, never by value; a git that cannot read the change FAILED, exit 1, so no commit passes unread.
 */
export async function staged(args, runtime) {
    noPositionals(args);
    const root = repoRoot(runtime);
    const adds = runtime.secretsGit.staged(runtime.cwd);
    if (adds === undefined) {
        throw new Error(`git cannot read the staged change in ${runtime.cwd}`);
    }
    refuseFound('the staged change adds', (await scannerOf(runtime, root)).staged(adds), `unstage it, ${BY_REFERENCE}`);
    runtime.out.stdout(`OK no secret in the staged change (${adds.paths.length} file(s))`);
    return EXIT.ok;
}
/**
 * `secrets message <file>`: the secrets a commit message file holds, above a verbose commit's cut line, for a git
 * commit-msg hook. A message names no path, so it needs no repository.
 */
export async function message(args, runtime) {
    const path = resolve(runtime.cwd, onePositional(args, 'file'));
    const text = await runtime.files.read(path);
    if (text === undefined) {
        throw new Error(`no commit message file at ${path}`);
    }
    refuseFound('the commit message holds', (await scannerOf(runtime, runtime.cwd)).message(messageLines(text)), 'take it out of the message');
    runtime.out.stdout('OK no secret in the commit message');
    return EXIT.ok;
}
/**
 * `secrets pushed <remote>`: the secrets the commits a push sends add, in their patches and messages, from the lines
 * git writes to a pre-push hook's stdin. It catches commits made before the hooks were there, or past them.
 */
export async function pushed(args, runtime) {
    const remote = onePositional(args, 'remote');
    if (remote === '') {
        throw new UsageError(`${args.command} needs <remote>`);
    }
    const root = repoRoot(runtime);
    const git = runtime.secretsGit;
    const ranges = pushRanges(await runtime.readStdin(), remote, (sha) => git.isCommit(runtime.cwd, sha));
    // Two refs can send the same commit: each is scanned once.
    const commits = new Map();
    for (const range of ranges) {
        const listed = git.commits(runtime.cwd, range);
        if (listed === undefined) {
            throw new Error(`git cannot list the commits ${rangeArgs(range).join(' ')} in ${runtime.cwd}`);
        }
        for (const commit of listed) {
            commits.set(commit.sha, commit);
        }
    }
    refuseFound(`the push to ${remote} adds`, (await scannerOf(runtime, root)).pushed([...commits.values()]), `rewrite those commits without it before the push, ${BY_REFERENCE}`);
    runtime.out.stdout(`OK no secret in the ${commits.size} commit(s) pushed to ${remote}`);
    return EXIT.ok;
}
function repoRoot(runtime) {
    const root = runtime.secretsGit.root(runtime.cwd);
    if (root === undefined) {
        throw new Error(`${runtime.cwd} is not in a git repository`);
    }
    return root;
}
/**
 * The default shapes and secret paths, plus the team's own inside a team found from the folder as the guards find it.
 * Outside a team, or with a config that cannot be read, the defaults still scan: the repo's owner put the hook there.
 */
async function scannerOf(runtime, root) {
    const load = (await guardLoadOf(undefined, runtime))?.load;
    const rules = secretRulesOf(secretGuardOf(load), runtime.userHome, runtime.platform, secretPatternsOf(load));
    return new CommitScanner(rules.shapes, rules.paths, root);
}
function refuseFound(head, findings, fix) {
    if (findings.length > 0) {
        throw new RefusedError([`${head} ${findings.length} secret(s), named by place and shape, never by value:`, ...findings.map(({ where, description }) => `  ${where}: ${description}`), `Fix: ${fix}; ${LEAKED}.`].join('\n'));
    }
}
