import { postToolUseReplace } from '../../hooks/post-tool-use.ts';
import { secretGuardOf, secretPatternsOf } from '../../hooks/secret-guard.ts';
import { redactableResultOf, redactedLine, rotationText, rotatorOf } from '../../hooks/secret-redact.ts';
import { EnvAssignments } from '../../secret-guard/env-assignments.ts';
import { ToolOutputRedactor } from '../../secret-guard/redactor.ts';
import { secretRulesOf } from '../../secret-guard/rules.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { guardLoadOf } from './hook-guard-load.ts';
import { parseJson } from './hook-input.ts';
import { fileRotations } from './secret-rotation.ts';

/**
 * PostToolUse on Bash, PowerShell, Read and Grep (T1369 R7): replaces each secret the tool's result holds before the
 * model and the transcript see it, by the write-time shapes, the team's own patterns and the value of a secret variable.
 * A helper's calls are redacted too. Each kind found gets a rotation task (R8, see `fileRotations`), named in the line
 * for the model. A broken config keeps the defaults; outside a team's projects, or with `secretGuard.redact` off, it
 * prints nothing.
 */
export async function secretRedact(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const guard = await guardLoadOf(payload, runtime);
  if (guard === undefined) {
    return EXIT.ok;
  }
  const config = secretGuardOf(guard.load);
  const result = redactableResultOf(payload);
  if (!config.redact || result === undefined) {
    return EXIT.ok;
  }
  const rules = secretRulesOf(config, runtime.userHome, runtime.platform, secretPatternsOf(guard.load));
  const redaction = new ToolOutputRedactor([rules.shapes, new EnvAssignments(rules.names)]).redact(result.response);
  if (redaction.classes.length === 0) {
    return EXIT.ok;
  }
  const rotations = await fileRotations(runtime, result.payload, { tool: result.tool, kinds: redaction.classes, accounts: redaction.accounts });
  runtime.out.stdout(postToolUseReplace(redaction.response, redactedLine(redaction, rotationText(rotatorOf(guard.load), rotations))));
  return EXIT.ok;
}
