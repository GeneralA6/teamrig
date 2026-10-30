import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { nodeTreeKill, type TreeKill } from '../delivery/tree-kill.ts';
import type { Files } from '../core/files.ts';
import type { Env } from '../core/home.ts';
import { envVariable } from '../core/path-search.ts';
import type { SecretScanner } from '../core/secrets.ts';
import type { AuditLog, RequestRecord, RunOutcome } from './audit.ts';
import { bindingProblems, stageCommand, type BindingDeps, type ExecStage } from './binding.ts';
import { sha256Hex } from './digest.ts';
import { redact, tailOf, type InjectedValue } from './redact.ts';
import { signatureValid, type ReviewVerifier } from './review.ts';

/** A process's output kept in memory, at most this many bytes; a command that prints more is cut, and says so. */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** What the executor starts: a program with its arguments, never a shell line. */
export interface SpawnAsk {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * The environment the process gets. None of the executor's own is inherited, except that on Windows Node's process
   * start (libuv) copies the user and folder names it lacks: HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE, USERDOMAIN,
   * USERNAME, USERPROFILE and WINDIR, none of them a secret. On every platform Node's spawn also passes on the
   * executor's NODE_V8_COVERAGE, a coverage folder set only when the executor itself runs under coverage.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** How a started process ended. */
export interface SpawnEnd {
  /** Null when it ended without one: killed at its time limit, or by a signal. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Its stdout and stderr, in the order they came. */
  readonly output: string;
}

/** Starts one process and waits for it; rejects when it cannot start at all. */
export interface ExecSpawner {
  run(ask: SpawnAsk): Promise<SpawnEnd>;
}

/** Where the values of the variables a request names come from. Phase 1: the executor's own environment. */
export interface CredentialSource {
  get(name: string): string | undefined;
}

/** Output chunks up to a byte limit; past it the rest is dropped and the text ends with a note saying so. */
class OutputBuffer {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private cut = false;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  add(chunk: Buffer): void {
    const room = this.max - this.bytes;
    if (chunk.length > room) {
      this.cut = true;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(kept);
    this.bytes += kept.length;
  }

  text(): string {
    const text = Buffer.concat(this.chunks).toString('utf8');
    return this.cut ? `${text}\n[output cut at ${this.max} bytes]` : text;
  }
}

/**
 * The real spawner: Node's `spawn` with no shell and no window, stdout and stderr captured; at its time limit the whole
 * process tree is killed, and the end is reported once the kill is done.
 */
export function nodeExecSpawner(platform: NodeJS.Platform, kill: TreeKill = nodeTreeKill(platform), maxOutputBytes: number = MAX_OUTPUT_BYTES): ExecSpawner {
  return {
    run: (ask) =>
      new Promise((resolve, reject) => {
        const child = spawn(ask.program, [...ask.args], {
          shell: false,
          cwd: ask.cwd,
          env: { ...ask.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: platform !== 'win32',
        });
        const output = new OutputBuffer(maxOutputBytes);
        child.stdout.on('data', (chunk: Buffer) => output.add(chunk));
        child.stderr.on('data', (chunk: Buffer) => output.add(chunk));
        let killed: Promise<void> | undefined;
        const timer = setTimeout(() => {
          killed = child.pid === undefined ? Promise.resolve() : kill(child.pid);
        }, ask.timeoutMs);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          void (killed ?? Promise.resolve()).then(() => resolve({ exitCode: killed === undefined ? code : null, timedOut: killed !== undefined, output: output.text() }));
        });
      }),
  };
}

/** The variables besides PATH a process needs to start on each platform: Windows needs its system folder and temp folders. */
const BASE_VARIABLES: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = { win32: ['SystemRoot', 'TEMP', 'TMP'] };

/** The fixed environment every run starts from: the exec PATH and the platform's base variables, read from the executor's own. */
export function baseEnvironment(execPath: string, env: Env, platform: NodeJS.Platform): Readonly<Record<string, string>> {
  const base = (BASE_VARIABLES[platform] ?? []).flatMap((name) => {
    const value = envVariable(env, name.toUpperCase(), platform);
    return value === undefined ? [] : [[name, value] as const];
  });
  return { ...Object.fromEntries(base), PATH: execPath };
}

/** The phase-1 credential source: the executor's own environment (Windows names ignore case). */
export function environmentCredentials(env: Env, platform: NodeJS.Platform): CredentialSource {
  return { get: (name) => (platform === 'win32' ? envVariable(env, name.toUpperCase(), platform) : env[name]) };
}

/** What an executor needs: the log, the binding check, a spawner, the credentials and where outputs go. */
export interface ExecutorDeps {
  readonly audit: AuditLog;
  readonly binding: BindingDeps;
  readonly spawner: ExecSpawner;
  readonly credentials: CredentialSource;
  readonly verifier: ReviewVerifier;
  readonly scanner: SecretScanner;
  readonly files: Files;
  /** The folder the output files go in: the team's exec/out. */
  readonly outDir: string;
  /** The environment every run starts from (baseEnvironment); a named variable never replaces one of these. */
  readonly baseEnv: Readonly<Record<string, string>>;
}

/** A dry run's or a run's end: what the log recorded, or why nothing started (or, after a start, why the end was not recorded). */
export type ExecResult = { readonly ok: true; readonly outcome: RunOutcome } | { readonly ok: false; readonly refusal: string };

function refused(refusal: string): ExecResult {
  return { ok: false, refusal };
}

/** Why `record` may not have its dry run now; undefined when it may. */
function dryRunRefusal(id: string, record: RequestRecord): string | undefined {
  if (record.request.dryRunArgv === null) return `${id} has no dry run: its reviewer reads the preview`;
  if (record.dryRun !== undefined) return `${id} already has its dry run`;
  if (record.review !== undefined || record.escalation !== undefined) return `${id} is already reviewed`;
  return undefined;
}

/** The nonce `record`'s approval gives its run; or why it may not run, checked before the start is logged. Expiry and window are the log's checks. */
function approvedNonce(id: string, record: RequestRecord, verifier: ReviewVerifier): { readonly nonce: string } | string {
  const { review } = record;
  if (review === undefined) return `${id} is not approved${record.escalation === undefined ? '' : ': it waits for the owner'}`;
  if (review.decision !== 'approved') return `${id} was refused by ${review.reviewer}: ${review.note}`;
  if (review.nonce === null) return `${id}'s approval has no nonce`;
  if (!signatureValid(review, verifier)) return `${id}'s approval signature is not valid for what it binds`;
  if (record.runStart !== undefined) return `${id} already ran: an approval is used once`;
  return { nonce: review.nonce };
}

/**
 * Runs approved privileged commands (spec §6, §8): a request's read-only dry run before review, and its approved
 * run once. Every start is preceded by the binding check and the credential check, so nothing starts that the
 * reviewer did not see; the run's start is logged under the log's lock before the process starts, which burns the
 * approval's nonce, so a second run of one approval is refused. Each output is redacted, written whole to a file,
 * and logged with its SHA-256 and a bounded tail.
 */
export class Executor {
  private readonly deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  /** Runs `id`'s dry run with its read-only variables, and logs its outcome for the reviewer. */
  async dryRun(id: string): Promise<ExecResult> {
    const record = await this.record(id);
    if (typeof record === 'string') return refused(record);
    const refusal = dryRunRefusal(id, record);
    if (refusal !== undefined) return refused(refusal);
    const { request } = record;
    const prepared = await this.prepare(record, 'dry-run', request.readEnvNames);
    if (typeof prepared === 'string') return refused(prepared);
    const outcome = await this.execute(id, 'dry', prepared);
    const logged = await this.deps.audit.append(() => ({ type: 'dry-run', id, outcome }));
    return logged.ok ? { ok: true, outcome } : refused(logged.refusal);
  }

