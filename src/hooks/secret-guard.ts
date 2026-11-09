import { DEFAULT_SECRET_GUARD } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { HookAsks, SecretGuardConfig, SecretReads, SecretWrites } from '../config/types.ts';
import { toolCommandReadings } from '../core/bash-tool-readings.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { resolveDir } from '../push-guard/location.ts';
import { describeFinding, uniqueFindings, type SecretFinding } from '../secret-guard/findings.ts';
import { literalFindings, writtenFindings } from '../secret-guard/literals.ts';
import type { SecretRules } from '../secret-guard/rules.ts';
import { shellFindings } from '../secret-guard/shell.ts';
import { holdBackOutput } from './permission.ts';

export interface SecretGuardEnv {
  /** The folder to judge from when the payload names none. */
  readonly cwd: string;
  readonly rules: SecretRules;
  /** What a call that would print a secret gets. */
  readonly secretReads: SecretReads;
  /** What a call whose command line or written text holds a secret gets. */
  readonly writes: SecretWrites;
  readonly hookAsks: HookAsks;
  /** The host's platform: on Windows a Bash line is read as written and as bash receives it (core/bash-tool-readings.ts). */
  readonly platform: NodeJS.Platform;
}

/**
 * The call once for each text its shell may run (`toolCommandReadings`): a Bash line on Windows also as bash receives
 * it, so a secret the line as written hides behind a backslash run is still found. `secretFindingsOf` reads one text,
 * the way the read-only allow calls it per reading; a call with no command line is itself.
 */
function callReadings(payload: JsonRecord, platform: NodeJS.Platform): JsonRecord[] {
  const input = recordField(payload, 'tool_input');
  const command = input === undefined ? undefined : stringField(input, 'command');
  if (input === undefined || command === undefined) {
    return [payload];
  }
  return toolCommandReadings(stringField(payload, 'tool_name'), command, platform).map((text) => ({ ...payload, tool_input: { ...input, command: text } }));
}

/** The secret guard's config. A missing or unreadable config keeps the default, so a broken config never switches the guard off. */
export function secretGuardOf(load: ConfigLoad | undefined): SecretGuardConfig {
  return load?.status === 'loaded' ? load.config.secretGuard : DEFAULT_SECRET_GUARD;
}

/**
 * The secrets a tool call would print into the conversation: what a Bash or PowerShell line holds as text and what it
 * prints, the file a Read opens, and the file or glob a Grep shows matching lines of. A Grep that lists file names or
 * counts prints no content; one over a folder with no glob, or only `!globs`, may still show a secret file's lines: a gap.
 * Also the secrets a Write, Edit, MultiEdit or NotebookEdit call writes as text (T1369 R3), unless it writes a secret file.
 */
export function secretFindingsOf(payload: JsonRecord, cwd: string, rules: SecretRules): SecretFinding[] {
  const input = recordField(payload, 'tool_input') ?? {};
  const dir = stringField(payload, 'cwd') ?? cwd;
  const tool = stringField(payload, 'tool_name');
  switch (tool) {
    case 'Bash':
    case 'PowerShell': {
      const command = stringField(input, 'command');
      return command === undefined
        ? []
        : [...literalFindings(command, rules.shapes), ...shellFindings(command, { cwd: dir, home: rules.home, dialect: tool === 'PowerShell' ? 'powershell' : 'bash' }, rules)];
    }
    case 'Read': {
      const path = stringField(input, 'file_path');
      return path !== undefined && rules.paths.listed(toolPath(path, dir, rules.home)) ? [{ kind: 'file', path }] : [];
    }
    case 'Grep':
      return grepFindings(input, dir, rules);
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return writeFindings(input, dir, rules);
    default:
      return [];
  }
}

/**
 * The secrets a file-writing call writes as text: a Write's `content`, an Edit's `new_string`, each of a MultiEdit's
 * `edits`, a NotebookEdit's `new_source`. A secret file (`secretGuard.paths`) is where a secret belongs, so a call that
 * writes one passes; every other folder, tests too, is read.
 */
function writeFindings(input: JsonRecord, dir: string, rules: SecretRules): SecretFinding[] {
  const path = stringField(input, 'file_path') ?? stringField(input, 'notebook_path');
  if (path !== undefined && rules.paths.listed(toolPath(path, dir, rules.home))) {
    return [];
  }
  const edits = input['edits'];
  const texts = [input, ...(Array.isArray(edits) ? edits.filter(isRecord) : [])].flatMap((record) =>
    ['content', 'new_string', 'new_source'].flatMap((key) => stringField(record, key) ?? []),
  );
  return writtenFindings(texts, rules.shapes);
}

/** The secret file a Grep that shows content searches, named by its path or by a glob that picks the files it reads. */
function grepFindings(input: JsonRecord, dir: string, rules: SecretRules): SecretFinding[] {
  if (stringField(input, 'output_mode') !== 'content') {
    return [];
  }
  const path = stringField(input, 'path');
  const target = toolPath(path ?? '.', dir, rules.home);
  if (path !== undefined && rules.paths.listed(target)) {
    return [{ kind: 'file', path }];
  }
  return grepIncludes(stringField(input, 'glob') ?? '')
    .filter((glob) => rules.paths.mayName(`${target}/${glob}`, true))
    .map((glob): SecretFinding => ({ kind: 'file', path: glob }));
}

