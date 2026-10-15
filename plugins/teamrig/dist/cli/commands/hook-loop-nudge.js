import { toolUseFrom } from "../../budget/line.js";
import { isRecord, recordField, stringField } from "../../core/guards.js";
import { leadNudgeLine } from "../../hooks/lead-boundary.js";
import { chainOf, nudgeLine, nudgeOutput, turnToolsOf } from "../../hooks/loop-nudge.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { TRANSCRIPT_TAIL_BYTES } from "../../names/title.js";
import { noPositionals } from "../args.js";
import { openKit, rosterOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { leadOwnPaths, parseJson, sessionTeam, teamSessionOf } from "./hook-input.js";
/** The tool the hook fires for, from its payload; undefined without an id or a name. */
function currentToolOf(payload) {
    const id = stringField(payload, 'tool_use_id');
    const name = stringField(payload, 'tool_name');
    return id === undefined || name === undefined ? undefined : toolUseFrom(id, name, recordField(payload, 'tool_input'));
}
/** This tab is the team's lead and the lead boundary is on; a failed lookup counts as another session. */
async function isLeadTab(runtime, kit, config, payload) {
    if (!config.leadBoundary.enabled) {
        return false;
    }
    const roster = await rosterOf(runtime, kit, config);
    return (await teamSessionOf(runtime, kit, roster, sessionIdOf(payload))) === config.roles.lead;
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
    const at = config.loops.chainNudgeAt;
    const lead = await isLeadTab(runtime, kit, config, payload).catch(() => false);
    const text = at > 0 || lead ? await runtime.files.readTail(transcript, TRANSCRIPT_TAIL_BYTES) : undefined;
    if (text === undefined) {
        return [];
    }
    const cut = Buffer.byteLength(text, 'utf8') >= TRANSCRIPT_TAIL_BYTES;
    const current = currentToolOf(payload);
    const chain = at > 0 ? nudgeLine(chainOf(text, cut, current), at) : undefined;
    const boundary = lead && current !== undefined ? leadNudgeLine(turnToolsOf(text, cut, current), current, leadOwnPaths(runtime, kit, config), config.leadBoundary.searchNudgeAt) : undefined;
    return [chain, boundary].filter((line) => line !== undefined);
}
/**
 * PostToolUse on reads, edits and shell calls: once a turn's run of single-step calls reaches
 * `loops.chainNudgeAt`, hands the model one line asking it to batch, priced in re-reads. On the lead's
 * tab it also hands the lead one line at its first edit outside its own files, its first test or build
 * and its `leadBoundary.searchNudgeAt`-th code search (lead-boundary.ts). A helper's calls (the payload
 * has `agent_id`) are skipped, since both count the main thread only. Outside a loaded team, with both
 * off or on any error it prints nothing.
 */
export async function loopNudge(args, runtime) {
    noPositionals(args);
    const lines = await loopNudgeLines(parseJson(await runtime.readStdin()), runtime).catch(() => []);
    if (lines.length > 0) {
        runtime.out.stdout(nudgeOutput(lines.join('\n')));
    }
    return EXIT.ok;
}
