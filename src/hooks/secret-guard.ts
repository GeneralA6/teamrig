import { DEFAULT_SECRET_GUARD } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { SecretGuardConfig, SecretReads, SecretWrites } from '../config/types.ts';
import type { EditCall, HookEvent, HookReply, SearchCall } from '../ports/host/index.ts';
import { resolveDir } from '../push-guard/location.ts';
import { describeFinding, uniqueFindings, type SecretFinding } from '../secret-guard/findings.ts';
import { braceAlternatives } from '../secret-guard/glob.ts';
import { literalFindings, writtenFindings } from '../secret-guard/literals.ts';
import type { SecretRules } from '../secret-guard/rules.ts';
import { shellFindings } from '../secret-guard/shell.ts';
import { heldBack } from './permission.ts';

/** The most `{a,b}` alternatives the guard spells out of one Grep glob; one with more counts as naming a secret file. */
const MAX_GREP_ALTERNATIVES = 64;

/**
 * The longest Grep glob the guard reads; a longer one counts as naming a secret file. Reading a glob's groups and sets
 * costs time cubic in its length (`{[` repeated 8,000 times took 4.2 s, 16,000 times 33 s, past the hook's 15 s), and
 * a glob a person or a model writes for a search stays far shorter.
 */
const MAX_GREP_GLOB_LENGTH = 1024;

export interface SecretGuardEnv {
  /** The folder to judge from when the payload names none. */
  readonly cwd: string;
  readonly rules: SecretRules;
  /** What a call that would print a secret gets. */
  readonly secretReads: SecretReads;
  /** What a call whose command line or written text holds a secret gets. */
  readonly writes: SecretWrites;
}

/** The secret guard's config. A missing or unreadable config keeps the default, so a broken config never switches the guard off. */
export function secretGuardOf(load: ConfigLoad | undefined): SecretGuardConfig {
  return load?.status === 'loaded' ? load.config.secretGuard : DEFAULT_SECRET_GUARD;
}

/**
 * The secrets a tool call would print into the conversation: what a shell line holds as text and what it prints, the
 * file a read opens, and the file or glob a search that shows content reads. A shell line is read in each text its
 * shell may run (the call's `readings`), so a secret the line as written hides behind a run the host rewrites is still
 * found; a finding both readings make comes once per reading. A search that lists file names or counts prints no
 * content; one over a folder with no glob, or only `!globs`, may still show a secret file's lines: a gap. Also the
 * secrets a file-writing call writes as text (T1369 R3), unless it writes a secret file.
 */
export function secretFindingsOf(event: HookEvent, cwd: string, rules: SecretRules): SecretFinding[] {
  const { call } = event;
  const dir = event.cwd ?? cwd;
  switch (call?.kind) {
    case 'shell': {
      const context = { cwd: dir, home: rules.home, dialect: call.dialect };
      return call.readings.flatMap((text) => [...literalFindings(text, rules.shapes), ...shellFindings(text, context, rules)]);
    }
    case 'read':
      return call.path !== undefined && rules.paths.listed(toolPath(call.path, dir, rules.home)) ? [{ kind: 'file', path: call.path }] : [];
    case 'search':
      return searchFindings(call, dir, rules);
    case 'edit':
      return writeFindings(call, dir, rules);
    default:
      return [];
  }
}

/**
 * The secrets a file-writing call writes as text (the call's `texts`). A secret file (`secretGuard.paths`) is where a
 * secret belongs, so a call that writes one passes; every other folder, tests too, is read.
 */
function writeFindings(call: EditCall, dir: string, rules: SecretRules): SecretFinding[] {
  if (call.path !== undefined && rules.paths.listed(toolPath(call.path, dir, rules.home))) {
    return [];
  }
  return writtenFindings(call.texts, rules.shapes);
}

/** The secret file a search that shows content reads, named by its path or by a glob that picks the files it reads. */
function searchFindings(call: SearchCall, dir: string, rules: SecretRules): SecretFinding[] {
  if (!call.showsContent) {
    return [];
  }
  const { path } = call;
  const target = toolPath(path ?? '.', dir, rules.home);
  if (path !== undefined && rules.paths.listed(target)) {
    return [{ kind: 'file', path }];
  }
  return grepIncludes(call.glob ?? '')
    .filter((glob) => mayPick(rules, target, glob))
    .map((glob): SecretFinding => ({ kind: 'file', path: glob }));
}

/**
 * True when a Grep `glob` may pick a secret file in `target`: one of its `{a,b}` alternatives may, or it is too long
 * or has too many alternatives to read.
 */
