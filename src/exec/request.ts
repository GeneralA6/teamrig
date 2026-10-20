import { posix, win32 } from 'node:path';
import { isRecord, isStringArray, type JsonRecord } from '../core/guards.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { MS_PER_HOUR } from '../core/time.ts';
import { canonicalJson, sha256Hex } from './digest.ts';

/** What a privileged command changes (security spec T754 §3); every kind needs a request and an approval. */
export const EXEC_KINDS = ['db-write', 'route', 'pod-exec', 'cluster-write', 'external-write'] as const;
export type ExecKind = (typeof EXEC_KINDS)[number];

/** The longest a run may take before the executor kills it, and the longest an approval window may last. */
export const MAX_RUNTIME_SEC = (4 * MS_PER_HOUR) / 1000;

/**
 * The code a run is bound to, so an edit after approval changes what would run and is refused: a commit of the
 * repository the command runs in, with its lockfile's SHA-256, or, for a pod exec, the target container's image digest.
 */
export type CodeBinding = { readonly repo: string; readonly commit: string; readonly lockSha256: string } | { readonly image: string };

/** When the requester wants the command run: not before `runAfter`, and never after `expiresBy` (UTC ISO instants). */
export interface RunWindow {
  readonly runAfter: string;
  readonly expiresBy: string;
}

/** What a requester's file asks for (spec §5): the command, its code binding and its case. */
export interface RequestDraft {
  readonly kind: ExecKind;
  /** The register task the command serves (T<n>). */
  readonly task: string;
  /** The store, route or pod it changes, in words: `local app.items`, `POST /admin/x`, `pod/worker-0 container worker`. */
  readonly target: string;
  /** The command as a list, never a shell string; started without a shell. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly binding: CodeBinding;
  /** The variables the executor injects into the run, by name (least privilege: a local write never gets a cloud database URI). */
  readonly envNames: readonly string[];
  /** The read-only variables the dry run gets, by name. */
  readonly readEnvNames: readonly string[];
  readonly maxRuntimeSec: number;
  /** Whether running it twice is safe (idempotent or resumable). */
  readonly rerunSafe: boolean;
  readonly purpose: string;
  /** The expected effect: inserted, unchanged, changed counts; the ids or a bounded sample. */
  readonly expected: string;
  /** The read-only form the executor runs before review, with the read variables only; null when the kind has none. */
  readonly dryRunArgv: readonly string[] | null;
  /** The read-only preview a command with no dry run carries instead (the GET the write changes, before and after). */
  readonly preview: string | null;
  /** How to undo it: the rollback command or the backup path. */
  readonly rollback: string;
  readonly window: RunWindow | null;
  /** The requester's own flag that the command is owner-gated (spec §9); the reviewer may escalate one that is not. */
  readonly ownerGated: boolean;
}

/** A request as the audit log holds it: the draft plus who asked, when, and the programs it starts, resolved. */
export interface ExecRequest extends RequestDraft {
  /** R<n>, numbered by the audit log. */
  readonly id: string;
  /** The session that asked (self-declared in phase 1; phase 2 adds the OS account). */
  readonly requester: string;
  readonly createdAt: string;
  /** argv[0] resolved to the absolute file the executor starts; part of every hash. */
  readonly program: string;
  /** dryRunArgv[0] resolved likewise; null with no dry run. */
  readonly dryRunProgram: string | null;
}

export type DraftParse = { readonly ok: true; readonly draft: RequestDraft } | { readonly ok: false; readonly problems: readonly string[] };

/** How argv[0] is found: an absolute path as given, or a bare name on the executor's own PATH; anything else is refused. */
export type ProgramLookup = { readonly kind: 'absolute'; readonly path: string } | { readonly kind: 'name'; readonly name: string } | { readonly kind: 'refused'; readonly reason: string };

const TASK_ID = /^T[1-9]\d*$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^\S+@sha256:[0-9a-f]{64}$/u;
/**
 * Options that hand an interpreter inline code: `node -e/-p`, a database shell's `--eval`, `python -c`, `pwsh -Command`. Spec §5
 * allows inline code for reads and pod-exec diagnostics only, so a write must run a committed script. Matched anywhere
 * in argv (a database shell takes `--eval` after its address); a script of its own with such an option renames it.
 */
const INLINE_CODE_OPTIONS = new Set(['-e', '--eval', '-p', '--print', '-c', '-command', '-encodedcommand', '-ec']);

function isAbsolutePath(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path);
}

