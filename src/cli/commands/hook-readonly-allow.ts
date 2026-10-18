import { isRecord, type JsonRecord } from '../../core/guards.ts';
import { readonlyRulesOf, readonlyShellOutput } from '../../hooks/readonly-shell.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { parseJson, sessionTeam } from './hook-input.ts';

/**
 * What the hook prints for this payload: an allow for a line that only reads when the session's team turned the hook
 * on, else ''. It reads the session's team, not the one of the folder the line `cd`s into, so a line never gains
 * another team's trusted prefixes.
 */
async function readonlyAllowOutputOf(runtime: CliRuntime, payload: JsonRecord): Promise<string> {
  const found = await sessionTeam(payload, runtime);
  const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
  if (kit?.load.status !== 'loaded' || !kit.load.config.readonlyShell.enabled) {
    return '';
  }
  return readonlyShellOutput(payload, readonlyRulesOf(kit.load.config.readonlyShell, runtime.env));
}

/**
 * PreToolUse on Bash and PowerShell: with `readonlyShell.enabled`, lets a line whose every command provably only
 * reads (hooks/readonly-shell.ts) run without a permission prompt. Outside a team, with the hook off, for a line it
 * cannot prove reads, for input that is not a hook payload or on any error, it prints nothing, so Claude Code's own
 * permission check decides: it fails closed.
 */
export async function readonlyAllow(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const output = isRecord(payload) ? await readonlyAllowOutputOf(runtime, payload).catch(() => '') : '';
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}
