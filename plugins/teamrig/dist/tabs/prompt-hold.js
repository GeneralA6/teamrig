import { parseObject } from "../core/jsonl.js";
import { isAsking } from "./needs-you.js";
/**
 * A tab held on a permission prompt (T2927): Claude Code waits mid-turn for the user, so the tab's own mod runs no
 * wake check and no peer's line reaches it. One such tab of the security reviewer held every review of a night for
 * 8 hours. Its tab file (need.ts) says so: the PermissionRequest hook writes kind `permission` with the prompt's
 * `since`, and the tool's end or the turn's stop rewrites it, so a permission file older than `PROMPT_HOLD_MS` is a
 * prompt nobody answered. Another tab's idle pass reads it and pages the owner once per hold.
 */
/**
 * How long a prompt waits before it pages: a person at the desk answers a prompt within minutes, so ten minutes
 * unanswered means nobody is watching that tab, and an hour lost costs every session waiting on it.
 */
export const PROMPT_HOLD_MS = 10 * 60 * 1000;
/**
 * The most words of the prompt's detail a page carries: the program, which names the call. The words after it are
 * where an argument sits, and a short lowercase password or hex key there passes both `PLAIN_WORD` and the secret
 * scanner, so a page never carries them (T2963).
 */
export const PROMPT_HOLD_WORDS = 1;
/**
 * A plain word of a command (a program, a subcommand): lowercase and at most 20 characters, so no path, address,
 * assignment or quoted text, and no bare token either: GitHub, Anthropic, Slack and npm tokens and hex keys are
 * mixed-case or longer.
 */
const PLAIN_WORD = /^[a-z][a-z0-9.-]{0,19}$/;
/** A tab file of `kind: 'permission'` older than `PROMPT_HOLD_MS` whose Claude Code still runs. */
export function heldPrompts(tabs, now, alive) {
    return tabs
        .filter(isAsking)
        .filter((need) => need.kind === 'permission' && now - Date.parse(need.since) >= PROMPT_HOLD_MS)
        .filter((need) => need.pid === null || alive(need.pid));
}
/**
 * The prompt as a page may name it: the tool, then the first word of its detail when that is a plain word. The full text may hold a path or a secret, and a page goes to a chat outside the machine, so words
 * any secret shape of `scanner` matches are dropped too, leaving the tool alone.
 */
export function promptWords(text, scanner) {
    const [tool = '', detail = ''] = text.split(/:\s(.*)/s, 2);
    const words = [];
    for (const word of detail.split(/\s+/)) {
        if (words.length === PROMPT_HOLD_WORDS || !PLAIN_WORD.test(word)) {
            break;
        }
        words.push(word);
    }
    const named = [tool.trim(), ...words].join(' ');
    return scanner.find(named) === undefined ? named : tool.trim();
}
/** `teamrig/tr-budget holds on a permission prompt since 07:25 IST (12 min): Bash git status`. */
export function promptHoldText(where, need, clock, scanner, now) {
    const minutes = Math.floor((now - Date.parse(need.since)) / 60_000);
    return `${where} holds on a permission prompt since ${clock(new Date(need.since))} (${minutes} min): ${promptWords(need.text, scanner)}; answer it in that tab`;
}
/**
 * The holds already paged, `{ "<session>": "<since>" }`: a tab's next prompt rewrites its file with a new `since`, so
 * the pair names one hold. Rewritten whole with only the tabs holding now, so it holds at most one entry per session.
 * The caller holds the idle pass's lock, so two tabs never page one hold.
 */
export class PromptHoldsPaged {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    /** The holds in `held` not paged yet. */
    async unpaged(held) {
        const paged = await this.read();
        return held.filter((need) => paged[need.session] !== need.since);
    }
    /** Records every hold in `held` as paged but those in `failed`, whose page the next pass tries again. */
    async keep(held, failed) {
        const retry = new Set(failed.map((need) => need.session));
        const next = Object.fromEntries(held.filter((need) => !retry.has(need.session)).map((need) => [need.session, need.since]));
        const paged = await this.read();
        if (JSON.stringify(paged) !== JSON.stringify(next)) {
            await this.files.write(this.path, `${JSON.stringify(next)}\n`);
        }
    }
    async read() {
        return parseObject((await this.files.read(this.path)) ?? '') ?? {};
    }
}
