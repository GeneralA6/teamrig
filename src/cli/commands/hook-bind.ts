import { errorMessage } from '../../core/guards.ts';
import type { Roster } from '../../config/roster.ts';
import { ENV, KIT_NAME } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import { sessionTitleOf } from '../../names/title.ts';
import { bindByEnv, bindByProcess, bindByTitle, bindHint, hintReason, processBoundNote, refreshedIn, type BindOutcome, type TeamRoster } from '../../hooks/bind.ts';
import { firstHint, JsonlHintLog } from '../../hooks/hint-log.ts';
import { injectFor } from '../../inbox/inject.ts';
import { claudeProcessOf } from '../../refresh/restart.ts';
import type { RefreshState } from '../../refresh/state.ts';
import { RefreshStore } from '../../refresh/store.ts';
import { hookLogOf } from '../hook-logs.ts';
import type { Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { inboxDepsOf } from './inbox.ts';

/**
 * The hooks' side of a tab's identity: binding a hand-started tab by its Claude Code title, the one
 * line that says how to bind a tab that is not, and the inbox lines a bound tab is shown. hook.ts
 * calls these; the decisions themselves live in hooks/bind.ts and inbox/inject.ts.
 */

/** The tab's Claude Code title as the user set it (names/title.ts), or why it could not be read. */
export type TitleRead = { readonly kind: 'read'; readonly title: string | undefined } | { readonly kind: 'failed'; readonly error: string };

/** Reads the title once for everything a hook does with it; it never throws. */
export async function readTitle(runtime: CliRuntime, payload: unknown): Promise<TitleRead> {
  try {
    return { kind: 'read', title: await sessionTitleOf(payload, runtime.files) };
  } catch (error) {
    return { kind: 'failed', error: errorMessage(error) };
  }
}

/** A tab's binding, with the team roster it was judged on. */
export interface TabBinding {
  readonly own: TeamRoster;
  readonly outcome: BindOutcome;
}

/** The other teams of `team`'s tree, read from every team config of the kit home. */
async function treeTeamsOf(runtime: CliRuntime, team: string): Promise<TeamRoster[]> {
  const { tree, teams } = await loadTree(runtime);
  return [...teams].filter(([other]) => other !== team && tree.sameTree(other, team)).map(([other, { roster }]) => ({ team: other, roster }));
}

/**
 * Binds the tab to the session its title names (hooks/bind.ts), unless `$TEAMRIG_SESSION` or a mark
 * already names it. It never throws, so the hook always answers: a failure is an outcome, and the
 * next prompt tries again.
 */
export async function bindTab(runtime: CliRuntime, kit: Kit, own: TeamRoster, claudeSession: string, title: TitleRead): Promise<TabBinding> {
  try {
    const outcome = await bindByTitle(
      { marks: inboxDepsOf(runtime, kit.paths).marks, treeTeams: () => treeTeamsOf(runtime, own.team) },
      { own, claudeSession, envSession: (runtime.env[ENV.session]?.trim() ?? '') !== '', title: title.kind === 'read' ? title.title : undefined, now: new Date(runtime.clock.now()) },
    );
    // A title that could not be read matters only to a tab nothing else binds.
    return { own, outcome: title.kind === 'failed' && outcome.kind === 'untitled' ? { kind: 'failed', error: title.error } : outcome };
  } catch (error) {
    return { own, outcome: { kind: 'failed', error: errorMessage(error) } };
  }
}

/**
 * After a /clear its title could not bind: binds the tab to the session that refreshed in this hook's Claude
 * Code process (hooks/bind.ts), and gives the SessionStart note for it. It never throws: a failure is the note.
 */
export async function bindAfterClear(runtime: CliRuntime, kit: Kit, roster: Roster, claudeSession: string): Promise<string | undefined> {
  try {
    const pid = await claudeProcessOf(runtime.sessionProcesses, runtime.sessionProcesses.parentPid);
    if (pid === undefined) {
      return undefined;
    }
    const now = new Date(runtime.clock.now());
    const store = new RefreshStore(runtime.files, kit.paths);
    const refreshedHere = async (): Promise<string[]> => {
      const states = new Map<string, RefreshState | undefined>();
      for (const id of roster.ids) {
        states.set(id, await store.state(id));
      }
      return refreshedIn(states, pid, now);
    };
    const bound = await bindByProcess({ marks: inboxDepsOf(runtime, kit.paths).marks, refreshedHere }, claudeSession, now);
    return bound === undefined ? undefined : processBoundNote(bound.id);
  } catch (error) {
    return `${KIT_NAME} could not bind this tab by its Claude Code process (${errorMessage(error)}).`;
  }
}

/**
 * Binds the tab `$TEAMRIG_SESSION` names to session `id` (hooks/bind.ts). It never throws, so the start always
 * loads: a failure is the SessionStart note, and the tab's first `inbox read` writes the mark.
 */
export async function bindNamedTab(runtime: CliRuntime, kit: Kit, id: string, claudeSession: string): Promise<string | undefined> {
  try {
    await bindByEnv(inboxDepsOf(runtime, kit.paths).marks, id, claudeSession, new Date(runtime.clock.now()));
    return undefined;
  } catch (error) {
    return `${KIT_NAME} could not bind this tab to the \`${id}\` session (${errorMessage(error)}); its first \`inbox read\` does.`;
  }
}

/** The prompt hook's line for a tab it could not bind, once per Claude Code session and reason; undefined otherwise. */
export async function bindHintOnce(runtime: CliRuntime, kit: Kit, binding: TabBinding, claudeSession: string): Promise<string | undefined> {
  const hint = bindHint(binding.outcome, binding.own, KIT_NAME);
  const reason = hintReason(binding.outcome);
  if (hint === undefined || reason === undefined) {
    return undefined;
  }
  const log = new JsonlHintLog(hookLogOf(runtime, kit.paths, 'bind-hints'));
  return (await firstHint(log, claudeSession, reason, new Date(runtime.clock.now()))) ? hint : undefined;
}

/** The session's new inbox lines for this prompt (inbox/inject.ts) on the team's clock, recorded as shown; undefined when none wait. */
export function inboxLinesFor(runtime: CliRuntime, kit: Kit, session: string, claudeSession: string, zone: TimeZone): Promise<string | undefined> {
  return injectFor(inboxDepsOf(runtime, kit.paths), { area: session, claudeSession, now: new Date(runtime.clock.now()), zone, command: KIT_NAME });
}
