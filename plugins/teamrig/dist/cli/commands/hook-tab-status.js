import { ENV } from "../../core/home.js";
import { tabDisplayOf } from "../../hooks/bind.js";
import { TRANSCRIPT_TAIL_BYTES } from "../../names/title.js";
import { readRunningKinds } from "../../refresh/running.js";
import { helpersRun, readyWaitsOnHelpers, tabChangeOf, tabTitle, topicOf } from "../../tabs/status.js";
import { noPositionals } from "../args.js";
import { transcriptsIfKept } from "../host.js";
import { openKit, rosterOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { readHookInput, sessionTeam, writeReply } from "./hook-input.js";
import { pickerRefusal } from "./hook-picker-guard.js";
import { recordTabNeed } from "./hook-tab-need.js";
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
/** The end of the session's transcript the topic reads; undefined without one. */
async function transcriptTailOf(runtime, transcript) {
    const text = transcript === undefined || transcript === '' ? undefined : await runtime.files.readTail(transcript, TRANSCRIPT_TAIL_BYTES);
    return text === undefined ? undefined : { text, whole: Buffer.byteLength(text, 'utf8') < TRANSCRIPT_TAIL_BYTES };
}
/** Whether a helper the session started still runs, by its transcript; none on a host that keeps no transcript teamrig can read. */
async function helpersRunFor(runtime, transcript) {
    const reader = transcriptsIfKept(runtime);
    return transcript !== undefined && transcript !== '' && reader !== undefined && helpersRun(await readRunningKinds(reader, runtime.files, transcript, runtime.clock.now()));
}
/**
 * The title this hook event gives the tab: its state's circle before `label` (a refresh notice's title), else
 * before the session's topic, read from the transcript only when the event has no session title; a topic
 * naming one session of `own` reads `[<team>] <name>` (tabDisplayOf). A ready state reads as working while a
 * helper still runs. '' gives the title back to the terminal; undefined leaves it. On a host that keeps no
 * transcript teamrig can read, the topic comes from the event alone.
 */
export async function tabTitleOf(runtime, event, own, label) {
    const change = tabChangeOf(event);
    if (change === undefined || change === 'reset') {
        return change === 'reset' ? '' : undefined;
    }
    const state = readyWaitsOnHelpers(event, change) && (await helpersRunFor(runtime, event.transcript)) ? 'working' : change;
    if (label !== undefined) {
        return tabTitle(state, label);
    }
    const reader = transcriptsIfKept(runtime);
    const tail = reader !== undefined && event.title === undefined ? await transcriptTailOf(runtime, event.transcript) : undefined;
    return tabTitle(state, tabDisplayOf(own, topicOf(reader, event, tail)));
}
/**
 * The tab title this hook event sets; undefined with tab status off or no change. A question picker the picker
 * guard refuses leaves the title: the picker never opens, and the session goes on.
 */
export async function tabStatusTitleOf(runtime, event) {
    // The switch first: it costs no file read, and on most machines it is off.
    if (!titleLeftToHooks(runtime.env)) {
        return undefined;
    }
    const found = await sessionTeam(event.cwd, runtime);
    const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
    if (kit?.load.status !== 'loaded' || !kit.load.config.tabStatus.enabled) {
        return undefined;
    }
    if ((await pickerRefusal(runtime, kit, kit.load.config, event)) !== undefined) {
        return undefined;
    }
    return tabTitleOf(runtime, event, { team: kit.paths.team, roster: await rosterOf(runtime, kit, kit.load.config) });
}
/**
 * Every hook event but Stop (whose hook writes the title with its own output): with `tabStatus.enabled` and
 * Claude Code's own title off, sets the tab's title to a circle for what the session is doing (tabs/status.ts)
 * before its topic. Outside a team, with either off, for input that is not a hook payload or on any error, it
 * prints nothing. Either way it records a team session's tab in its tab file (hook-tab-need.ts).
 */
export async function tabStatus(args, runtime) {
    noPositionals(args);
    const { event } = await readHookInput(runtime);
    if (event === undefined) {
        return EXIT.ok;
    }
    const [tabTitle] = await Promise.all([tabStatusTitleOf(runtime, event).catch(() => undefined), recordTabNeed(runtime, event).catch(() => undefined)]);
    // An event teamrig has no name for changes no tab, so it has no title to write.
    if (event.name !== 'other') {
        writeReply(runtime, event.name, { tabTitle });
    }
    return EXIT.ok;
}
