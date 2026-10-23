import { isRecord, stringField } from "../../core/guards.js";
import { ENV } from "../../core/home.js";
import { tabTitleSequence } from "../../hooks/stop.js";
import { TRANSCRIPT_TAIL_BYTES } from "../../names/title.js";
import { readRunningKinds } from "../../refresh/running.js";
import { helpersRun, readyWaitsOnHelpers, tabChangeOf, tabTitle, topicOf } from "../../tabs/status.js";
import { noPositionals } from "../args.js";
import { openKit } from "../kit.js";
import { EXIT } from "../runtime.js";
import { parseJson, sessionTeam } from "./hook-input.js";
import { refusedPickerAsker } from "./hook-picker-guard.js";
/** The values Claude Code reads as on for a switch such as `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`. */
const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);
/** Whether Claude Code leaves the tab title to hooks: otherwise it writes its own over the circle. */
export function titleLeftToHooks(env) {
    return ON_VALUES.has(env[ENV.claudeTitleOff]?.trim().toLowerCase() ?? '');
}
/** Whether a team's hooks show tab status: `tabStatus.enabled` in its config, and Claude Code leaves them the title. */
export function tabStatusOn(env, config) {
    return config.tabStatus.enabled && titleLeftToHooks(env);
}
/** The end of the payload's transcript the topic reads; undefined without one. */
async function transcriptTailOf(runtime, payload) {
    const transcript = stringField(payload, 'transcript_path');
    const text = transcript === undefined || transcript === '' ? undefined : await runtime.files.readTail(transcript, TRANSCRIPT_TAIL_BYTES);
    return text === undefined ? undefined : { text, whole: Buffer.byteLength(text, 'utf8') < TRANSCRIPT_TAIL_BYTES };
}
/** Whether a helper the session started still runs, by its transcript. */
async function helpersRunFor(runtime, payload) {
    const transcript = stringField(payload, 'transcript_path');
    return transcript !== undefined && transcript !== '' && helpersRun(await readRunningKinds(runtime.files, transcript, runtime.clock.now()));
}
/**
 * The title this hook event gives the tab: its state's circle before `label` (a refresh notice's title), else
 * before the session's topic, read from the transcript only when the payload has no session title. A ready
 * state reads as working while a helper still runs. '' gives the title back to the terminal; undefined leaves it.
 */
export async function tabTitleOf(runtime, payload, label) {
    const change = tabChangeOf(payload);
    if (change === undefined || change === 'reset') {
        return change === 'reset' ? '' : undefined;
    }
    const state = readyWaitsOnHelpers(payload, change) && (await helpersRunFor(runtime, payload)) ? 'working' : change;
    if (label !== undefined) {
        return tabTitle(state, label);
    }
    const named = stringField(payload, 'session_title')?.trim();
    return tabTitle(state, topicOf(payload, named === undefined || named === '' ? await transcriptTailOf(runtime, payload) : undefined));
}
/**
 * What the hook prints for this payload: the tab title as a terminal sequence, or '' with tab status off or no change.
 * A question picker the picker guard refuses leaves the title: the picker never opens, and the session goes on.
 */
export async function tabStatusOutputOf(runtime, payload) {
    // The switch first: it costs no file read, and on most machines it is off.
    if (!titleLeftToHooks(runtime.env)) {
        return '';
    }
    const found = await sessionTeam(payload, runtime);
    const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
    if (kit?.load.status !== 'loaded' || !kit.load.config.tabStatus.enabled) {
        return '';
    }
    if ((await refusedPickerAsker(runtime, kit, kit.load.config, payload)) !== undefined) {
        return '';
    }
    const title = await tabTitleOf(runtime, payload);
    return title === undefined ? '' : JSON.stringify({ terminalSequence: tabTitleSequence(title) });
}
/**
 * Every hook event but Stop (whose hook writes the title with its own output): with `tabStatus.enabled` and
 * Claude Code's own title off, sets the tab's title to a circle for what the session is doing (tabs/status.ts)
 * before its topic. Outside a team, with either off, for input that is not a hook payload or on any error, it
 * prints nothing.
 */
export async function tabStatus(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const output = isRecord(payload) ? await tabStatusOutputOf(runtime, payload).catch(() => '') : '';
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
