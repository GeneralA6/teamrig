import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isNonNegativeInteger, isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import type { TeamPaths } from '../core/home.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { DECISION_MARKER, decisionLineOf, TAB_CIRCLES, type TabState } from './status.ts';

/**
 * What each session's tab shows and what it asks the user (T2511), `<team>/state/tabs/<id>.json` each: the tab-status,
 * tool-end and stop hooks rewrite it whole on every change, so other tabs can show which tab needs the user and smart
 * focus (T2510) can bring it to the front. One small file per session, so no lock and no growth; SessionEnd removes it.
 */

/** The format of the tab files this code reads and writes; a file in another format reads as absent. */
export const TAB_NEED_FORMAT = 1;

/** The kinds of ask a tab waits on: a permission prompt, a question or plan, an MCP form, a decision line, an API error. */
export const NEED_KINDS = ['permission', 'question', 'elicitation', 'decision', 'error'] as const;

export type NeedKind = (typeof NEED_KINDS)[number];

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

/** The tools that stop a turn to ask the user, and the text each ask shows when its input names no question. */
const ASKING_TOOL_TEXTS: Readonly<Record<string, string>> = { AskUserQuestion: 'a question', ExitPlanMode: 'a plan to approve' };

/** The tool input fields that say most about a permission prompt, the first one present shown after the tool's name. */
const PERMISSION_FIELDS = ['command', 'file_path', 'url', 'path', 'pattern', 'description'] as const;

/** C0 and C1 controls and DEL: kept out of a text another tab prints in its band. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** A task id in an ask's text. */
const TASK_ID = /\bT\d+\b/;

const STATES: ReadonlySet<string> = new Set(Object.keys(TAB_CIRCLES));
const KINDS: ReadonlySet<string> = new Set(NEED_KINDS);

function isTabState(value: string): value is TabState {
  return STATES.has(value);
}

export function isNeedKind(value: string): value is NeedKind {
  return KINDS.has(value);
}

/** Text fit for another tab's band: controls as spaces, white space runs as one, at most `NEED_TEXT_MAX_CHARS`. */
export function needText(text: string): string {
  const flat = text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > NEED_TEXT_MAX_CHARS ? `${chars.slice(0, NEED_TEXT_MAX_CHARS - 1).join('').trimEnd()}…` : flat;
}

/** A permission prompt's text: the tool's name, then the input field that says most about the call. */
function permissionText(payload: JsonRecord): string {
  const tool = stringField(payload, 'tool_name') ?? 'a tool';
  const input = recordField(payload, 'tool_input') ?? {};
  const detail = PERMISSION_FIELDS.map((field) => stringField(input, field)).find((value) => value !== undefined && value.trim() !== '');
  return detail === undefined ? tool : `${tool}: ${detail}`;
}

/** An asking tool's text: AskUserQuestion's first question, else the tool's plain name. */
function questionText(tool: string, payload: JsonRecord): string {
  const questions = recordField(payload, 'tool_input')?.['questions'];
  const first = Array.isArray(questions) ? questions.find(isRecord) : undefined;
  const question = first === undefined ? undefined : stringField(first, 'question');
  return question === undefined || question.trim() === '' ? (ASKING_TOOL_TEXTS[tool] ?? tool) : question;
}

/** A decision line without its bold or heading markup. */
function decisionText(line: string): string {
  return line.replace(/^#{1,6} +/, '').replaceAll('**', '');
}

/** What this hook event asks the user, from the fields it carries; undefined for an event that asks nothing. */
export function askOf(payload: JsonRecord): Ask | undefined {
  const event = stringField(payload, 'hook_event_name');
  const tool = stringField(payload, 'tool_name') ?? '';
  if (event === 'PermissionRequest') {
    return { kind: 'permission', text: needText(permissionText(payload)) };
  }
  if (event === 'PreToolUse' && Object.hasOwn(ASKING_TOOL_TEXTS, tool)) {
    return { kind: 'question', text: needText(questionText(tool, payload)) };
  }
  if (event === 'Elicitation') {
    return { kind: 'elicitation', text: needText(stringField(payload, 'message') ?? stringField(payload, 'mcp_server_name') ?? 'a form') };
  }
  if (event === 'Stop') {
    const line = decisionLineOf(stringField(payload, 'last_assistant_message'));
    return line === undefined ? undefined : { kind: 'decision', text: needText(decisionText(line)) || DECISION_MARKER };
  }
  if (event === 'StopFailure') {
    return { kind: 'error', text: needText(stringField(payload, 'error') ?? 'an API error') };
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
export function tabNeedOf(session: string, state: TabState, payload: JsonRecord, pid: number | null, since: string): TabNeed {
  const ask = askOf(payload);
  if (ask === undefined) {
    return { session, state, kind: null, text: null, task: null, pid, since };
  }
  return { session, state, kind: ask.kind, text: ask.text, task: taskOf(ask.text, stringField(payload, 'last_assistant_message')), pid, since };
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

  private pathOf(id: string): string {
    return join(this.folder, `${id}.json`);
  }
}
