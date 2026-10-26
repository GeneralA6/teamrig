import { readLines } from '../budget/cursor.ts';
import { discoverTranscripts, type TranscriptSource } from '../budget/discover.ts';
import { parseTranscriptLine, SKILL_TOOL } from '../budget/line.ts';

/** The skills the transcripts show in use, and how much was read to find them. */
export interface SkillUse {
  /** Each skill a `Skill` call loaded or a `/<name>` command ran, by name as called (`plugin:name` for a plugin's). */
  readonly used: ReadonlySet<string>;
  readonly transcripts: number;
  readonly bytes: number;
  /** The older transcripts of the window left unread once the bound was reached. */
  readonly unread: number;
  /**
   * Where the read window starts (epoch ms): the asked `since`, or when transcripts were left unread, when the oldest
   * one read last changed; every transcript changed after it was read.
   */
  readonly since: number;
}

/** Which transcripts to read: those changed since `since`, newest first, until `maxBytes` are read. */
export interface UsageWindow {
  readonly since: number;
  /** No transcript is started once this many bytes are read, so the last one read may pass it. */
  readonly maxBytes: number;
  readonly chunkBytes?: number;
}

/** The bytes read at a time: a transcript runs to hundreds of MB, and is never held whole. */
export const SKILL_USE_CHUNK_BYTES = 8 * 1024 * 1024;

interface DatedTranscript {
  readonly path: string;
  readonly changedAt: number;
}

/** A cheap test before parsing: only a line naming the Skill tool or a slash command can show a skill in use. */
function mayNameSkill(line: string): boolean {
  return line.includes(`"${SKILL_TOOL}"`) || line.includes('<command-name>');
}

function addUses(line: string, used: Set<string>): void {
  const parsed = parseTranscriptLine(line);
  if (parsed?.kind === 'call') {
    for (const tool of parsed.tools) {
      if (tool.skill !== undefined) {
        used.add(tool.skill);
      }
    }
  } else if (parsed?.kind === 'prompt') {
    parsed.commands.forEach((command) => used.add(command));
  }
}

async function readUses(source: TranscriptSource, path: string, used: Set<string>, chunkBytes: number): Promise<number> {
  const size = (await source.size(path)) ?? 0;
  for (let offset = 0; offset < size; ) {
    const batch = await readLines(source, path, offset, size, chunkBytes);
    batch.lines.filter(mayNameSkill).forEach((line) => addUses(line, used));
    if (batch.end === offset) {
      break;
    }
    offset = batch.end;
  }
  return size;
}

/** The transcripts (sessions' and their subagents') changed since `since`, newest first, ties by path. */
async function newestFirst(source: TranscriptSource, projectsDir: string, since: number): Promise<DatedTranscript[]> {
  const paths = (await discoverTranscripts(source, projectsDir, since)).flatMap((session) => [...session.main, ...session.subagents]);
  const dated = await Promise.all(paths.map(async (path) => ({ path, changedAt: (await source.changedAt(path)) ?? since })));
  return dated.sort((a, b) => b.changedAt - a.changedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The skills used in the transcripts (sessions' and their subagents') written since `window.since` in any project on
 * this machine, read newest first until `window.maxBytes`: a month of a busy machine's transcripts runs to gigabytes.
 * It reads each transcript `chunkBytes` at a time and parses only the lines that can name a skill.
 */
export async function readSkillUse(source: TranscriptSource, projectsDir: string, window: UsageWindow): Promise<SkillUse> {
  const used = new Set<string>();
  const dated = await newestFirst(source, projectsDir, window.since);
  let transcripts = 0;
  let bytes = 0;
  for (const { path } of dated) {
    if (bytes >= window.maxBytes) {
      break;
    }
    bytes += await readUses(source, path, used, window.chunkBytes ?? SKILL_USE_CHUNK_BYTES);
    transcripts += 1;
  }
  const unread = dated.length - transcripts;
  const oldestRead = dated[transcripts - 1];
  return { used, transcripts, bytes, unread, since: unread === 0 || oldestRead === undefined ? window.since : oldestRead.changedAt };
}
