import { formatW } from '../budget/format.ts';
import { transcriptLineOf, type ToolUse } from '../budget/line.ts';
import { kindOf, type ToolKind } from '../budget/patterns.ts';
import type { CallUsage, TranscriptReader, UsageMeter } from '../ports/host/index.ts';

/**
 * The run of single-step calls that ends the current turn. A step is a call with exactly one tool
 * that could have shared a message: a read, a lookup, an edit, a test or a build. A call with
 * several tools, or one tool of another kind (a helper, a message, a script), ends the run.
 */
export interface Chain {
  readonly length: number;
  /** An edit and then a test in the next call, somewhere in the run: the two could have been one message. */
  readonly editThenTest: boolean;
  /** The context of the turn's last reply, in tokens; 0 when no reply in the turn says. */
  readonly context: number;
}

/** One call of the current turn: a reply spans several lines that share its key. */
interface TurnCall {
  readonly key: string | undefined;
  readonly tools: ToolUse[];
  /** What the reply says it used; undefined for the tool the hook fires for when no reply came before it. */
  readonly usage: CallUsage | undefined;
}

function stepKind(call: TurnCall): ToolKind | undefined {
  const tool = call.tools.length === 1 ? call.tools[0] : undefined;
  const kind = tool === undefined ? undefined : kindOf(tool);
  return kind === 'other' ? undefined : kind;
}

function isEditKind(kind: ToolKind): boolean {
  return kind === 'edit' || kind === 'editTest';
}

function isTestKind(kind: ToolKind): boolean {
  return kind === 'testFull' || kind === 'testTargeted' || kind === 'editTest';
}

/** The current turn: its main-thread calls since the last prompt, joined by reply, and the task ids that prompt names. */
interface Turn {
  readonly calls: TurnCall[];
  readonly tasks: readonly string[];
}

function turnOf(reader: TranscriptReader, text: string, cut: boolean): Turn {
  const lines = text.split('\n');
  let calls: TurnCall[] = [];
  let tasks: readonly string[] = [];
  for (const raw of cut ? lines.slice(1) : lines) {
    const line = transcriptLineOf(reader, raw);
    if (line?.kind === 'prompt') {
      calls = [];
      tasks = line.tasks ?? [];
    } else if (line?.kind === 'call' && line.mainThread) {
      const last = calls.at(-1);
      if (last !== undefined && line.key !== undefined && last.key === line.key) {
        last.tools.push(...line.tools);
      } else {
        calls.push({ key: line.key, tools: [...line.tools], usage: line.usage });
      }
    }
  }
  return { calls, tasks };
}

/** The turn's calls, with `current` as the last one when the transcript has not got it yet. */
function callsWith(reader: TranscriptReader, text: string, cut: boolean, current: ToolUse | undefined): TurnCall[] {
  const { calls } = turnOf(reader, text, cut);
  const written = current === undefined || calls.some((call) => call.tools.some((tool) => tool.id === current.id));
  if (!written) {
    calls.push({ key: undefined, tools: [current], usage: calls.at(-1)?.usage });
  }
  return calls;
}

/** The main thread's tool calls since the last prompt, `current` included. */
export function turnToolsOf(reader: TranscriptReader, text: string, cut: boolean, current: ToolUse | undefined): ToolUse[] {
  return callsWith(reader, text, cut, current).flatMap((call) => call.tools);
}

/** The task ids the current turn's prompt names; none when the text starts inside the turn, past its prompt. */
export function turnTasksOf(reader: TranscriptReader, text: string, cut: boolean): readonly string[] {
  return turnOf(reader, text, cut).tasks;
}

/**
 * The run of single-step calls ending the current turn, from transcript text (`cut`: a tail that may
 * start mid-line, so its first line is skipped). `current` is the tool the hook fires for: when its
 * reply is not in the transcript yet, it counts as one more single-tool call. The host's meter says how much
 * context the last reply read.
 */
export function chainOf(reader: TranscriptReader, usage: UsageMeter, text: string, cut: boolean, current: ToolUse | undefined): Chain {
  const calls = callsWith(reader, text, cut, current);
  const kinds: ToolKind[] = [];
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    const kind = call === undefined ? undefined : stepKind(call);
    if (kind === undefined) {
      break;
    }
    kinds.unshift(kind);
  }
  const editThenTest = kinds.some((kind, index) => index > 0 && isTestKind(kind) && isEditKind(kinds[index - 1] ?? 'other'));
  const last = calls.at(-1)?.usage;
  return { length: kinds.length, editThenTest, context: last === undefined ? 0 : usage.contextReading(last) };
}

/**
 * The one line for the model when the run reaches `at` calls, so each run gets it once; undefined
 * below or past it, and always when `at` is 0. It prices what batching saves: every call after the
 * first re-read the whole context, at the price the host's meter gives a cached token.
 */
export function nudgeLine(usage: UsageMeter, chain: Chain, at: number): string | undefined {
  if (at <= 0 || chain.length !== at) {
    return undefined;
  }
  const rereads = formatW((chain.length - 1) * chain.context * usage.weights.cacheRead);
  const fix = chain.editThenTest
    ? 'an edit and then its test went in separate calls: send an edit with its re-test in one message, and independent reads as several tool calls in one'
    : 'send independent reads and lookups as several tool calls in one message, join shell steps into one command, and send an edit with its re-test';
  return `teamrig: ${chain.length} single-step calls in a row this turn (about ${rereads} W of re-reads at this context); ${fix}.`;
}
