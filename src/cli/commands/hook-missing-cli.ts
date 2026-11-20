import { KIT_NAME } from '../../core/home.ts';
import { missingCliLine, missingCliOf } from '../../hooks/missing-cli.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { readHookInput, writeReply } from './hook-input.ts';

/**
 * PostToolUse and PostToolUseFailure on Bash and PowerShell: after a call whose shell did not find the bare
 * command, hands the model one line to run this CLI by its path for the rest of the session (hooks/missing-cli.ts).
 * It runs for any session, in a team or not, and opens no team; for any other call it prints nothing.
 */
export async function missingCli(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { event } = await readHookInput(runtime);
  const on = event === undefined ? undefined : missingCliOf(event);
  if (on !== undefined) {
    writeReply(runtime, on, { context: missingCliLine(runtime.self.script, KIT_NAME) });
  }
  return EXIT.ok;
}
