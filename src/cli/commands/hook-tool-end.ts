import { isRecord, stringField, type JsonRecord } from '../../core/guards.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { askedLinesOf } from './hook-asked-lines.ts';
import { parseJson } from './hook-input.ts';
import { trackRestore } from './hook-restore-track.ts';
import { recordTabNeed } from './hook-tab-need.ts';
import { tabSequenceOf } from './hook-tab-status.ts';

/** The hook's one JSON object: the tab title's terminal sequence and the lines for the model, each when there is one. */
function toolEndOutput(event: string, sequence: string | undefined, lines: string | undefined): JsonRecord {
  return {
    ...(sequence === undefined ? {} : { terminalSequence: sequence }),
    ...(lines === undefined ? {} : { hookSpecificOutput: { hookEventName: event, additionalContext: lines } }),
  };
}

/**
 * PostToolUse and PostToolUseFailure, every tool: the tab's title (`hook tab-status`), the session's restore entry
 * (`hook restore-track`) and, once a wake ask waits for the session, its new inbox lines (hook-asked-lines.ts), from
 * one process, since a tool's end is the most frequent hook event. The entry is written at most every few minutes
 * (`TOOL_END_WRITE_MS`), so through a long turn it shows the session's hooks still run. It prints one JSON object
 * with the title's terminal sequence and the lines, or nothing, and on any error exits 0: it never holds up a turn.
 */
export async function toolEnd(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  if (!isRecord(payload)) {
    return EXIT.ok;
  }
  const [sequence, lines] = await Promise.all([
    tabSequenceOf(runtime, payload).catch(() => undefined),
    askedLinesOf(runtime, payload).catch(() => undefined),
    trackRestore(payload, runtime).catch(() => undefined),
    recordTabNeed(runtime, payload).catch(() => undefined),
  ]);
  const output = toolEndOutput(stringField(payload, 'hook_event_name') ?? 'PostToolUse', sequence, lines);
  if (Object.keys(output).length > 0) {
    runtime.out.stdout(JSON.stringify(output));
  }
  return EXIT.ok;
}
