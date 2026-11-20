import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isNonNegativeInteger, stringField, type JsonRecord } from '../core/guards.ts';
import type { TeamPaths } from '../core/home.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { AskCall, HookEvent, ToolCall } from '../ports/host/index.ts';
import { isNeedKind, type NeedKind } from './need-kind.ts';
import type { TabState } from './state.ts';
import { DECISION_MARKER, decisionLineOf, TAB_CIRCLES } from './status.ts';

/**
 * What each session's tab shows and what it asks the user (T2511), `<team>/state/tabs/<id>.json` each: the tab-status,
 * tool-end and stop hooks rewrite it whole on every change, so other tabs can show which tab needs the user and smart
 * focus (T2510) can bring it to the front. One small file per session, so no lock and no growth; SessionEnd removes it.
 */

/** The format of the tab files this code reads and writes; a file in another format reads as absent. */
export const TAB_NEED_FORMAT = 1;

/** The most characters (code points) an ask's text keeps: enough for a band line, small enough for every tab to read. */
export const NEED_TEXT_MAX_CHARS = 200;

/** What a tab asks the user: its kind and its text. */
export interface Ask {
  readonly kind: NeedKind;
  readonly text: string;
}

/** A session's tab as its file records it. */
export interface TabNeed {
  readonly session: string;
  readonly state: TabState;
  /** What the tab asks; null while it asks nothing. */
  readonly kind: NeedKind | null;
  readonly text: string | null;
  /** The `T<id>` the ask names, so the focus walk can rank it by the task's priority; null when it names none. */
  readonly task: string | null;
  /** The tab's Claude Code process, for the focus step to find its window; null when unknown. */
  readonly pid: number | null;
  /** When the tab took this state, an ISO time. */
  readonly since: string;
}

/** The text a call that stops a turn to ask the user shows when it names no question. */
const ASK_TEXTS: Readonly<Record<AskCall['asks'], string>> = { question: 'a question', plan: 'a plan to approve' };

/** The tool input fields that say most about a permission prompt, the first one present shown after the tool's name. */
const PERMISSION_FIELDS = ['command', 'file_path', 'url', 'path', 'pattern', 'description'] as const;

/** C0 and C1 controls and DEL: kept out of a text another tab prints in its band. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** A task id in an ask's text. */
const TASK_ID = /\bT\d+\b/;

const STATES: ReadonlySet<string> = new Set(Object.keys(TAB_CIRCLES));
function isTabState(value: string): value is TabState {
  return STATES.has(value);
}

/** Text fit for another tab's band: controls as spaces, white space runs as one, at most `NEED_TEXT_MAX_CHARS`. */
export function needText(text: string): string {
  const flat = text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > NEED_TEXT_MAX_CHARS ? `${chars.slice(0, NEED_TEXT_MAX_CHARS - 1).join('').trimEnd()}…` : flat;
}

/** A permission prompt's text: the tool's name, then the input field that says most about the call. */
function permissionText(call: ToolCall | undefined): string {
  if (call === undefined) {
    return 'a tool';
  }
  const detail = PERMISSION_FIELDS.map((field) => stringField(call.input, field)).find((value) => value !== undefined && value.trim() !== '');
  return detail === undefined ? call.name : `${call.name}: ${detail}`;
}

/** An asking call's text: its first question, else the plain words for what it asks. */
function questionText(call: AskCall): string {
  return call.question === undefined || call.question.trim() === '' ? ASK_TEXTS[call.asks] : call.question;
}

