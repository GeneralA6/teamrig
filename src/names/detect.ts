import type { Roster } from '../config/roster.ts';
import { titleKey } from '../core/ids.ts';
import { checkRename, recordRename, type RenameDeps } from './record.ts';
import type { Rename } from './rename.ts';

/** What a hook did with the Claude Code title of the session it runs for. */
export type TitleOutcome =
  /** No title, or no team session it could belong to. */
  | { readonly kind: 'none' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'recorded'; readonly rename: Rename }
  | { readonly kind: 'refused'; readonly title: string; readonly reason: string }
  /** Reading or writing failed; the next prompt tries again. */
  | { readonly kind: 'failed'; readonly error: string };

/**
 * Records the title the user gave session `id` in Claude Code as the session's own rename; its id is
 * no rename, since a tab may be titled by its id to bind it (hooks/bind.ts). The
 * roster read without the lock settles the common cases, the same name or a refused one, so a hook
 * on every prompt takes the lock only to record.
 */
export async function adoptTitle(deps: RenameDeps, roster: Roster, id: string, title: string): Promise<TitleOutcome> {
  const name = titleKey(title);
  if (name === id) {
    // The id always names the session, so a tab titled by its id (to bind it) keeps the session's name.
    return { kind: 'unchanged' };
  }
  const request = { id, to: name, by: id };
  const check = checkRename(roster, request);
  if (check.kind === 'unchanged') {
    return { kind: 'unchanged' };
  }
  if (check.kind === 'refused') {
    return { kind: 'refused', title, reason: check.reason };
  }
  const outcome = await recordRename(deps, request);
  switch (outcome.kind) {
    case 'recorded':
      return { kind: 'recorded', rename: outcome.rename };
    case 'unchanged':
      return { kind: 'unchanged' };
    case 'refused':
      return { kind: 'refused', title, reason: outcome.reason };
  }
}

/** The SessionStart note: what happened to the title, or undefined when there is nothing to say. */
export function sessionStartNote(outcome: TitleOutcome): string | undefined {
  switch (outcome.kind) {
    case 'none':
    case 'unchanged':
      return undefined;
    case 'recorded':
      return `This session was renamed in Claude Code, so its team name is now \`${outcome.rename.to}\` (was \`${outcome.rename.from}\`); the old name still finds it.`;
    case 'refused':
      return `This session's Claude Code title "${outcome.title}" is not its team name: ${outcome.reason}.`;
    case 'failed':
      return `This session's Claude Code title could not be checked against its team name (${outcome.error}); the next prompt tries again.`;
  }
}

/** The prompt hook's note: one line when a rename was recorded; quiet otherwise, as it runs on every prompt. */
export function promptNote(outcome: TitleOutcome, command: string): string | undefined {
  return outcome.kind === 'recorded'
    ? `${command}: this session's team name is now \`${outcome.rename.to}\` (was \`${outcome.rename.from}\`), from its Claude Code title; the old name still finds it.`
    : undefined;
}
