import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { QUERY_TIMEOUT_MS } from '../core/git-run.ts';
import { COMMIT_FORMAT, PATCH_FLAGS, commitsOf, patchAdds, tagOf, type CommitAdds, type PatchAdds, type TagMessage } from './git-adds.ts';
import { rangeArgs, type PushRange } from './push-range.ts';

/** The git reads `teamrig secrets` takes (T1480); each is undefined when git fails, so no scan passes unread. */
export interface SecretsGit {
  /** The top folder of the repository `dir` is in. */
  root(dir: string): string | undefined;
  /** What the staged change adds, from the index the commit is made from (a hook's `GIT_INDEX_FILE` too). */
  staged(dir: string): PatchAdds | undefined;
  /** Whether the repository holds the commit `sha`, a full hex id. */
  isCommit(dir: string, sha: string): boolean;
  /**
   * The commits of `range`, newest first, each with what its patch adds; a merge adds what its resolution added past
   * git's own merge of its parents (an evil merge), so a value put in only there is scanned too.
   */
  commits(dir: string, range: PushRange): CommitAdds[] | undefined;
  /**
   * The annotated tags `sha` names, outermost first, each with its message: none for a commit, and each tag a tag points
   * at down to the object below them (a tag of a tag); undefined when git fails or past `MAX_TAG_DEPTH` tags.
   */
  tagMessages(dir: string, sha: string): TagMessage[] | undefined;
  /** The folder git runs the hooks of the repository `dir` is in from: `core.hooksPath`, else its git folder's `hooks`. */
  hooksDir(dir: string): string | undefined;
}

/** A patch or a log of a whole push takes longer than a query, within what a hook waits. */
const PATCH_TIMEOUT_MS = 60_000;

/** The most a patch or a log may print; a longer one fails the scan rather than cut it. */
const MAX_OUTPUT = 64 * 1024 * 1024;

const HEX = /^[0-9a-f]+$/;

/** The most tags a pushed tag may point through (a tag of a tag of a tag...); a deeper chain fails the scan. */
export const MAX_TAG_DEPTH = 8;

/** A git run in `dir` that prints its output, undefined when git fails. */
type GitRun = (dir: string, args: readonly string[], timeout: number) => string | undefined;

/** The tags from `sha` down to the first object that is no tag, outermost first. */
function tagChain(run: GitRun, dir: string, sha: string): TagMessage[] | undefined {
  const tags: TagMessage[] = [];
  let at = sha;
  while (HEX.test(at)) {
    const type = run(dir, ['cat-file', '-t', at], QUERY_TIMEOUT_MS)?.trim();
    if (type !== 'tag') {
      return type === undefined ? undefined : tags;
    }
    if (tags.length === MAX_TAG_DEPTH) {
      return undefined;
    }
    const text = run(dir, ['cat-file', 'tag', at], QUERY_TIMEOUT_MS);
    const tag = text === undefined ? undefined : tagOf(text);
    if (tag === undefined) {
      return undefined;
    }
    tags.push({ sha: at, message: tag.message });
    at = tag.object;
  }
  return undefined;
}

/**
 * The git CLI in `env`, kept whole: in a git hook, GIT_DIR and GIT_INDEX_FILE name the repository and the index the
 * commit is made from (`git commit -a` stages into a temporary index), which `runGit` (core/git-run.ts) drops.
 */
export function gitSecrets(env: NodeJS.ProcessEnv): SecretsGit {
  const run: GitRun = (dir, args, timeout) => {
    const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: dir, env, encoding: 'utf8', timeout, maxBuffer: MAX_OUTPUT });
    return result.status === 0 ? result.stdout : undefined;
  };
  return {
    root: (dir) => run(dir, ['rev-parse', '--show-toplevel'], QUERY_TIMEOUT_MS)?.trim(),
    staged: (dir) => {
      const patch = run(dir, ['diff', '--cached', ...PATCH_FLAGS], PATCH_TIMEOUT_MS);
      return patch === undefined ? undefined : patchAdds(patch);
    },
    isCommit: (dir, sha) => HEX.test(sha) && run(dir, ['cat-file', '-e', `${sha}^{commit}`], QUERY_TIMEOUT_MS) !== undefined,
    // --root: a `log.showRoot` config off would print no patch for a first commit. --diff-merges=remerge (git 2.36+;
    // an older git fails, so the scan does) diffs a merge against git's own merge of its parents: only what the
    // resolution added, where a plain log prints no patch for a merge.
    commits: (dir, range) => {
      const log = run(dir, ['log', '--no-show-signature', '--root', '--diff-merges=remerge', COMMIT_FORMAT, '-p', ...PATCH_FLAGS, ...rangeArgs(range), '--'], PATCH_TIMEOUT_MS);
      return log === undefined ? undefined : commitsOf(log);
    },
    tagMessages: (dir, sha) => tagChain(run, dir, sha),
    // --git-path prints the path from `dir`, a relative core.hooksPath already taken from the top folder.
    hooksDir: (dir) => {
      const path = run(dir, ['rev-parse', '--git-path', 'hooks'], QUERY_TIMEOUT_MS)?.trim();
      return path === undefined || path === '' ? undefined : resolve(dir, path);
    },
  };
}