/** A decision line without its bold or heading markup. */
function decisionText(line: string): string {
  return line.replace(/^#{1,6} +/, '').replaceAll('**', '');
}

/** What an ask reads of a hook event. */
export type AskEvent = Pick<HookEvent, 'name' | 'call' | 'message' | 'lastReply' | 'error'>;

/** What this hook event asks the user, from the fields it carries; undefined for an event that asks nothing. */
export function askOf(event: AskEvent): Ask | undefined {
  const { name, call } = event;
  if (name === 'permission-prompt') {
    return { kind: 'permission', text: needText(permissionText(call)) };
  }
  if (name === 'tool-start' && call?.kind === 'ask') {
    return { kind: 'question', text: needText(questionText(call)) };
  }
  if (name === 'form-start') {
    // A form with no text of its own carries the name of the server that asks as its message.
    return { kind: 'elicitation', text: needText(event.message ?? 'a form') };
  }
  if (name === 'stop') {
    const line = decisionLineOf(event.lastReply);
    return line === undefined ? undefined : { kind: 'decision', text: needText(decisionText(line)) || DECISION_MARKER };
  }
  if (name === 'stop-failed') {
    return { kind: 'error', text: needText(event.error ?? 'an API error') };
  }
  return undefined;
}

/** The first task id in the ask's text, else in the whole message it came from; null when neither names one. */
export function taskOf(...texts: readonly (string | undefined)[]): string | null {
  for (const text of texts) {
    const found = TASK_ID.exec(text ?? '')?.[0];
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}

/** The tab record of `session` in `state` after this hook event, which asked `ask` (undefined: nothing). */
export function tabNeedOf(session: string, state: TabState, event: AskEvent, pid: number | null, since: string): TabNeed {
  const ask = askOf(event);
  if (ask === undefined) {
    return { session, state, kind: null, text: null, task: null, pid, since };
  }
  return { session, state, kind: ask.kind, text: ask.text, task: taskOf(ask.text, event.lastReply), pid, since };
}

/** Whether two records show the same tab: a rewrite that changes only `since` is skipped, so each tool's end stays cheap. */
export function sameTab(left: TabNeed, right: TabNeed): boolean {
  return left.state === right.state && left.kind === right.kind && left.text === right.text && left.task === right.task && left.pid === right.pid;
}

function nullableString(record: JsonRecord, key: string): string | null | undefined {
  const value = record[key];
  return value === null ? null : stringField(record, key);
}

/** A tab file's content; undefined when it is damaged or from another format. */
export function parseTabNeed(text: string): TabNeed | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== TAB_NEED_FORMAT) {
    return undefined;
  }
  const session = stringField(record, 'session');
  const state = stringField(record, 'state');
  const kind = nullableString(record, 'kind');
  const needText = nullableString(record, 'text');
  const task = nullableString(record, 'task');
  const pid = record['pid'];
  const since = stringField(record, 'since');
  if (session === undefined || state === undefined || !isTabState(state) || since === undefined || Number.isNaN(Date.parse(since))) {
    return undefined;
  }
  if (kind === undefined || (kind !== null && !isNeedKind(kind)) || needText === undefined || task === undefined) {
    return undefined;
  }
  if (pid !== null && (!isNonNegativeInteger(pid) || pid === 0)) {
    return undefined;
  }
  return { session, state, kind, text: needText, task, pid, since };
}

export function formatTabNeed(need: TabNeed): string {
  return toJsonlLine({ [VERSION_FIELD]: TAB_NEED_FORMAT, ...need });
}

/** Each session's tab file. Ids are session ids, checked by the roster, so they are safe in a path. */
export class TabNeedStore {
  private readonly files: Files;
  private readonly folder: string;

  constructor(files: Files, paths: Pick<TeamPaths, 'tabs'>) {
    this.files = files;
    this.folder = paths.tabs;
  }

  /** The session's tab; undefined when it has no file, or the file is damaged or from another format. */
  async read(id: string): Promise<TabNeed | undefined> {
    const text = await this.files.read(this.pathOf(id));
    return text === undefined ? undefined : parseTabNeed(text);
  }

  /** Every session's tab that has a readable file, in session id order. */
  async readAll(): Promise<TabNeed[]> {
    const names = (await this.files.list(this.folder)).filter((name) => name.endsWith('.json')).sort();
    const needs = await Promise.all(names.map((name) => this.read(name.slice(0, -'.json'.length))));
    return needs.filter((need): need is TabNeed => need !== undefined);
  }

  /** Writes the tab unless its file already shows the same (`sameTab`); true when it wrote. */
  async record(need: TabNeed): Promise<boolean> {
    const current = await this.read(need.session);
    if (current !== undefined && sameTab(current, need)) {
      return false;
    }
    await this.files.write(this.pathOf(need.session), formatTabNeed(need));
    return true;
  }

  /** Removes the session's file, as its session ends; true when there was one. */
  remove(id: string): Promise<boolean> {
    return this.files.remove(this.pathOf(id));
  }

  /** The session's tab file, for a reader that stamps it without reading it. */
  pathOf(id: string): string {
    return join(this.folder, `${id}.json`);
  }
}
