import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { askedLinesOf } from './hook-asked-lines.ts';
import { readHookInput, writeReply } from './hook-input.ts';
import { trackRestore } from './hook-restore-track.ts';
import { recordTabNeed } from './hook-tab-need.ts';
import { tabStatusTitleOf } from './hook-tab-status.ts';

/**
 * PostToolUse and PostToolUseFailure, every tool: the tab's title (`hook tab-status`), the session's restore entry
 * (`hook restore-track`) and, once a wake ask waits for the session, its new inbox lines (hook-asked-lines.ts), from
 * one process, since a tool's end is the most frequent hook event. The entry is written at most every few minutes
 * (`TOOL_END_WRITE_MS`), so through a long turn it shows the session's hooks still run. It answers once, with the
 * tab's title and the lines, or prints nothing, and on any error exits 0: it never holds up a turn.
 */
export async function toolEnd(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { event } = await readHookInput(runtime);
  if (event === undefined) {
    return EXIT.ok;
  }
  const [tabTitle, context] = await Promise.all([
    tabStatusTitleOf(runtime, event).catch((): string | undefined => undefined),
    askedLinesOf(runtime, event).catch((): string | undefined => undefined),
    trackRestore(event, runtime).catch(() => undefined),
    recordTabNeed(runtime, event).catch(() => undefined),
  ]);
  writeReply(runtime, event.name === 'tool-failed' ? 'tool-failed' : 'tool-end', { tabTitle, context });
  return EXIT.ok;
}
