import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { outcome, query, queryBytes, queryLine, runGit } from "../core/git-run.js";
import { printable } from "../core/printable.js";
/** The remote a branch is pushed to, and the one a deploy pulls from. */
export const ORIGIN = 'origin';
/** A fetch, a push of a deleted branch or a rebase talks to a remote or rewrites commits: allow it far longer than a query. */
const LONG_TIMEOUT_MS = 120_000;
const DEFAULT_BRANCHES = ['main', 'master'];
/** Where git keeps its copies of `remote`'s branches. */
function trackingRefs(remote) {
    return `refs/remotes/${remote}/`;
}
/** A full commit id: SHA-1, or SHA-256 in a repository that uses it. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function lines(text) {
    return text === undefined ? [] : text.split('\n').filter((line) => line !== '');
}
function samePlace(a, b) {
    return resolve(a) === resolve(b);
}
/** Aborts the rebase that stopped in `dir` and says why it stopped (see {@link rebaseStopReason}). */
function rebaseStopped(dir, onto, said) {
    const conflicts = (query(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U', '-z']) ?? '').split('\0').filter((path) => path !== '');
    const abort = outcome(runGit(dir, ['rebase', '--abort'], LONG_TIMEOUT_MS), 'git rebase --abort');
    return rebaseStopReason(onto, conflicts, said, abort);
}
/**
 * Why a rebase stopped: its conflicting paths when it has any, else git's own reason. A conflict also says the way
 * out: a force-push of a branch already pushed for review would throw away what its reviewers saw, so the resolved
 * change goes out again under a new branch name. The paths print with control characters escaped: `-z` leaves them
 * raw, and a newline or ESC in one would add lines to the reason or reach the terminal.
 */
export function rebaseStopReason(onto, conflicts, said, abort) {
    const why = conflicts.length > 0 ? `conflicts in ${conflicts.map(printable).join(', ')}` : said;
    const aborted = abort.ok || /no rebase in progress/i.test(abort.reason);
    const left = aborted ? 'aborted, the branch is as it was' : `git rebase --abort failed too (${abort.reason}): finish or abort it by hand`;
    const fix = aborted && conflicts.length > 0 ? `; to land it, rebase onto ${onto} by hand, resolve those files and merge again, a branch already pushed for review under a new name, never force-pushed` : '';
    return `rebase onto ${onto} stopped (${why}); ${left}${fix}`;
}
/**
 * A refusal when `name` starts with '-', which git would read as an option; undefined otherwise. `checkout` and `reset`
 * cannot end their options with `--end-of-options` as the other steps do (git 2.39 reads it there as a pathspec or
 * refuses it), so they take the name before a `--` and need this check: no branch or commit name starts with '-'.
 */
function refusedAsOption(name, what) {
    return name.startsWith('-') ? { ok: false, reason: `${what} refused "${name}": a branch or commit name never starts with "-"` } : undefined;
}
/** The branch a remote's default is taken to be when it names none of its own. */
export const FALLBACK_BRANCH = 'main';
/** `remote`'s default branch, read through `run`: `<remote>/HEAD`, else `main` or `master` when the remote has it, else {@link FALLBACK_BRANCH}. */
function defaultBranchBy(run, remote) {
    const refs = trackingRefs(remote);
    const said = run(['symbolic-ref', '--quiet', `${refs}HEAD`]);
    const head = said.status === 0 ? said.stdout.trim() : '';
    if (head.startsWith(refs)) {
        return head.slice(refs.length);
    }
    return DEFAULT_BRANCHES.find((name) => run(['show-ref', '--verify', '--quiet', `${refs}${name}`]).status === 0) ?? FALLBACK_BRANCH;
}
/** A read git did not answer, naming it and why; {@link readOrUnanswered} turns it into its {@link GitRead}. */
class Unanswered extends Error {
}
/** git's answer to a read in `dir`; throws {@link Unanswered} when git gave none. */
function answer(dir, args) {
    const run = runGit(dir, args);
    if (run.unanswered !== undefined) {
        throw new Unanswered(`git ${args.join(' ')} in ${dir} did not answer: ${run.unanswered}`);
    }
    return run;
}
/** A read made of several git reads, or the first one git did not answer. */
function readOrUnanswered(read) {
    try {
        return { ok: true, value: read() };
    }
    catch (error) {
        if (error instanceof Unanswered) {
            return { ok: false, reason: error.message };
        }
        throw error;
    }
}
/** `file`'s path inside the checkout at `top`, with forward slashes; undefined when it is the top itself or outside it. */
export function pathInCheckout(top, file) {
    const path = relative(top, file).replaceAll('\\', '/');
    return path === '' || path.startsWith('../') || isAbsolute(path) ? undefined : path;
}
/** The most output one `cat-file --batch` read may print: room for a large tool's whole code. */
const BATCH_MAX_BYTES = 256 * 1024 * 1024;
/** A found object's line in `git cat-file --batch` output: `<id> <type> <size>`. */
const BATCH_FOUND = /^[0-9a-f]{40,64} ([a-z]+) (\d+)$/;
/**
 * What `git cat-file --batch` printed for `count` names, in the order asked (T4035): each answer is a found object's
 * `<id> <type> <size>` line, its `size` bytes and a line break, or one line naming what it could not find, read as
 * undefined. Undefined when the output does not hold exactly `count` whole answers.
 */
export function catFileBatchOf(output, count) {
    const answers = [];
    let at = 0;
    while (answers.length < count) {
        const end = output.indexOf(0x0a, at);
        if (end < 0) {
            return undefined;
        }
        const found = BATCH_FOUND.exec(output.toString('utf8', at, end));
        at = end + 1;
        const type = found?.[1];
        if (found === null || type === undefined) {
            answers.push(undefined);
            continue;
        }
        const size = Number(found[2]);
        if (at + size >= output.length || output[at + size] !== 0x0a) {
            return undefined;
        }
        answers.push({ type, text: output.toString('utf8', at, at + size) });
        at += size + 1;
    }
    return at === output.length ? answers : undefined;
}
/** A one-line answer, or undefined when git said no or nothing. */
function lineOf(run) {
    const line = run.stdout.trim();
    return run.status === 0 && line !== '' ? line : undefined;
}
/** {@link MergeGit.fileCheckout} by the git CLI; throws {@link Unanswered}. */
function fileCheckoutOf(file) {
    const where = answer(dirname(file), ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
    const [top, commonDir] = where.status === 0 ? lines(where.stdout) : [];
    if (top === undefined || commonDir === undefined) {
        return undefined;
    }
    const status = answer(top, ['status', '--porcelain', '--untracked-files=normal']);
    const path = pathInCheckout(top, file);
    // Literal pathspecs, so a `*` or `[` in the file's name matches only that file; a folder lists its files, not itself.
    const listed = path === undefined ? undefined : answer(top, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', '--full-tree', '--end-of-options', 'HEAD', '--', path]);
    const mainRef = `${ORIGIN}/${defaultBranchBy((args) => answer(top, args), ORIGIN)}`;
    return {
        top,
        commonDir,
        clean: status.status === 0 && lines(status.stdout).length === 0,
        tracked: listed?.status === 0 && listed.stdout.split('\0').includes(path ?? ''),
        head: lineOf(answer(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'])),
        headTree: lineOf(answer(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}^{tree}'])),
        mainRef,
        mainTree: lineOf(answer(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${mainRef}^{commit}^{tree}`])),
    };
}
/** The git CLI. */
export const GIT_MERGE = {
    checkoutOf(dir) {
        const [top, gitDir, commonDir] = lines(query(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']));
        if (top === undefined || gitDir === undefined || commonDir === undefined) {
            return undefined;
        }
        return {
            top,
            branch: queryLine(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
            mainCheckout: basename(commonDir) === '.git' ? dirname(commonDir) : undefined,
            linked: !samePlace(gitDir, commonDir),
        };
    },
    commonDir: (dir) => queryLine(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    changes(dir, untracked) {
        const text = query(dir, ['status', '--porcelain', `--untracked-files=${untracked ? 'normal' : 'no'}`]);
        return text === undefined ? undefined : lines(text);
    },
    fetch: (dir, remote) => outcome(runGit(dir, ['fetch', '--prune', '--end-of-options', remote], LONG_TIMEOUT_MS), 'git fetch'),
    defaultBranch: (dir, remote) => defaultBranchBy((args) => runGit(dir, args), remote),
    fileCheckout: (file) => readOrUnanswered(() => fileCheckoutOf(file)),
    repositoryOf: (dir) => readOrUnanswered(() => {
        const run = answer(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        const line = run.stdout.trim();
        return run.status === 0 && line !== '' ? line : undefined;
    }),
    gitVersion: (dir) => /^git version (\d+(?:\.\d+)*)/.exec(queryLine(dir, ['version']) ?? '')?.[1],
    sha: (dir, ref) => queryLine(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]),
    treeOf: (dir, ref) => queryLine(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}^{tree}`]),
    remoteHead(dir, remote, branch) {
        const ref = `refs/heads/${branch}`;
        const run = runGit(dir, ['ls-remote', '--end-of-options', remote, ref], LONG_TIMEOUT_MS);
        const found = run.status === 0 ? lines(run.stdout).map((line) => line.split('\t')).find(([, name]) => name === ref) : undefined;
        const sha = found?.[0];
        return sha !== undefined && FULL_SHA.test(sha) ? sha : undefined;
    },
    mergeBase: (dir, a, b) => queryLine(dir, ['merge-base', '--end-of-options', a, b]),
    changedPaths(dir, base, head) {
        const text = query(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', '--end-of-options', base, head, '--']);
        return text === undefined ? undefined : text.split('\0').filter((path) => path !== '');
    },
    fileAt: (dir, ref, path) => query(dir, ['cat-file', 'blob', `${ref}:${path}`]),
    filesAt(dir, ref, paths) {
        // `cat-file --batch` reads one name a line, so a ref or path holding a line break cannot be asked.
        if ([ref, ...paths].some((name) => name.includes('\n'))) {
            return undefined;
        }
        // The commit is asked first in the same run, so a ref that names none tells nothing, and git starts once.
        const names = [`${ref}^{commit}`, ...paths.map((path) => `${ref}:${path}`)];
        const output = queryBytes(dir, ['cat-file', '--batch'], names.map((name) => `${name}\n`).join(''), BATCH_MAX_BYTES);
        const answers = output === undefined ? undefined : catFileBatchOf(output, names.length);
        if (answers?.[0]?.type !== 'commit') {
            return undefined;
        }
        const files = new Map();
        paths.forEach((path, at) => {
            const found = answers[at + 1];
            if (found?.type === 'blob') {
                files.set(path, found.text);
            }
        });
        return files;
    },
    blobsAt(dir, ref, paths) {
        const wanted = new Set(paths);
        if (wanted.size === 0) {
            return new Map();
        }
        // Literal pathspecs, so a `*` or `[` in a file's name matches only that file. A path that is a folder at `ref`
        // lists its files instead, which are not asked for: such a path has no file there.
        const text = query(dir, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', '--end-of-options', ref, '--', ...wanted]);
        if (text === undefined) {
            return undefined;
        }
        const blobs = new Map();
        for (const entry of text.split('\0')) {
            // `<mode> <type> <id>\t<path>`
            const tab = entry.indexOf('\t');
            const id = entry.slice(0, tab).split(' ')[2];
            const path = entry.slice(tab + 1);
            if (tab > 0 && id !== undefined && wanted.has(path)) {
                blobs.set(path, id);
            }
        }
        return blobs;
    },
    commits: (dir, from, to) => lines(query(dir, ['rev-list', '--reverse', '--end-of-options', `${from}..${to}`])),
    isAncestor: (dir, ancestor, descendant) => runGit(dir, ['merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant]).status === 0,
    rebase(dir, onto) {
        const run = runGit(dir, ['rebase', '--end-of-options', onto], LONG_TIMEOUT_MS);
        const done = outcome(run, 'git rebase');
        return done.ok ? done : { ok: false, reason: rebaseStopped(dir, onto, done.reason) };
    },
    deleteRemoteBranch: (dir, branch) => outcome(runGit(dir, ['push', ORIGIN, '--delete', `refs/heads/${branch}`], LONG_TIMEOUT_MS), 'git push --delete'),
    detach: (dir) => outcome(runGit(dir, ['switch', '--detach']), 'git switch --detach'),
    deleteBranch: (dir, branch) => outcome(runGit(dir, ['branch', '-D', '--end-of-options', branch]), 'git branch -D'),
    updateLocalBranch(dir, remote, branch) {
        const done = outcome(runGit(dir, ['fetch', '.', `${trackingRefs(remote)}${branch}:refs/heads/${branch}`]), 'git fetch .');
        if (done.ok) {
            return { kind: 'updated' };
        }
        return /checked out|refusing to fetch/i.test(done.reason) ? { kind: 'checkedOut' } : { kind: 'failed', reason: done.reason };
    },
    checkout: (dir, branch) => refusedAsOption(branch, 'git checkout') ?? outcome(runGit(dir, ['checkout', branch, '--']), 'git checkout'),
    fastForward: (dir, to) => outcome(runGit(dir, ['merge', '--ff-only', '--end-of-options', to], LONG_TIMEOUT_MS), 'git merge --ff-only'),
    resetTo: (dir, to) => refusedAsOption(to, 'git reset --keep') ?? outcome(runGit(dir, ['reset', '--keep', to, '--'], LONG_TIMEOUT_MS), 'git reset --keep'),
    sshCommand: (dir) => queryLine(dir, ['config', '--get', 'core.sshCommand']),
};
