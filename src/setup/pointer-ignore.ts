import type { Files } from '../core/files.ts';
import { TEAM_POINTER } from '../core/team.ts';

/**
 * A team pointer names a team in this machine's kit home, which no other clone of the repository has,
 * so `team create` keeps it out of git: one line in the repository's own exclude file
 * (`.git/info/exclude`), which git never commits, so the repository's shared files stay as they are.
 */

/** Where a pointer file stands in git. `no-git`: outside a repository, or git could not tell. */
export type PointerInGit =
  | { readonly kind: 'no-git' }
  | { readonly kind: 'tracked' }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'open'; readonly exclude: string };

/** The git reads behind a pointer's ignore step. */
export interface PointerGit {
  /** Where the file at `path` stands, whether or not it exists yet; `open` names its repository's exclude file. */
  state(path: string): PointerInGit;
}

/** The exclude line: every team pointer in the repository, at any depth. */
export const POINTER_EXCLUDE_LINE = TEAM_POINTER;

/** What the setup does about the pointer in git: add the exclude line, leave a committed or ignored one as it is, or nothing outside git. */
export type IgnoreStep =
  | { readonly kind: 'add'; readonly pointer: string; readonly exclude: string }
  | { readonly kind: 'keep'; readonly pointer: string; readonly why: string }
  | { readonly kind: 'none' };

export function ignoreStep(git: PointerGit, pointer: string): IgnoreStep {
  const state = git.state(pointer);
  switch (state.kind) {
    case 'no-git':
      return { kind: 'none' };
    case 'tracked':
      return { kind: 'keep', pointer, why: `it is committed, so every clone gets it; to keep it on this machine only, run git rm --cached ${TEAM_POINTER} and commit` };
    case 'ignored':
      return { kind: 'keep', pointer, why: 'git already ignores it' };
    case 'open':
      return { kind: 'add', pointer, exclude: state.exclude };
  }
}

/** Appends the exclude line, on a line of its own after any text the file ends without a newline. */
export async function applyIgnore(files: Files, step: IgnoreStep): Promise<void> {
  if (step.kind !== 'add') {
    return;
  }
  const text = (await files.read(step.exclude)) ?? '';
  const gap = text === '' || text.endsWith('\n') ? '' : '\n';
  await files.append(step.exclude, `${gap}${POINTER_EXCLUDE_LINE}\n`);
}

/** The summary line of an ignore step, or none outside git. */
export function ignoreLines(step: IgnoreStep, dryRun: boolean): string[] {
  switch (step.kind) {
    case 'none':
      return [];
    case 'keep':
      return [`UNCHANGED ${step.pointer} in git: ${step.why}`];
    case 'add':
      return [`${dryRun ? 'WOULD ADD' : 'ADDED'} ${POINTER_EXCLUDE_LINE} to ${step.exclude}: git ignores it in this clone only, as the team it names exists on this machine only`];
  }
}
