import { isRecord, numberField, stringField } from '../../core/guards.ts';
import { TRACE_ERROR_CHARS } from '../../mod/hand-watch.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { parseJson } from './hook-input.ts';
import { wakeScopeOf } from './hook-wake.ts';

/** How long a hand's name may be in the log; the mod's hands have one-word names. */
const HAND_CHARS = 40;

/**
 * `hook hand-trace`: the mod's watch over its hands (src/mod/hand-watch.ts) reports a tick that threw or stayed
 * unsettled past its limit, and this appends one line for it to the team's `state/hand-trace.jsonl` (#920), so a
 * hand that stopped answering leaves a trace outside Claude Code's debug log. A tab that is no team session, or a
 * payload that names no hand or kind, logs nothing. It always exits 0: the mod never waits on its answer.
 */
export async function handTrace(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  if (!isRecord(payload)) {
    return EXIT.ok;
  }
  const hand = stringField(payload, 'hand')?.slice(0, HAND_CHARS);
  const kind = stringField(payload, 'kind');
  const detail =
    kind === 'threw'
      ? { error: (stringField(payload, 'error') ?? 'no error given').slice(0, TRACE_ERROR_CHARS) }
      : kind === 'stalled'
        ? { ms: Math.max(0, Math.round(numberField(payload, 'ms') ?? 0)) }
        : undefined;
  if (hand === undefined || hand === '' || detail === undefined) {
    return EXIT.ok;
  }
  const scope = await wakeScopeOf(runtime, payload, false);
  if (scope.kind === 'off') {
    return EXIT.ok;
  }
  const line = { v: 1, at: new Date(runtime.clock.now()).toISOString(), session: scope.id, tab: scope.tab, hand, kind, ...detail };
  await runtime.files.append(scope.kit.paths.handTraceLog, `${JSON.stringify(line)}\n`);
  return EXIT.ok;
}
