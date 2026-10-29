import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import type { PromptSecrets } from './prompt-secrets.ts';

/** Where Claude Code keeps the prompts it was sent: the history log and the large pastes it names by hash. */
export interface HistoryPlaces {
  /** One JSON line per prompt: `{display, pastedContents, timestamp, project, sessionId}`. */
  readonly history: string;
  /** A large paste's text, as `<contentHash>.txt`, which a history line names instead of holding it. */
  readonly pasteCache: string;
}

/** What one clean removed: counts and the wanted hashes found, never a value. */
export interface HistoryClean {
  readonly lines: number;
  readonly pastes: number;
  /** The wanted hashes whose secret was in a removed line or paste. */
  readonly hits: ReadonlySet<string>;
  /** False when the history changed under every attempt, so its lines were left as they were. */
  readonly settled: boolean;
}

/** Plans over a history that keeps changing between the read and the write before the clean gives up on it. */
const ATTEMPTS = 3;
const PASTE_SUFFIX = '.txt';

/** The history places in Claude Code's folder (`claudeConfigDir`). */
export function historyPlaces(claudeDir: string): HistoryPlaces {
  return { history: join(claudeDir, 'history.jsonl'), pasteCache: join(claudeDir, 'paste-cache') };
}

/**
 * Removes every trace of the secrets `hashes` name from Claude Code's prompt history (T1481): each paste-cache file
 * holding one, then each history line holding one or naming a removed paste. Every other line is kept byte for byte:
 * Claude Code writes the history as UTF-8 JSON, so `Files.read` gives back exactly what is on disk. The history is
 * read again before the write; when it changed (Claude Code appended a prompt), the plan is made again over the new
 * text, so no line written meanwhile is lost.
 */
export async function cleanHistory(files: Files, places: HistoryPlaces, secrets: PromptSecrets, hashes: ReadonlySet<string>): Promise<HistoryClean> {
  const hits = new Set<string>();
  const removedPastes = new Set<string>();
  for (const name of await files.list(places.pasteCache)) {
    if (!name.endsWith(PASTE_SUFFIX)) {
      continue;
    }
    const path = join(places.pasteCache, name);
    const found = secrets.hashesIn((await files.read(path)) ?? '', hashes);
    if (found.length > 0) {
      await files.remove(path);
      removedPastes.add(name.slice(0, -PASTE_SUFFIX.length));
      found.forEach((hash) => hits.add(hash));
    }
  }

  let text = await files.read(places.history);
  for (let attempt = 0; attempt < ATTEMPTS && text !== undefined; attempt += 1) {
    const plan = planClean(text, secrets, hashes, removedPastes);
    if (plan.removed === 0) {
      return { lines: 0, pastes: removedPastes.size, hits, settled: true };
    }
    const current = await files.read(places.history);
    if (current === text) {
      await files.write(places.history, plan.kept);
      plan.hits.forEach((hash) => hits.add(hash));
      return { lines: plan.removed, pastes: removedPastes.size, hits, settled: true };
    }
    text = current;
  }
  return { lines: 0, pastes: removedPastes.size, hits, settled: text === undefined };
}

interface CleanPlan {
  readonly kept: string;
  readonly removed: number;
  readonly hits: ReadonlySet<string>;
}

function planClean(text: string, secrets: PromptSecrets, hashes: ReadonlySet<string>, removedPastes: ReadonlySet<string>): CleanPlan {
  // Each line keeps its own ending, so the kept lines join back into the file byte for byte.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const hits = new Set<string>();
  let kept = '';
  let removed = 0;
  for (const line of lines) {
    // A line that is not a JSON object is not Claude Code's: it is kept as it is.
    const record = parseObject(line);
    const verdict = record === undefined ? KEEP : judgeLine(record, secrets, hashes, removedPastes);
    if (verdict.drop) {
      removed += 1;
      verdict.hits.forEach((hash) => hits.add(hash));
    } else {
      kept += line;
    }
  }
  return { kept, removed, hits };
}

interface LineVerdict {
  readonly drop: boolean;
  /** The wanted hashes the line holds. */
  readonly hits: readonly string[];
}

const KEEP: LineVerdict = { drop: false, hits: [] };

/** A history line goes when its prompt or one of its pastes holds a wanted secret, or it names a removed paste. */
function judgeLine(record: JsonRecord, secrets: PromptSecrets, hashes: ReadonlySet<string>, removedPastes: ReadonlySet<string>): LineVerdict {
  const hits = secrets.hashesIn(stringField(record, 'display') ?? '', hashes);
  let namesRemovedPaste = false;
  for (const paste of Object.values(recordField(record, 'pastedContents') ?? {})) {
    if (!isRecord(paste)) {
      continue;
    }
    hits.push(...secrets.hashesIn(stringField(paste, 'content') ?? '', hashes));
    const contentHash = stringField(paste, 'contentHash');
    namesRemovedPaste ||= contentHash !== undefined && removedPastes.has(contentHash);
  }
  return { drop: hits.length > 0 || namesRemovedPaste, hits };
}
