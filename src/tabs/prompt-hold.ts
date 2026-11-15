import type { Files } from '../core/files.ts';
import { parseObject } from '../core/jsonl.ts';
import type { TabNeed } from './need.ts';
import { isAsking, type AskingTab } from './needs-you.ts';

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

/** The most words of the prompt's detail a page carries: enough to know the call, too few to hold an argument. */
export const PROMPT_HOLD_WORDS = 3;

/** A plain word of a command (a program, a subcommand): no path, address, assignment or quoted text in it. */
const PLAIN_WORD = /^[A-Za-z][\w.-]*$/;

/** A tab file of `kind: 'permission'` older than `PROMPT_HOLD_MS` whose Claude Code still runs. */
export function heldPrompts(tabs: readonly TabNeed[], now: number, alive: (pid: number) => boolean): AskingTab[] {
  return tabs
    .filter(isAsking)
    .filter((need) => need.kind === 'permission' && now - Date.parse(need.since) >= PROMPT_HOLD_MS)
    .filter((need) => need.pid === null || alive(need.pid));
}

/**
 * The prompt as a page may name it: the tool, then the first plain words of its detail, stopping at the first word
 * that is not one. The full text may hold a path or a secret, and a page goes to a chat outside the machine.
 */
export function promptWords(text: string): string {
  const [tool = '', detail = ''] = text.split(/:\s(.*)/s, 2);
  const words: string[] = [];
  for (const word of detail.split(/\s+/)) {
    if (words.length === PROMPT_HOLD_WORDS || !PLAIN_WORD.test(word)) {
      break;
    }
    words.push(word);
  }
  return [tool.trim(), ...words].join(' ');
}

/** `teamrig/tr-budget holds on a permission prompt since 07:25 IST (12 min): Bash git status`. */
export function promptHoldText(where: string, need: AskingTab, clock: (at: Date) => string, now: number): string {
  const minutes = Math.floor((now - Date.parse(need.since)) / 60_000);
  return `${where} holds on a permission prompt since ${clock(new Date(need.since))} (${minutes} min): ${promptWords(need.text)}; answer it in that tab`;
}

/**
 * The holds already paged, `{ "<session>": "<since>" }`: a tab's next prompt rewrites its file with a new `since`, so
 * the pair names one hold. Rewritten whole with only the tabs holding now, so it holds at most one entry per session.
 * The caller holds the idle pass's lock, so two tabs never page one hold.
 */
export class PromptHoldsPaged {
  private readonly files: Files;
  private readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  /** The holds in `held` not paged yet. */
  async unpaged(held: readonly AskingTab[]): Promise<AskingTab[]> {
    const paged = await this.read();
    return held.filter((need) => paged[need.session] !== need.since);
  }

  /** Records every hold in `held` as paged but those in `failed`, whose page the next pass tries again. */
  async keep(held: readonly AskingTab[], failed: readonly AskingTab[]): Promise<void> {
    const retry = new Set(failed.map((need) => need.session));
    const next = Object.fromEntries(held.filter((need) => !retry.has(need.session)).map((need) => [need.session, need.since]));
    const paged = await this.read();
    if (JSON.stringify(paged) !== JSON.stringify(next)) {
      await this.files.write(this.path, `${JSON.stringify(next)}\n`);
    }
  }

  private async read(): Promise<Record<string, unknown>> {
    return parseObject((await this.files.read(this.path)) ?? '') ?? {};
  }
}
