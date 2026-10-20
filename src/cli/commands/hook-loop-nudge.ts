import { toolUseFrom, type ToolUse } from '../../budget/line.ts';
import type { KitConfig } from '../../config/types.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../../core/guards.ts';
import { leadNudgeLine, leadWorkOf, taskOwnersOf } from '../../hooks/lead-boundary.ts';
import { chainOf, nudgeLine, nudgeOutput, turnTasksOf, turnToolsOf } from '../../hooks/loop-nudge.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { TRANSCRIPT_TAIL_BYTES } from '../../names/title.ts';
import { JsonlEventLog } from '../../register/store.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit, rosterOf, type Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { leadPathsOf, parseJson, sessionTeam, teamSessionOf } from './hook-input.ts';

/** The tool the hook fires for, from its payload; undefined without an id or a name. */
function currentToolOf(payload: JsonRecord): ToolUse | undefined {
  const id = stringField(payload, 'tool_use_id');
  const name = stringField(payload, 'tool_name');
  return id === undefined || name === undefined ? undefined : toolUseFrom(id, name, recordField(payload, 'tool_input'));
}

/** This tab is the team's lead and the lead boundary is on; a failed lookup counts as another session. */
async function isLeadTab(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: JsonRecord): Promise<boolean> {
  if (!config.leadBoundary.enabled) {
    return false;
  }
  const roster = await rosterOf(runtime, kit, config);
  return (await teamSessionOf(runtime, kit, roster, sessionIdOf(payload))) === config.roles.lead;
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
 * The lead-boundary line after `current`. Only a research call reads the register, for the owners of the tasks the
 * turn's prompt names, whom the line asks the lead to send the question to; an unreadable register leaves it generic.
 */
async function leadBoundaryLine(runtime: CliRuntime, kit: Kit, config: KitConfig, text: string, cut: boolean, current: ToolUse): Promise<string | undefined> {
  const paths = leadPathsOf(runtime, kit, config);
  const research = leadWorkOf(current, paths) === 'research';
  const owners = research ? await promptTaskOwners(runtime, kit, config, turnTasksOf(text, cut)).catch((): readonly string[] => []) : [];
  return leadNudgeLine(turnToolsOf(text, cut, current), current, paths, config.leadBoundary.searchNudgeAt, owners);
}

/**
 * The lines for this payload: the chain nudge and, on the lead's tab, the lead-boundary nudge; none for a
 * helper's call, outside a loaded team or with both off.
 */
async function loopNudgeLines(payload: unknown, runtime: CliRuntime): Promise<readonly string[]> {
  const transcript = isRecord(payload) ? stringField(payload, 'transcript_path') : undefined;
  if (!isRecord(payload) || transcript === undefined || stringField(payload, 'agent_id') !== undefined) {
    return [];
  }
  const found = await sessionTeam(payload, runtime);
  const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
  if (kit === undefined || kit.load.status !== 'loaded') {
    return [];
  }
  const { config } = kit.load;
  const at = config.loops.chainNudgeAt;
  const lead = await isLeadTab(runtime, kit, config, payload).catch(() => false);
  const text = at > 0 || lead ? await runtime.files.readTail(transcript, TRANSCRIPT_TAIL_BYTES) : undefined;
  if (text === undefined) {
    return [];
  }
  const cut = Buffer.byteLength(text, 'utf8') >= TRANSCRIPT_TAIL_BYTES;
  const current = currentToolOf(payload);
  const chain = at > 0 ? nudgeLine(chainOf(text, cut, current), at) : undefined;
  const boundary = lead && current !== undefined ? await leadBoundaryLine(runtime, kit, config, text, cut, current) : undefined;
  return [chain, boundary].filter((line): line is string => line !== undefined);
}

/**
 * PostToolUse on reads, edits, shell calls and web lookups: once a turn's run of single-step calls reaches
 * `loops.chainNudgeAt`, hands the model one line asking it to batch, priced in re-reads. On the lead's
 * tab it also hands the lead one line at its first edit outside its own files, its first test or build,
 * its first research and its `leadBoundary.searchNudgeAt`-th code search (lead-boundary.ts). A helper's calls (the payload
 * has `agent_id`) are skipped, since both count the main thread only. Outside a loaded team, with both
 * off or on any error it prints nothing.
 */
export async function loopNudge(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const lines = await loopNudgeLines(parseJson(await runtime.readStdin()), runtime).catch((): readonly string[] => []);
  if (lines.length > 0) {
    runtime.out.stdout(nudgeOutput(lines.join('\n')));
  }
  return EXIT.ok;
}