/**
 * The globs of a Grep's `glob` input that pick the files it reads. Claude Code splits the input at whitespace, then
 * at commas in a part with no `{...}`, and hands ripgrep each as a `--glob`; a `!glob` names files the search skips.
 */
function grepIncludes(text: string): string[] {
  return text
    .split(/\s+/)
    .flatMap((part) => (part.includes('{') && part.includes('}') ? [part] : part.split(',')))
    .filter((glob) => glob !== '' && !glob.startsWith('!'));
}

/** The absolute path a tool's path input names: a relative one starts in the call's folder, a drive path is Windows' on every host. */
function toolPath(text: string, dir: string, home: string): string {
  return resolveDir(dir, text, home) ?? text;
}

/** A secret held as text, in a command line or a written file, is `secretGuard.writes`' to settle; one printed, `secretGuard.secretReads`'. */
function holdsAsText(finding: SecretFinding): boolean {
  return finding.kind === 'literal' || finding.kind === 'written';
}

function actionOf(finding: SecretFinding, env: SecretGuardEnv): SecretReads | SecretWrites {
  return holdsAsText(finding) ? env.writes : env.secretReads;
}

/**
 * Why the call is refused or asked about: what it would print, with the ways to use or check a secret that never print
 * it, then the secrets its command line holds as text, with the ways to pass one by reference, then the secrets the
 * text it writes holds, with where a real one belongs and how a test builds one; last, the keys that set it.
 */
export function secretReason(findings: readonly SecretFinding[]): string {
  const what = findings.filter(({ kind }) => kind !== 'literal' && kind !== 'written').map(describeFinding);
  const shapes = findings.filter(({ kind }) => kind === 'literal').map(describeFinding);
  const writes = findings.filter(({ kind }) => kind === 'written').map(describeFinding);
  const named = what.length < 2 ? what.join('') : `${what.slice(0, -1).join(', ')} and ${what.at(-1) ?? ''}`;
  const printed =
    what.length === 0
      ? []
      : [
          `this call would print ${named} into the conversation. Hand a secret to the tool that needs it (stdin, an env ` +
            'file option, a pipe), check it without printing it (grep -q, wc -c, a hash), or ask the owner to look in ' +
            'their own terminal. A false match: add its !glob to secretGuard.paths or its !pattern to secretGuard.envNames or ' +
            'secretGuard.commands.',
        ];
  const written =
    shapes.length === 0
      ? []
      : [
          `${what.length === 0 ? "this call's" : 'Its'} command line holds a secret as text (${shapes.join(', ')}). Pass it by ` +
            'reference (its env var name, a file path, stdin, `teamrig exec request`), never as text.',
        ];
  const writing =
    writes.length === 0
      ? []
      : [
          `${what.length + shapes.length === 0 ? 'the' : 'The'} text this call writes holds a secret (${writes.join(', ')}). Keep ` +
            'a real one in a secret file (secretGuard.paths, such as .env) and name it by its env var or path; a test ' +
            "builds a secret-shaped value at run time from parts (join('gh', 'p_', ...)), so no file holds it whole.",
        ];
  const keys = [...(what.length === 0 ? [] : ['secretGuard.secretReads']), ...(shapes.length + writes.length === 0 ? [] : ['secretGuard.writes'])];
  return `teamrig secret guard: ${[...printed, ...written, ...writing].join(' ')} [${keys.join(', ')}]`;
}

/** The team's own secret patterns (`register.secretPatterns`); none when the config is missing or unreadable. */
export function secretPatternsOf(load: ConfigLoad | undefined): readonly string[] {
  return load?.status === 'loaded' ? load.config.register.secretPatterns : [];
}

/**
 * The PreToolUse output for a Bash, PowerShell, Read, Grep or file-writing call: a refusal (or a question) when the call
 * would print a secret into the conversation, as `secretGuard.secretReads` says, or its command line or the text it
 * writes holds one, as `secretGuard.writes` says; a refusal when either refuses, naming only the findings a key does
 * not allow. Else nothing, so the normal permission flow decides. Under `hookAsks: refuse` the question is a refusal
 * instead, its reason saying what to do (see `holdBack`). A Bash line on Windows is judged in each reading bash may run
 * (`toolCommandReadings`), naming each finding once.
 */
export function secretGuardOutput(payload: unknown, env: SecretGuardEnv): string {
  if ((env.secretReads === 'allow' && env.writes === 'allow') || !isRecord(payload)) {
    return '';
  }
  const findings = uniqueFindings(callReadings(payload, env.platform).flatMap((call) => secretFindingsOf(call, env.cwd, env.rules))).filter(
    (finding) => actionOf(finding, env) !== 'allow',
  );
  if (findings.length === 0) {
    return '';
  }
  const decision = findings.some((finding) => actionOf(finding, env) === 'deny') ? 'deny' : 'ask';
  return holdBackOutput(decision, secretReason(findings), env.hookAsks);
}
