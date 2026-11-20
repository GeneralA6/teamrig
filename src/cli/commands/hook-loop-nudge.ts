import { toolUseFrom, type ToolUse } from '../../budget/line.ts';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { leadNudgeLine, leadWorkOf, taskOwnersOf } from '../../hooks/lead-boundary.ts';
import { chainOf, nudgeLine, turnTasksOf, turnToolsOf } from '../../hooks/loop-nudge.ts';
import { TRANSCRIPT_TAIL_BYTES } from '../../names/title.ts';
import type { HookEvent } from '../../ports/host/index.ts';
import { JsonlEventLog } from '../../register/store.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { transcriptsOf, usageIfMetered } from '../host.ts';
import { openKit, rosterOf, type Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { meterTabMidTurn } from './hook-budget.ts';
import { loadTree } from '../tree.ts';
import { readHookInput, sessionTeam, teamSessionOf, turnLeadPathsOf, writeReply, type HookInput } from './hook-input.ts';

/** The tool the hook fires for, from the event's call; undefined for an event with no call or a call with no id. */
function currentToolOf(event: HookEvent): ToolUse | undefined {
  const { call } = event;
  return call?.id === undefined ? undefined : toolUseFrom(call.id, call.name, call.input);
}

/**
 * The team session of this tab, looked up only when the budget or the lead boundary needs it; undefined for a tab
 * that is none of the team's.
 */
async function tabSessionOf(runtime: CliRuntime, kit: Kit, config: KitConfig, event: HookEvent): Promise<{ roster: Roster; id: string } | undefined> {
  if (!config.budget.enabled && !config.leadBoundary.enabled) {
    return undefined;
  }
  const roster = await rosterOf(runtime, kit, config);
  const id = await teamSessionOf(runtime, kit, roster, event.session ?? null);
  return id === undefined ? undefined : { roster, id };
}

/** The sessions that own the tasks the turn's prompt names, read from the register's working set; none when it names none. */
async function promptTaskOwners(runtime: CliRuntime, kit: Kit, config: KitConfig, tasks: readonly string[]): Promise<readonly string[]> {
  if (tasks.length === 0) {
    return [];
  }
  const { state } = await new JsonlEventLog(runtime.files, kit.paths.events).read();
  return taskOwnersOf(tasks, state.tasks, config.roles.lead);
}

/**
 * The lead-boundary line after `current`, with the team tree read for its sub-teams' folders and the register for
 * the owners of the task folders the turn searches. Only a research call reads the register for the owners of the
 * tasks the turn's prompt names, whom the line asks the lead to send the question to; an unreadable register leaves
 * it generic.
 */
async function leadBoundaryLine(runtime: CliRuntime, kit: Kit, config: KitConfig, text: string, cut: boolean, current: ToolUse): Promise<string | undefined> {
  const reader = transcriptsOf(runtime);
  const turn = turnToolsOf(reader, text, cut, current);
  const paths = await turnLeadPathsOf(runtime, kit, config, await loadTree(runtime), turn);
  const research = leadWorkOf(current, paths) === 'research';
  const owners = research ? await promptTaskOwners(runtime, kit, config, turnTasksOf(reader, text, cut)).catch((): readonly string[] => []) : [];
  return leadNudgeLine(turn, current, paths, config.leadBoundary.searchNudgeAt, owners);
}

/**
 * The lines for this hook input: the chain nudge and, on the lead's tab, the lead-boundary nudge; none for a
 * helper's call, outside a loaded team or with both off.
 */
async function loopNudgeLines({ event }: HookInput, runtime: CliRuntime): Promise<readonly string[]> {
  const transcript = event?.transcript;
  if (event === undefined || transcript === undefined || event.helper?.id !== undefined) {
    return [];
  }
  const found = await sessionTeam(event.cwd, runtime);
  const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
  if (kit === undefined || kit.load.status !== 'loaded') {
    return [];
  }
  const { config } = kit.load;
  const tab = await tabSessionOf(runtime, kit, config, event).catch(() => undefined);
  if (tab !== undefined) {
    // Apart from the nudges: a failed meter run leaves them, and the next call or the Stop hook meters again.
    await meterTabMidTurn(runtime, { kit, config, ...tab }, transcript).catch(() => false);
  }
  const at = config.loops.chainNudgeAt;
  // A failed lookup counts as another session.
  const lead = config.leadBoundary.enabled && tab?.id === config.roles.lead;
  const text = at > 0 || lead ? await runtime.files.readTail(transcript, TRANSCRIPT_TAIL_BYTES) : undefined;
  if (text === undefined) {
    return [];
  }
  const cut = Buffer.byteLength(text, 'utf8') >= TRANSCRIPT_TAIL_BYTES;
  const current = currentToolOf(event);
  // A host whose calls teamrig cannot price gets no chain nudge: the line is the price of the re-reads.
  const usage = at > 0 ? usageIfMetered(runtime) : undefined;
  const chain = usage === undefined ? undefined : nudgeLine(usage, chainOf(transcriptsOf(runtime), usage, text, cut, current), at);
  const boundary = lead && current !== undefined ? await leadBoundaryLine(runtime, kit, config, text, cut, current) : undefined;
  return [chain, boundary].filter((line): line is string => line !== undefined);
}

/**
 * PostToolUse on reads, edits, shell calls and web lookups: once a turn's run of single-step calls reaches
 * `loops.chainNudgeAt`, hands the model one line asking it to batch, priced in re-reads. On the lead's
 * tab it also hands the lead one line at its first edit outside its own files, its first test or build,
 * its first research and its `leadBoundary.searchNudgeAt`-th code search (lead-boundary.ts). A helper's calls
 * are skipped, since both count the main thread only. Outside a loaded team, with both
 * off or on any error it prints nothing. On a session's tab with the budget on it also meters the tab once its
 * transcript has grown `MID_TURN_METER_BYTES` past the stored cursor (T3298), printing nothing for that.
 */
export async function loopNudge(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const lines = await loopNudgeLines(await readHookInput(runtime), runtime).catch((): readonly string[] => []);
  if (lines.length > 0) {
    writeReply(runtime, 'tool-end', { context: lines.join('\n') });
  }
  return EXIT.ok;
}
