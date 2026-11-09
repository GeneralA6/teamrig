import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { isRecord } from '../core/guards.ts';

/**
 * The file kinds a hand step for the human comes as (T2312, core rule 11), each with its own run line: a PowerShell
 * script, a bash script, or a steps file the human follows by hand (provider-console clicks). Any other kind is
 * refused, so a team off Windows is served and nothing runs through a program the line does not name.
 */
export const HAND_STEP_KINDS = ['.ps1', '.sh', '.md'] as const;

export type HandStepKind = (typeof HAND_STEP_KINDS)[number];

/** The kind of the hand step file at `path`, by its extension in any case; undefined for any other file. */
export function handStepKindOf(path: string): HandStepKind | undefined {
  const extension = extname(path).toLowerCase();
  return HAND_STEP_KINDS.find((kind) => kind === extension);
}

/** Why the file at `path` is no hand step file, or undefined when it is one: only a kind with a run line is. */
export function handStepFileProblem(path: string): string | undefined {
  return handStepKindOf(path) === undefined ? `${path} is not a hand step file: only ${HAND_STEP_KINDS.join(', ')} files have a run line` : undefined;
}

/** How the human runs a hand step file of each kind, quoted so a path with spaces or quotes runs as one. */
const RUN_LINES: Readonly<Record<HandStepKind, (path: string) => string>> = {
  // A single-quoted PowerShell string takes a quote as two, and expands nothing.
  '.ps1': (path) => `& '${path.replaceAll("'", "''")}'`,
  // A single-quoted bash string cannot hold a quote: close it, put an escaped one, open it again.
  '.sh': (path) => `bash '${path.replaceAll("'", "'\\''")}'`,
  '.md': (path) => `follow the steps in ${path}`,
};

/** The line the human runs the hand step file at `path` by, after its kind; undefined for a file of no hand step kind. */
export function runLineOf(path: string): string | undefined {
  const kind = handStepKindOf(path);
  return kind === undefined ? undefined : RUN_LINES[kind](path);
}

/** What an audit pins: a hand step file by its absolute path, at the sha256 of its bytes (lowercase hex). */
export interface AuditPin {
  readonly path: string;
  readonly sha256: string;
}

/** An audit as its task keeps it: the pin, the session that audited the file, and when. */
export interface HandStepAudit extends AuditPin {
  readonly by: string;
  readonly at: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The sha256 of `bytes`, in lowercase hex, as an audit pins it. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** How many characters of a pin's sha256 the lines about it show: enough to tell two audits of a file apart. */
const SHORT_SHA256 = 8;

/** A pin's sha256 as the lines about it show it, its first SHORT_SHA256 characters. */
export function shortSha256(sha256: string): string {
  return sha256.slice(0, SHORT_SHA256);
}

/** The pin an update line gives, or why it is not one. */
export function parseAuditPin(value: unknown): AuditPin | string {
  if (!isRecord(value)) {
    return 'audit is not an object';
  }
  const { path, sha256 } = value;
  if (typeof path !== 'string' || path.trim() === '' || /[\r\n]/.test(path) || typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    return `bad audit ${JSON.stringify(value)}`;
  }
  return { path, sha256 };
}

/** The audit a task keeps of the file at `path`, the latest one; undefined when none pins it. */
export function auditOf(audits: readonly HandStepAudit[], path: string): HandStepAudit | undefined {
  return audits.find((audit) => audit.path === path);
}

/** A task's audits after `audit`: one per path, the latest audit of a path replacing the one before, in the order first audited. */
export function withAudit(audits: readonly HandStepAudit[], audit: HandStepAudit): readonly HandStepAudit[] {
  return audits.some((kept) => kept.path === audit.path) ? audits.map((kept) => (kept.path === audit.path ? audit : kept)) : [...audits, audit];
}
