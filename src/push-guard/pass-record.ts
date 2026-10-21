import { join, resolve } from 'node:path';
import { isRecord } from '../core/guards.ts';

/**
 * A tree's pass record: proof that every local check passed on a committed tree, written only by the tool that ran
 * the checks (the repo's local runner from the pre-push hook, the ship tool), never by a session. It lives at
 * `<git common dir>/local-ci/<tree sha>.json`, so every worktree of a clone shares it:
 *   { "tree": "<sha>", "commit": "<sha>", "checks": ["<name>", ...], "passedAt": "<ISO time>", "node": "<version>" }
 * It is keyed by the tree, not the commit: a rebase that changes the tree needs a new pass, a reworded commit on the
 * same tree does not.
 */
export interface PassRecord {
  readonly tree: string;
  readonly commit: string;
  readonly checks: readonly string[];
  readonly passedAt: string;
  readonly node: string;
}

/** The folder in the git common dir that holds the pass records. */
export const PASS_RECORD_FOLDER = 'local-ci';

/** Where the pass record of a tree lives; `gitCommonDir` as `git rev-parse --git-common-dir` prints it, relative to `root` or absolute. */
export function passRecordPath(root: string, gitCommonDir: string, tree: string): string {
  return join(resolve(root, gitCommonDir), PASS_RECORD_FOLDER, `${tree}.json`);
}

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The record in a file's text, or undefined when there is none, it does not parse, or it proves another tree. */
export function parsePassRecord(text: string | undefined, tree: string): PassRecord | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { commit, checks, passedAt, node } = value;
  if (value['tree'] !== tree || typeof commit !== 'string' || !isStringList(checks) || typeof passedAt !== 'string' || typeof node !== 'string') return undefined;
  return { tree, commit, checks, passedAt, node };
}