/** The first argument that hands an interpreter inline code, as typed; undefined when there is none. */
export function inlineCodeOption(argv: readonly string[]): string | undefined {
  return argv.slice(1).find((arg) => INLINE_CODE_OPTIONS.has((arg.split('=')[0] ?? arg).toLowerCase()));
}

/** How argv[0] is looked up: a name with a folder in it but no root would depend on the cwd, so it is refused. */
export function programLookup(program: string): ProgramLookup {
  if (isAbsolutePath(program)) {
    return { kind: 'absolute', path: program };
  }
  if (program.includes('/') || program.includes('\\')) {
    return { kind: 'refused', reason: `argv[0] "${program}" is a relative path: give a program name on the exec PATH or an absolute path` };
  }
  return { kind: 'name', name: program };
}

/** Reads one draft field by field, collecting every problem rather than stopping at the first. */
class DraftReader {
  readonly problems: string[] = [];
  private readonly raw: JsonRecord;

  constructor(raw: JsonRecord) {
    this.raw = raw;
  }

  text(key: string): string {
    const value = this.raw[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
    this.problems.push(`${key} is required, as non-empty text`);
    return '';
  }

  optionalText(key: string): string | null {
    const value = this.raw[key];
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
    this.problems.push(`${key} is non-empty text or null`);
    return null;
  }

  flag(key: string): boolean {
    const value = this.raw[key];
    if (typeof value === 'boolean') {
      return value;
    }
    this.problems.push(`${key} is required, as true or false`);
    return false;
  }

  argv(key: string, required: boolean): readonly string[] | null {
    const value = this.raw[key];
    if (!required && (value === undefined || value === null)) {
      return null;
    }
    if (isStringArray(value) && value.length > 0 && value.every((arg) => !arg.includes('\0')) && (value[0] ?? '').trim() !== '') {
      return value;
    }
    this.problems.push(`${key} is ${required ? 'required, as' : 'null or'} a JSON array of strings, the program first (never a shell string)`);
    return required ? [] : null;
  }

  envNames(key: string): readonly string[] {
    const value = this.raw[key] ?? [];
    if (!isStringArray(value) || value.some((name) => !ENV_NAME.test(name))) {
      this.problems.push(`${key} is a list of variable names (letters, digits, _), never values`);
      return [];
    }
    if (new Set(value).size !== value.length) {
      this.problems.push(`${key} names a variable twice`);
    }
    return value;
  }

  kind(): ExecKind {
    const value = this.raw['kind'];
    const kind = EXEC_KINDS.find((candidate) => candidate === value);
    if (kind === undefined) {
      this.problems.push(`kind is one of ${EXEC_KINDS.join(', ')}`);
      return 'db-write';
    }
    return kind;
  }

  runtime(): number {
    const value = this.raw['maxRuntimeSec'];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_RUNTIME_SEC) {
      return value;
    }
    this.problems.push(`maxRuntimeSec is a whole number of seconds, 1 to ${MAX_RUNTIME_SEC}`);
    return 1;
  }

  /** A pod exec runs no code of ours, so it binds the target's image; every other kind runs a committed script. */
  binding(kind: ExecKind): CodeBinding {
    const value = this.raw['binding'];
    const podExec = kind === 'pod-exec';
    if (isRecord(value) && typeof value['image'] === 'string') {
      if (!podExec) {
        this.problems.push(`binding is {repo, commit, lockSha256}: a ${kind} runs code bound by commit`);
      } else if (!IMAGE_DIGEST.test(value['image'])) {
        this.problems.push('binding.image is an image pinned by digest: <name>@sha256:<64 hex>');
      }
      return { image: value['image'] };
    }
    if (podExec) {
      this.problems.push('a pod-exec binds the target image by digest: binding {image}');
      return { image: '' };
    }
    if (isRecord(value) && typeof value['repo'] === 'string' && typeof value['commit'] === 'string' && typeof value['lockSha256'] === 'string') {
      if (!isAbsolutePath(value['repo'])) {
        this.problems.push('binding.repo is the absolute path of the repository');
      }
      if (!COMMIT_SHA.test(value['commit'])) {
        this.problems.push('binding.commit is a full commit sha (40 lowercase hex)');
      }
      if (!SHA256.test(value['lockSha256'])) {
        this.problems.push("binding.lockSha256 is the lockfile's SHA-256 (64 lowercase hex)");
      }
      return { repo: value['repo'], commit: value['commit'], lockSha256: value['lockSha256'] };
    }
    this.problems.push('binding is {repo, commit, lockSha256} or {image}');
    return { image: '' };
  }

