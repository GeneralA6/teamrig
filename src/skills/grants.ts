import { shellBraceReads } from './js-shell-reads.ts';

/**
 * The privileged calls a skill's scripts make, which auto mode never sees: it judges the `node <script>` line, not
 * what the script runs (T746: a skill's script ran kubectl exec with a key read from the pod env for 13 runs, while
 * the same call written inline was refused). A skill names each kind its scripts make on a body line
 * `Grants: pod-exec, secret-read`, so whoever runs or reviews it sees the owner grants it relies on; the skills lint
 * flags a kind a script makes that no such line names.
 */
export const GRANT_KINDS = ['pod-exec', 'secret-read', 'auth-header'] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

/** A script in a skill's folder: its name there and its text. */
export interface SkillScript {
  readonly name: string;
  readonly text: string;
}

const SCRIPT_FILE = /\.(?:[cm]?[jt]s|sh|ps1|py)$/;

/** A script's spec (`a.test.ts`, `a.spec.mjs`, `test_a.py`, `a_test.py`): the test runner runs it, never the skill. */
const SPEC_FILE = /\.(?:test|spec)\.[cm]?[jt]s$|^test_[^/]*\.py$|_test\.py$/;

/** A file in a skill's folder that the lint reads as a script the skill runs: a script kind, not its spec. */
export function isSkillScript(file: string): boolean {
  return SCRIPT_FILE.test(file) && !SPEC_FILE.test(file);
}

const GRANTS_LINE = /^Grants:[ \t]*(.*)$/gm;

/** A name segment that marks an environment variable as holding a credential (`API_KEY`, `DATABASE_URI_LOCAL`). */
const SECRET_SEGMENTS = new Set(['KEY', 'KEYS', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS', 'CREDENTIAL', 'CREDENTIALS', 'URI']);

/** Shell reads by name: `$NAME`, `${NAME}`, `$env:NAME`. */
const SHELL_READS = /\$(?:env:)?\{?([A-Z][A-Z0-9_]*)/g;

/** The shell reads a JS or TS script spells as a shell does, `$NAME` and `$env:NAME`; js-shell-reads.ts reads its `${NAME}`. */
const UNBRACED_SHELL_READS = /\$(?:env:)?([A-Z][A-Z0-9_]*)/g;

/** Environment reads through the language: `process.env.NAME`, `process.env['NAME']`, `os.environ['NAME']`, `os.getenv('NAME')`. */
const LANGUAGE_READS = [
  /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\b(?:process\.env|os\.environ)\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /\bos\.(?:environ\.get|getenv)\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
];

/** A JavaScript or TypeScript script, whose template literals spell `${...}` for a JS value. */
const JS_FILE = /\.[cm]?[jt]s$/;

function namesRead(pattern: RegExp, text: string): string[] {
  return Array.from(text.matchAll(pattern), (match) => match[1] ?? '');
}

/** The env variables a script reads by name, through a shell it runs or through its language. */
function envReads({ name, text }: SkillScript): string[] {
  const shell = JS_FILE.test(name) ? [...namesRead(UNBRACED_SHELL_READS, text), ...shellBraceReads(text)] : namesRead(SHELL_READS, text);
  return [...shell, ...LANGUAGE_READS.flatMap((pattern) => namesRead(pattern, text))];
}

function readsSecretEnv(script: SkillScript): boolean {
  return envReads(script).some((name) => name.toUpperCase().split('_').some((segment) => SECRET_SEGMENTS.has(segment)));
}

/** kubectl's subcommand written inline (`kubectl -n x exec`) or as an argv item (`'kubectl', ['exec', ...]`). */
function runsKubectl(text: string, subcommand: RegExp): boolean {
  return /\bkubectl\b/.test(text) && subcommand.test(text);
}

const DETECTORS: readonly { readonly kind: GrantKind; readonly makes: (script: SkillScript) => boolean }[] = [
  { kind: 'pod-exec', makes: ({ text }) => runsKubectl(text, /\bkubectl\b[^\n]*?\sexec\b|['"`]exec['"`]/) },
  {
    kind: 'secret-read',
    makes: (script) => runsKubectl(script.text, /\bget\s+secrets?\b|['"`]get['"`]\s*,\s*['"`]secrets?['"`]/) || readsSecretEnv(script),
  },
  { kind: 'auth-header', makes: ({ text }) => /\bauthorization\s*['"`]?\s*:|\bBearer\s|\bx-[a-z0-9-]*(?:key|token|secret|auth)\s*['"`]?\s*:/i.test(text) },
];

/** The privileged kinds a script makes, in GRANT_KINDS order. */
export function grantsMadeBy(script: SkillScript): GrantKind[] {
  return DETECTORS.filter((detector) => detector.makes(script)).map((detector) => detector.kind);
}

function isGrantKind(word: string): word is GrantKind {
  return GRANT_KINDS.some((kind) => kind === word);
}

/** The kinds a skill's `Grants:` lines name, and the words on them that name no kind. */
export function grantsOf(text: string): { readonly declared: ReadonlySet<GrantKind>; readonly unknown: readonly string[] } {
  const declared = new Set<GrantKind>();
  const unknown: string[] = [];
  for (const match of text.matchAll(GRANTS_LINE)) {
    for (const word of (match[1] ?? '').split(/[\s,]+/).filter((each) => each !== '')) {
      if (isGrantKind(word)) {
        declared.add(word);
      } else {
        unknown.push(word);
      }
    }
  }
  return { declared, unknown };
}

/** One line per gap: each word on a `Grants:` line that is no kind, then each kind a script makes that none names. */
export function grantGaps(text: string, scripts: readonly SkillScript[]): string[] {
  const { declared, unknown } = grantsOf(text);
  const gaps = unknown.map((word) => `"Grants: ${word}" names no grant kind: use ${GRANT_KINDS.join(', ')}`);
  const missing = new Map<GrantKind, string[]>();
  for (const script of scripts) {
    for (const kind of grantsMadeBy(script).filter((made) => !declared.has(made))) {
      missing.set(kind, [...(missing.get(kind) ?? []), script.name]);
    }
  }
  for (const kind of GRANT_KINDS.filter((each) => missing.has(each))) {
    const where = (missing.get(kind) ?? []).join(', ');
    gaps.push(`${kind} in ${where}, which auto mode does not see: with the owner's grant add "Grants: ${kind}", else drop the call`);
  }
  return gaps;
}
