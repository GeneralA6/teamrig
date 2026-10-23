import { isRecord, type JsonRecord } from '../../core/guards.ts';
import { toJsonlLine } from '../../core/jsonl.ts';
import { hookAsksOf } from '../../hooks/permission.ts';
import { promptAnswerOf, promptAnswerOutput, promptAnswerRecord, refusedTool } from '../../hooks/prompt-refuse.ts';
import { callReads } from '../../hooks/readonly-shell.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { envSession, parseJson, sessionTeam } from './hook-input.ts';
import { readonlyCheckOf } from './hook-readonly-allow.ts';

/**
 * What the hook prints for this payload: the answer for its case (an allow for a read-only line, else a refusal with
 * its reason), or '' when the prompt opens. Each answer is logged to the team's prompt answers.
 */
async function promptRefuseOutputOf(runtime: CliRuntime, payload: JsonRecord): Promise<string> {
  const found = await sessionTeam(payload, runtime);
  if (found.kind !== 'team') {
    return '';
  }
  const kit = await openKit(runtime, found.team);
  const tool = refusedTool(hookAsksOf(kit.load), payload);
  if (tool === undefined || kit.load.status !== 'loaded') {
    return '';
  }
  // The prompt would wait for a person under refuse, so a provably read-only line runs even with the read-only allow off.
  const check = await readonlyCheckOf(runtime, kit.load.config);
  const answer = promptAnswerOf(tool, payload, (call) => callReads(call, check.rules, check.printsSecret));
  const record = promptAnswerRecord({ at: new Date(runtime.clock.now()), session: envSession(runtime), claudeSession: sessionIdOf(payload), tool, answer, payload });
  // Best effort: the log feeds the daily triage, and a full disk must not turn the answer into an open prompt.
  await runtime.files.append(kit.paths.promptAnswers, toJsonlLine(record)).catch(() => undefined);
  return promptAnswerOutput(tool, answer);
}

/**
 * PermissionRequest: under `prompts.hookAsks: refuse` in the team config, answers the permission prompt Claude Code is
 * about to raise, per case (hooks/prompt-refuse.ts): a line that provably only reads runs; a line teamrig's rules give
 * a rerun form is refused quoting it; anything else is refused with a reason that says to record the step as waiting
 * for the owner and take the next task. It logs each answer to `state/prompt-answers.jsonl`. Outside a team, with asks
 * on or the config missing or broken, for the question picker or plan mode's exit, for input that is not a hook
 * payload or on any error, it prints nothing, so the prompt opens.
 */
export async function promptRefuse(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const output = isRecord(payload) ? await promptRefuseOutputOf(runtime, payload).catch(() => '') : '';
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}