  window(): RunWindow | null {
    const value = this.raw['window'];
    if (value === undefined || value === null) {
      return null;
    }
    const runAfter = isRecord(value) && typeof value['runAfter'] === 'string' ? Date.parse(value['runAfter']) : Number.NaN;
    const expiresBy = isRecord(value) && typeof value['expiresBy'] === 'string' ? Date.parse(value['expiresBy']) : Number.NaN;
    if (Number.isNaN(runAfter) || Number.isNaN(expiresBy) || runAfter >= expiresBy) {
      this.problems.push('window is null or {runAfter, expiresBy}, two instants with runAfter first');
      return null;
    }
    return { runAfter: new Date(runAfter).toISOString(), expiresBy: new Date(expiresBy).toISOString() };
  }
}

/** The problems with a draft's rules, each field already read (spec §5, §6). */
function ruleProblems(draft: RequestDraft, scanner: SecretScanner): string[] {
  const problems: string[] = [];
  if (draft.task !== '' && !TASK_ID.test(draft.task)) {
    problems.push('task is a register task id, T<n>');
  }
  if (draft.cwd !== '' && !isAbsolutePath(draft.cwd)) {
    problems.push('cwd is an absolute path');
  }
  const inline = draft.kind === 'pod-exec' ? undefined : inlineCodeOption(draft.argv);
  if (inline !== undefined) {
    problems.push(`argv passes inline code (${inline}): a ${draft.kind} runs a committed script (inline code is for reads and pod-exec diagnostics only)`);
  }
  if (draft.kind === 'db-write' && draft.dryRunArgv === null) {
    problems.push('a db-write needs dryRunArgv: code that writes data ships a read-only dry run');
  }
  if (draft.dryRunArgv === null && draft.preview === null) {
    problems.push('give dryRunArgv, or a preview (the read-only GET the change will alter) when the command has no dry-run form');
  }
  const texts: readonly (readonly [string, string | null])[] = [
    ['target', draft.target],
    ['cwd', draft.cwd],
    ['purpose', draft.purpose],
    ['expected', draft.expected],
    ['preview', draft.preview],
    ['rollback', draft.rollback],
    ...draft.argv.map((arg, index) => [`argv[${index}]`, arg] as const),
    ...(draft.dryRunArgv ?? []).map((arg, index) => [`dryRunArgv[${index}]`, arg] as const),
  ];
  for (const [subject, text] of texts) {
    const refusal = text === null ? undefined : scanner.refusal(subject, text);
    if (refusal !== undefined) {
      problems.push(`${refusal}: a credential reaches the run as a named variable (envNames)`);
    }
  }
  return problems;
}

/** A requester's file read and checked: the draft, or every problem found. */
export function parseDraft(raw: unknown, scanner: SecretScanner): DraftParse {
  if (!isRecord(raw)) {
    return { ok: false, problems: ['the request file is one JSON object'] };
  }
  const read = new DraftReader(raw);
  const kind = read.kind();
  const draft: RequestDraft = {
    kind,
    task: read.text('task'),
    target: read.text('target'),
    argv: read.argv('argv', true) ?? [],
    cwd: read.text('cwd'),
    binding: read.binding(kind),
    envNames: read.envNames('envNames'),
    readEnvNames: read.envNames('readEnvNames'),
    maxRuntimeSec: read.runtime(),
    rerunSafe: read.flag('rerunSafe'),
    purpose: read.text('purpose'),
    expected: read.text('expected'),
    dryRunArgv: read.argv('dryRunArgv', false),
    preview: read.optionalText('preview'),
    rollback: read.text('rollback'),
    window: read.window(),
    ownerGated: read.flag('ownerGated'),
  };
  const problems = [...read.problems, ...ruleProblems(draft, scanner)];
  return problems.length === 0 ? { ok: true, draft } : { ok: false, problems };
}

/** The SHA-256 of the command the executor starts: the resolved program, then argv's arguments. */
export function argvSha256(request: Pick<ExecRequest, 'program' | 'argv'>): string {
  return sha256Hex(canonicalJson([request.program, ...request.argv.slice(1)]));
}

/** The SHA-256 of the whole request: an approval binds it, so any field changed after review needs a new approval. */
export function requestSha256(request: ExecRequest): string {
  return sha256Hex(canonicalJson(request));
}
