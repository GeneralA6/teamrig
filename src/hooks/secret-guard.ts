import { DEFAULT_SECRET_GUARD } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { SecretGuardConfig, SecretReads } from '../config/types.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { resolveDir } from '../push-guard/location.ts';
import { describeFinding, type SecretFinding } from '../secret-guard/findings.ts';
import type { SecretRules } from '../secret-guard/rules.ts';
import { shellFindings } from '../secret-guard/shell.ts';

export interface SecretGuardEnv {
  /** The folder to judge from when the payload names none. */
  readonly cwd: string;
  readonly rules: SecretRules;
  readonly secretReads: SecretReads;
}

/** The secret guard's config. A missing or unreadable config keeps the default, so a broken config never switches the guard off. */
export function secretGuardOf(load: ConfigLoad | undefined): SecretGuardConfig {
  return load?.status === 'loaded' ? load.config.secretGuard : DEFAULT_SECRET_GUARD;
}

/**
 * The secrets a tool call would print into the conversation: what a Bash or PowerShell line prints, the file a Read
 * opens, and the file or glob a Grep shows matching lines of. A Grep that lists file names or counts prints no
 * content; one over a folder with no glob may still show a secret file's lines: a gap.
 */
export function secretFindingsOf(payload: JsonRecord, cwd: string, rules: SecretRules): SecretFinding[] {
  const input = recordField(payload, 'tool_input') ?? {};
  const dir = stringField(payload, 'cwd') ?? cwd;
  const tool = stringField(payload, 'tool_name');
  switch (tool) {
    case 'Bash':
    case 'PowerShell': {
      const command = stringField(input, 'command');
      return command === undefined ? [] : shellFindings(command, { cwd: dir, home: rules.home, dialect: tool === 'PowerShell' ? 'powershell' : 'bash' }, rules);
    }
    case 'Read': {
      const path = stringField(input, 'file_path');
      return path !== undefined && rules.paths.listed(toolPath(path, dir, rules.home)) ? [{ kind: 'file', path }] : [];
    }
    case 'Grep':
      return grepFindings(input, dir, rules);
    default:
      return [];
  }
}

/** The secret file a Grep that shows content searches, named by its path or its glob. */
function grepFindings(input: JsonRecord, dir: string, rules: SecretRules): SecretFinding[] {
  if (stringField(input, 'output_mode') !== 'content') {
    return [];
  }
  const path = stringField(input, 'path');
  const target = toolPath(path ?? '.', dir, rules.home);
  if (path !== undefined && rules.paths.listed(target)) {
    return [{ kind: 'file', path }];
  }
  const glob = stringField(input, 'glob');
  return glob !== undefined && rules.paths.mayName(`${target}/${glob}`, true) ? [{ kind: 'file', path: glob }] : [];
}

/** The absolute path a tool's path input names: a relative one starts in the call's folder, a drive path is Windows' on every host. */
function toolPath(text: string, dir: string, home: string): string {
  return resolveDir(dir, text, home) ?? text;
}

/** Why the call is refused or asked about, with the ways to use or check a secret that never print it. */
export function secretReason(findings: readonly SecretFinding[]): string {
  const what = findings.map(describeFinding);
  const named = what.length < 2 ? what.join('') : `${what.slice(0, -1).join(', ')} and ${what.at(-1) ?? ''}`;
  return (
    `teamrig secret guard: this call would print ${named} into the conversation. Hand a secret to the tool that needs ` +
    'it (stdin, an env file option, a pipe), check it without printing it (grep -q, wc -c, a hash), or ask the owner to ' +
    'look in their own terminal. A false match: add its !glob to secretGuard.paths or its !pattern to secretGuard.envNames. ' +
    '[secretGuard.secretReads]'
  );
}

/**
 * The PreToolUse output for a Bash, PowerShell, Read or Grep call: a refusal (or a question, as
 * `secretGuard.secretReads` says) when the call would print a secret into the conversation; else nothing, so the
 * normal permission flow decides.
 */
export function secretGuardOutput(payload: unknown, env: SecretGuardEnv): string {
  if (env.secretReads === 'allow' || !isRecord(payload)) {
    return '';
  }
  const findings = secretFindingsOf(payload, env.cwd, env.rules);
  if (findings.length === 0) {
    return '';
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: env.secretReads, permissionDecisionReason: secretReason(findings) },
  });
}
