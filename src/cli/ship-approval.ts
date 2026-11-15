import { LeadTree } from '../config/lead-tree.ts';
import type { KitConfig } from '../config/types.ts';
import { formatAddress } from '../core/address.ts';
import type { Task } from '../register/fold.ts';
import { JsonlEventLog } from '../register/store.ts';
import { openKit, rosterOf, sessionIdOf, type KitReader } from './kit.ts';
import { RefusedError } from './runtime.ts';
import { tabSessionOf } from './tab-session.ts';
import { leadAboveOf } from './tree.ts';

/**
 * What the ship tool's merge reads from the register before it lets a branch merge (tools/ship/approval.ts, T2788):
 * who calls, the branch's task, and who may approve the caller's merge, read the way the push guard reads them
 * (hook-guard-outputs.ts `pushClearanceOf`).
 */
export interface MergeStanding {
  /** The calling session's id. */
  readonly caller: string;
  /** The task the register holds by the branch's id now; undefined when it holds none. */
  readonly task: Task | undefined;
  /**
   * Whose approval clears the caller's merge: its leaders, nearest first; for a child team's lead, the parent team's
   * lead as `<team>/<id>` (T1140); none for a root team's lead, whose own merge needs no approval.
   */
  readonly approvers: readonly string[];
}

/**
 * The merge standing of `callerText` (an id or a name, from `$TEAMRIG_SESSION`) on team `team` for task `taskId`.
 * Refused when the team's config does not load, the caller is no session of the team, or the caller is a child team's
 * lead whose parent team has no config to name who approves it.
 */
export async function mergeStandingOf(reader: KitReader, team: string, callerText: string, taskId: string): Promise<MergeStanding> {
  const kit = await openKit(reader, team);
  if (kit.load.status !== 'loaded') {
    throw new RefusedError(`team ${team}'s config at ${kit.load.path} is ${kit.load.status}: the merge cannot tell who approves it`);
  }
  const { config } = kit.load;
  const caller = sessionIdOf(await rosterOf(reader, kit, config), callerText);
  const { state } = await new JsonlEventLog(reader.files, kit.paths.events).read();
  return { caller, task: state.tasks.get(taskId), approvers: await approversOf(reader, team, config, caller) };
}

/**
 * The session a merge runs for (T2984, security condition C4): the one session of team `team` that the merging Claude
 * Code tab `claudeSession` is bound to (`tabSessionOf`), which must be the one `callerText` (`$TEAMRIG_SESSION`) names,
 * so a typed name moves no merge to another session's task. Refused when the config does not load or the tab is not
 * bound to that session alone.
 */
export async function tabCallerOf(reader: KitReader, team: string, claudeSession: string, callerText: string): Promise<string> {
  const kit = await openKit(reader, team);
  if (kit.load.status !== 'loaded') {
    throw new RefusedError(`team ${team}'s config at ${kit.load.path} is ${kit.load.status}: the merge cannot tell which session its tab is`);
  }
  const roster = await rosterOf(reader, kit, kit.load.config);
  const bound = await tabSessionOf(reader.files, kit.paths.inboxMarks, roster, claudeSession, callerText);
  if (bound === undefined) {
    throw new RefusedError(
      `this Claude Code tab is not bound to ${callerText} alone: a merge runs from the merging session's own tab, whose every inbox mark names that session (a tab that read another session's inbox merges nothing)`,
    );
  }
  return bound;
}

async function approversOf(reader: KitReader, team: string, config: KitConfig, caller: string): Promise<string[]> {
  if (caller !== config.roles.lead) {
    return new LeadTree(config).chainOf(caller);
  }
  const parent = config.team?.parent;
  if (parent === undefined) {
    return [];
  }
  const above = await leadAboveOf(reader, team, config);
  if (above === undefined) {
    throw new RefusedError(`team ${parent}, the parent team, has no config to name its lead, who approves the merges of ${team}'s lead`);
  }
  return [formatAddress(above)];
}
