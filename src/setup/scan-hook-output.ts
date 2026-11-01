import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { jsonObjectOf } from '../doctor/settings-env.ts';

/** The hook events whose command output Claude Code adds to the session's context. */
export const CONTEXT_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit'] as const;

/** What one context hook printed into the context, summed over the runs the transcripts read recorded. */
export interface HookOutput {
  readonly runs: number;
  /** The runs that printed something into the context. */
  readonly printed: number;
  /** The characters all its runs printed into the context. */
  readonly chars: number;
}

/** Each context hook's output, keyed by `hookOutputKey` of its event and command. */
export type HookOutputs = ReadonlyMap<string, HookOutput>;

/** One recorded run of a context hook: its event, its command as the settings spell it, and what it printed into the context. */
export interface HookRun {
  readonly event: string;
  readonly command: string;
  readonly chars: number;
}

const CONTEXT_EVENTS: ReadonlySet<string> = new Set(CONTEXT_HOOK_EVENTS);

/**
 * The key of a hook's output: its event and its `command` as the settings file spells it, which is what a transcript
 * records. An exec-form hook's `args` are not recorded, so two exec-form hooks of one event running one command share it.
 */
export function hookOutputKey(event: string, command: string): string {
  return JSON.stringify([event, command]);
}

/** A cheap test before parsing: only a line naming a successful hook run can record one. */
export function mayRecordHookRun(line: string): boolean {
  return line.includes('"hook_success"');
}

/**
 * What a JSON stdout adds to the context: its `hookSpecificOutput.additionalContext`, else nothing (a JSON reply that
 * only sets a title or a decision prints nothing into the context).
 */
function additionalContextOf(reply: JsonRecord): string {
  const specific = reply['hookSpecificOutput'];
  return (isRecord(specific) ? stringField(specific, 'additionalContext') : undefined) ?? '';
}

/** The characters a run printed into the context: a JSON stdout's additional context, else its plain output, trimmed. */
function printedChars(run: JsonRecord): number {
  const stdout = stringField(run, 'stdout') ?? '';
  const reply = jsonObjectOf(stdout);
  if (reply !== undefined) {
    return additionalContextOf(reply).length;
  }
  return (stringField(run, 'content') ?? stdout).trim().length;
}

/**
 * The context hook run a transcript line records, or undefined for any other line: Claude Code writes each successful
 * hook run as an `attachment` entry of type `hook_success` carrying its event, its command and its output. A failed run
 * adds nothing to the context, so only successful ones count.
 */
export function hookRunOf(line: string): HookRun | undefined {
  const entry = parseObject(line);
  const run = entry === undefined ? undefined : entry['attachment'];
  if (!isRecord(run) || run['type'] !== 'hook_success') {
    return undefined;
  }
  const event = stringField(run, 'hookEvent');
  const command = stringField(run, 'command');
  if (event === undefined || command === undefined || !CONTEXT_EVENTS.has(event)) {
    return undefined;
  }
  return { event, command, chars: printedChars(run) };
}

/** Adds a run to its hook's output. */
export function addHookRun(outputs: Map<string, HookOutput>, run: HookRun): void {
  const key = hookOutputKey(run.event, run.command);
  const before = outputs.get(key) ?? { runs: 0, printed: 0, chars: 0 };
  outputs.set(key, { runs: before.runs + 1, printed: before.printed + (run.chars > 0 ? 1 : 0), chars: before.chars + run.chars });
}
