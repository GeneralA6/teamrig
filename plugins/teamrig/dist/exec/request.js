import { posix, win32 } from 'node:path';
import { isRecord, isStringArray } from "../core/guards.js";
import { MS_PER_HOUR } from "../core/time.js";
import { canonicalJson, sha256Hex } from "./digest.js";
/** What a privileged command changes (security spec T754 §3); every kind needs a request and an approval. */
export const EXEC_KINDS = ['db-write', 'route', 'pod-exec', 'cluster-write', 'external-write'];
/** The longest a run may take before the executor kills it, and the longest an approval window may last. */
export const MAX_RUNTIME_SEC = (4 * MS_PER_HOUR) / 1000;
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
function isAbsolutePath(path) {
    return win32.isAbsolute(path) || posix.isAbsolute(path);
}
/** The first argument that hands an interpreter inline code, as typed; undefined when there is none. */
export function inlineCodeOption(argv) {
    return argv.slice(1).find((arg) => INLINE_CODE_OPTIONS.has((arg.split('=')[0] ?? arg).toLowerCase()));
}
/** How argv[0] is looked up: a name with a folder in it but no root would depend on the cwd, so it is refused. */
export function programLookup(program) {
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
    problems = [];
    raw;
    constructor(raw) {
        this.raw = raw;
    }
    text(key) {
        const value = this.raw[key];
        if (typeof value === 'string' && value.trim() !== '') {
            return value;
        }
        this.problems.push(`${key} is required, as non-empty text`);
        return '';
    }
    optionalText(key) {
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
    flag(key) {
        const value = this.raw[key];
        if (typeof value === 'boolean') {
            return value;
        }
        this.problems.push(`${key} is required, as true or false`);
        return false;
    }
    argv(key, required) {
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
    envNames(key) {
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
    kind() {
        const value = this.raw['kind'];
        const kind = EXEC_KINDS.find((candidate) => candidate === value);
        if (kind === undefined) {
            this.problems.push(`kind is one of ${EXEC_KINDS.join(', ')}`);
            return 'db-write';
        }
        return kind;
    }
    runtime() {
        const value = this.raw['maxRuntimeSec'];
        if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_RUNTIME_SEC) {
            return value;
        }
        this.problems.push(`maxRuntimeSec is a whole number of seconds, 1 to ${MAX_RUNTIME_SEC}`);
        return 1;
    }
    /** A pod exec runs no code of ours, so it binds the target's image; every other kind runs a committed script. */
    binding(kind) {
        const value = this.raw['binding'];
        const podExec = kind === 'pod-exec';
        if (isRecord(value) && typeof value['image'] === 'string') {
            if (!podExec) {
                this.problems.push(`binding is {repo, commit, lockSha256}: a ${kind} runs code bound by commit`);
            }
            else if (!IMAGE_DIGEST.test(value['image'])) {
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
    window() {
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
function ruleProblems(draft, scanner) {
    const problems = [];
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
    const texts = [
        ['target', draft.target],
        ['cwd', draft.cwd],
        ['purpose', draft.purpose],
        ['expected', draft.expected],
        ['preview', draft.preview],
        ['rollback', draft.rollback],
        ...draft.argv.map((arg, index) => [`argv[${index}]`, arg]),
        ...(draft.dryRunArgv ?? []).map((arg, index) => [`dryRunArgv[${index}]`, arg]),
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
export function parseDraft(raw, scanner) {
    if (!isRecord(raw)) {
        return { ok: false, problems: ['the request file is one JSON object'] };
    }
    const read = new DraftReader(raw);
    const draft = readDraft(read);
    const problems = [...read.problems, ...ruleProblems(draft, scanner)];
    return problems.length === 0 ? { ok: true, draft } : { ok: false, problems };
}
/** Every draft field, read in order; problems collect on `read`. */
function readDraft(read) {
    const kind = read.kind();
    return {
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
}
/**
 * A request read back from the audit log: its shape only, not today's rules or secret shapes, which may have changed
 * since it was accepted (the hash chain proves the line unaltered). Undefined for a malformed record.
 */
export function readStoredRequest(raw) {
    if (!isRecord(raw)) {
        return undefined;
    }
    const read = new DraftReader(raw);
    const draft = readDraft(read);
    const id = read.text('id');
    const requester = read.text('requester');
    const createdAt = read.text('createdAt');
    const program = read.text('program');
    const dryRunProgram = read.optionalText('dryRunProgram');
    return read.problems.length === 0 ? { ...draft, id, requester, createdAt, program, dryRunProgram } : undefined;
}
/** The SHA-256 of the command the executor starts: the resolved program, then argv's arguments. */
export function argvSha256(request) {
    return sha256Hex(canonicalJson([request.program, ...request.argv.slice(1)]));
}
/** The SHA-256 of the whole request: an approval binds it, so any field changed after review needs a new approval. */
export function requestSha256(request) {
    return sha256Hex(canonicalJson(request));
}
