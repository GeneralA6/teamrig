import { isRecord } from '../../core/guards.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { parseJson } from './hook-input.ts';
import { trackRestore } from './hook-restore-track.ts';
import { tabStatusOutputOf } from './hook-tab-status.ts';

/**
 * PostToolUse and PostToolUseFailure, every tool: the tab's title (`hook tab-status`) and the session's restore
 * entry (`hook restore-track`) from one process, since a tool's end is the most frequent hook event. The entry is
 * written at most every few minutes (`TOOL_END_WRITE_MS`), so through a long turn it shows the session's hooks
 * still run. It prints the title's terminal sequence or nothing, and on any error exits 0: it never holds up a turn.
 */
export async function toolEnd(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  if (!isRecord(payload)) {
    return EXIT.ok;
  }
  const [output] = await Promise.all([tabStatusOutputOf(runtime, payload).catch(() => ''), trackRestore(payload, runtime).catch(() => undefined)]);
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}
