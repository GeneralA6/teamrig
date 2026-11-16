import { toolUseFrom } from "../../budget/line.js";
import { isRecord, recordField, stringField } from "../../core/guards.js";
import { leadNudgeLine, leadWorkOf, taskOwnersOf } from "../../hooks/lead-boundary.js";
import { chainOf, nudgeLine, turnTasksOf, turnToolsOf } from "../../hooks/loop-nudge.js";
import { postToolUseContext } from "../../hooks/post-tool-use.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { TRANSCRIPT_TAIL_BYTES } from "../../names/title.js";
import { JsonlEventLog } from "../../register/store.js";
import { noPositionals } from "../args.js";
import { openKit, rosterOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { meterTabMidTurn } from "./hook-budget.js";
import { loadTree } from "../tree.js";
import { parseJson, sessionTeam, teamSessionOf, turnLeadPathsOf } from "./hook-input.js";
/** The tool the hook fires for, from its payload; undefined without an id or a name. */
function currentToolOf(payload) {
    const id = stringField(payload, 'tool_use_id');
    const name = stringField(payload, 'tool_name');
    return id === undefined || name === undefined ? undefined : toolUseFrom(id, name, recordField(payload, 'tool_input'));
}
/**
 * The team session of this tab, looked up only when the budget or the lead boundary needs it; undefined for a tab
 * that is none of the team's.
 */
async function tabSessionOf(runtime, kit, config, payload) {
    if (!config.budget.enabled && !config.leadBoundary.enabled) {
        return undefined;
    }
    const roster = await rosterOf(runtime, kit, config);
    const id = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
    return id === undefined ? undefined : { roster, id };
}
/** The sessions that own the tasks the turn's prompt names, read from the register's working set; none when it names none. */
async function promptTaskOwners(runtime, kit, config, tasks) {
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
async function leadBoundaryLine(runtime, kit, config, text, cut, current) {
    const turn = turnToolsOf(text, cut, current);
    const paths = await turnLeadPathsOf(runtime, kit, config, await loadTree(runtime), turn);
    const research = leadWorkOf(current, paths) === 'research';
    const owners = research ? await promptTaskOwners(runtime, kit, config, turnTasksOf(text, cut)).catch(() => []) : [];
    return leadNudgeLine(turn, current, paths, config.leadBoundary.searchNudgeAt, owners);
}
/**
 * The lines for this payload: the chain nudge and, on the lead's tab, the lead-boundary nudge; none for a
 * helper's call, outside a loaded team or with both off.
 */
async function loopNudgeLines(payload, runtime) {
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
    const tab = await tabSessionOf(runtime, kit, config, payload).catch(() => undefined);
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
    const current = currentToolOf(payload);
    const chain = at > 0 ? nudgeLine(chainOf(text, cut, current), at) : undefined;
    const boundary = lead && current !== undefined ? await leadBoundaryLine(runtime, kit, config, text, cut, current) : undefined;
    return [chain, boundary].filter((line) => line !== undefined);
}
/**
 * PostToolUse on reads, edits, shell calls and web lookups: once a turn's run of single-step calls reaches
 * `loops.chainNudgeAt`, hands the model one line asking it to batch, priced in re-reads. On the lead's
 * tab it also hands the lead one line at its first edit outside its own files, its first test or build,
 * its first research and its `leadBoundary.searchNudgeAt`-th code search (lead-boundary.ts). A helper's calls (the payload
 * has `agent_id`) are skipped, since both count the main thread only. Outside a loaded team, with both
 * off or on any error it prints nothing. On a session's tab with the budget on it also meters the tab once its
 * transcript has grown `MID_TURN_METER_BYTES` past the stored cursor (T3298), printing nothing for that.
 */
export async function loopNudge(args, runtime) {
    noPositionals(args);
    const lines = await loopNudgeLines(parseJson(await runtime.readStdin()), runtime).catch(() => []);
    if (lines.length > 0) {
        runtime.out.stdout(postToolUseContext(lines.join('\n')));
    }
    return EXIT.ok;
}
