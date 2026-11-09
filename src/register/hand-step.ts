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

/** The PowerShell cmdlets that write, move or remove a file, an item or a setting: a hand step when a card holds one. */
const WRITE_CMDLETS = ['Set-Content', 'Add-Content', 'Clear-Content', 'Out-File', 'New-Item', 'Set-Item', 'Copy-Item', 'Move-Item', 'Rename-Item', 'Remove-Item', 'New-ItemProperty', 'Set-ItemProperty', 'Remove-ItemProperty'];

/**
 * The shapes a hand step takes when it is typed into text for the human instead of handed as an audited file (T2312,
 * core rule 11), each named in words: code (a backticked span, PowerShell's call operator, a write cmdlet, a JSON
 * object) or an ask to paste. The ask counts as much as the code: the card of the incident behind the rule held no
 * code, only "one paste adds the exact file ... to secretGuard.paths". `pasted` names a past paste, so it passes.
 */
const HAND_STEP_SHAPES: readonly (readonly [string, RegExp])[] = [
  ['a backticked span', /`[^`]+`/],
  ["PowerShell's call operator (& ')", /&\s*['"]/],
  ['a PowerShell write cmdlet', new RegExp(`\\b(?:${WRITE_CMDLETS.join('|')})\\b`, 'i')],
  ['a JSON object', /\{\s*"[^"]*"\s*:/],
  ['an ask to paste', /\bpast(?:e|es|ing)\b/i],
];

/** The hand step shape `text` holds, in words, the first that HAND_STEP_SHAPES lists; undefined when it holds none. */
export function handStepShapeOf(text: string): string | undefined {
  return HAND_STEP_SHAPES.find(([, shape]) => shape.test(text))?.[0];
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

/**
 * The sha256 each card's hand step file has now, by its path, as the CLI read it just before the card prints
 * (T2312): null for a file gone. `set --run` matched the file only when the card was written, so every print matches
 * it again; a path the map lacks reads as one gone, so a caller that read no file never hands the owner a run line.
 */
export type RunFiles = ReadonlyMap<string, string | null>;

/**
 * How the hand step file an audit pins drifted from it (`CHANGED since its audit (sha256 <8> by <who>, now <8>)` or
 * `MISSING since its audit (...)`), by the sha256 it has now in `runFiles`; undefined while it still has the pinned one.
 */
export function runFileDrift(audit: HandStepAudit, runFiles: RunFiles): string | undefined {
  const now = runFiles.get(audit.path);
  if (now === audit.sha256) {
    return undefined;
  }
  const pinned = `sha256 ${shortSha256(audit.sha256)} by ${audit.by}`;
  return typeof now === 'string' ? `CHANGED since its audit (${pinned}, now ${shortSha256(now)})` : `MISSING since its audit (${pinned})`;
}