function mayPick(rules: SecretRules, target: string, glob: string): boolean {
  const globs = glob.length > MAX_GREP_GLOB_LENGTH ? undefined : braceAlternatives(glob, MAX_GREP_ALTERNATIVES);
  return globs === undefined || globs.some((one) => rules.paths.mayName(`${target}/${one}`, { dotfiles: true, sets: 'ripgrep' }));
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
 * Why the call is refused or asked about: the saved credentials it reads out of the host's store, then what it would print, with the ways to use or check a secret that never print
 * it, then the secrets its command line holds as text, with the ways to pass one by reference, then the secrets the
 * text it writes holds, with where a real one belongs and how a test builds one; last, the keys that set it.
 */
export function secretReason(findings: readonly SecretFinding[]): string {
  const stores = findings.filter(({ kind }) => kind === 'credential').map(describeFinding);
  const what = findings.filter(({ kind }) => kind !== 'literal' && kind !== 'written' && kind !== 'credential').map(describeFinding);
  const shapes = findings.filter(({ kind }) => kind === 'literal').map(describeFinding);
  const writes = findings.filter(({ kind }) => kind === 'written').map(describeFinding);
  const named = what.length < 2 ? what.join('') : `${what.slice(0, -1).join(', ')} and ${what.at(-1) ?? ''}`;
  const reads =
    stores.length === 0
      ? []
      : [
          `this call reads a saved credential out of the host's credential store (${stores.join(', ')}), printed or not. A ` +
            "session never reads the store: each tool's key stays with the tool that reads it (teamrig's own commands read " +
            'theirs themselves). To check a saved key, ask the owner to look in their own terminal.',
        ];
  const printed =
    what.length === 0
      ? []
      : [
          `${stores.length === 0 ? 'this call would print' : 'It would also print'} ${named} into the conversation. Hand a secret to the tool that needs it (stdin, an env ` +
            'file option, a pipe), check it without printing it (grep -q, wc -c, a hash), or ask the owner to look in ' +
            'their own terminal. A false match: add its !glob to secretGuard.paths or its !pattern to secretGuard.envNames or ' +
            'secretGuard.commands.',
        ];
  const written =
    shapes.length === 0
      ? []
      : [
          `${what.length + stores.length === 0 ? "this call's" : 'Its'} command line holds a secret as text (${shapes.join(', ')}). Pass it by ` +
            'reference (its env var name, a file path, stdin, `teamrig exec request`), never as text.',
        ];
  const writing =
    writes.length === 0
      ? []
      : [
          `${what.length + shapes.length + stores.length === 0 ? 'the' : 'The'} text this call writes holds a secret (${writes.join(', ')}). Keep ` +
            'a real one in a secret file (secretGuard.paths, such as .env) and name it by its env var or path; a test ' +
            "builds a secret-shaped value at run time from parts (join('gh', 'p_', ...)), so no file holds it whole.",
        ];
  const keys = [...(what.length + stores.length === 0 ? [] : ['secretGuard.secretReads']), ...(shapes.length + writes.length === 0 ? [] : ['secretGuard.writes'])];
  return `teamrig secret guard: ${[...reads, ...printed, ...written, ...writing].join(' ')} [${keys.join(', ')}]`;
}

/** The team's own secret patterns (`register.secretPatterns`); none when the config is missing or unreadable. */
export function secretPatternsOf(load: ConfigLoad | undefined): readonly string[] {
  return load?.status === 'loaded' ? load.config.register.secretPatterns : [];
}

/**
 * The reply to a shell, read, search or file-writing call about to run: a refusal (or a question) when the call would
 * print a secret into the conversation, as `secretGuard.secretReads` says, or its command line or the text it writes
 * holds one, as `secretGuard.writes` says; a refusal when either refuses, naming only the findings a key does not
 * allow. Else none, so the normal permission flow decides. Under `hookAsks: refuse` the question is a refusal instead,
 * its reason saying what to do (see `holdBack`). A shell line is judged in each text its shell may run, naming each
 * finding once.
 */
export function secretGuardReply(event: HookEvent, env: SecretGuardEnv): HookReply | undefined {
  if (env.secretReads === 'allow' && env.writes === 'allow') {
    return undefined;
  }
  const findings = uniqueFindings(secretFindingsOf(event, env.cwd, env.rules)).filter((finding) => actionOf(finding, env) !== 'allow');
  if (findings.length === 0) {
    return undefined;
  }
  const decision = findings.some((finding) => actionOf(finding, env) === 'deny') ? 'deny' : 'ask';
  return heldBack(decision, secretReason(findings));
}