  /** Runs `id` as approved: logs the start (burning the nonce), runs it, and logs the end, also when it could not start. */
  async run(id: string): Promise<ExecResult> {
    const record = await this.record(id);
    if (typeof record === 'string') return refused(record);
    const approved = approvedNonce(id, record, this.deps.verifier);
    if (typeof approved === 'string') return refused(approved);
    const prepared = await this.prepare(record, 'run', record.request.envNames);
    if (typeof prepared === 'string') return refused(prepared);
    const { nonce } = approved;
    const started = await this.deps.audit.append((state) => {
      const now = state.records.get(id);
      if (now?.runStart !== undefined) return { refusal: `${id} already ran: an approval is used once` };
      return { type: 'run-start', id, nonce };
    });
    if (!started.ok) return refused(started.refusal);
    const outcome = await this.execute(id, 'run', prepared);
    const ended = await this.deps.audit.append(() => ({ type: 'run-end', id, outcome }));
    return ended.ok ? { ok: true, outcome } : refused(`${id} ran (exit ${outcome.exitCode ?? 'none'}) but its end was not logged: ${ended.refusal}`);
  }

  private async record(id: string): Promise<RequestRecord | string> {
    const read = await this.deps.audit.read();
    if (!read.ok) return `the exec audit log is broken at line ${read.line}: ${read.reason}`;
    return read.state.records.get(id) ?? `no request ${id}`;
  }

  /** The process to start and the values to redact from its output; or why it must not start. */
  private async prepare(record: RequestRecord, stage: ExecStage, names: readonly string[]): Promise<Prepared | string> {
    const { request } = record;
    const command = stageCommand(request, stage);
    if (command === undefined) return `${request.id} has no dry run`;
    const problems = await bindingProblems(request, stage, this.deps.binding);
    if (problems.length > 0) return `${request.id} does not match its binding: ${problems.join('; ')}`;
    const values = names.map((name) => ({ name, value: this.deps.credentials.get(name) }));
    const missing = values.filter(({ value }) => value === undefined).map(({ name }) => name);
    if (missing.length > 0) return `${request.id} needs ${missing.join(', ')}, which the executor does not have`;
    const injected = values.flatMap(({ name, value }) => (value === undefined ? [] : [{ name, value }]));
    const env = { ...Object.fromEntries(injected.map(({ name, value }) => [name, value])), ...this.deps.baseEnv };
    return { ask: { program: command.program, args: command.argv.slice(1), cwd: request.cwd, env, timeoutMs: request.maxRuntimeSec * 1000 }, injected };
  }

  /** Starts the process, keeps its redacted output in a file, and returns the outcome to log; a failed start is an outcome too. */
  private async execute(id: string, suffix: 'dry' | 'run', { ask, injected }: Prepared): Promise<RunOutcome> {
    const end = await this.deps.spawner.run(ask).catch((error: unknown): SpawnEnd => ({
      exitCode: null,
      timedOut: false,
      output: `the executor could not start ${ask.program}: ${error instanceof Error ? error.message : String(error)}`,
    }));
    const kept = redact(end.output, injected, this.deps.scanner);
    const outputFile = join(this.deps.outDir, `${id}-${suffix}.log`);
    await this.deps.files.write(outputFile, kept);
    return { exitCode: end.exitCode, timedOut: end.timedOut, outputSha256: sha256Hex(kept), outputFile, tail: tailOf(kept) };
  }
}

interface Prepared {
  readonly ask: SpawnAsk;
  readonly injected: readonly InjectedValue[];
}
