import { readLines } from '../budget/cursor.ts';
import { discoverTranscripts, type TranscriptSource } from '../budget/discover.ts';
import { AGENT_TOOL, parseTranscriptLine, SKILL_TOOL } from '../budget/line.ts';
import { stringField } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { isAtOrBelow, pathKey } from '../core/paths.ts';

/** Each name in use, with the folders the sessions that used it started in (empty when no transcript said). */
export type UsedIn = ReadonlyMap<string, ReadonlySet<string>>;

/** The skills and agent types the transcripts show in use, where the sessions started, and how much was read. */
export interface TranscriptUse {
  /** Each skill a `Skill` call loaded or a `/<name>` command ran, by name as called (`plugin:name` for a plugin's). */
  readonly skills: UsedIn;
  /** Each agent type an `Agent` call ran. */
  readonly agents: UsedIn;
  /** Each folder a session read started in (a transcript's first `cwd`), and how many transcripts started there. */
  readonly folders: ReadonlyMap<string, number>;
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

/** What the transcripts of one project's sessions show in use. */
export interface ProjectUse {
  /** The transcripts read that started in the project's folder or below it. */
  readonly transcripts: number;
  readonly skills: ReadonlySet<string>;
  readonly agents: ReadonlySet<string>;
}

/** Which transcripts to read: those changed since `since`, newest first, until `maxBytes` are read. */
export interface UsageWindow {
  readonly since: number;
  /** No transcript is started once this many bytes are read, so the last one read may pass it. */
  readonly maxBytes: number;
  readonly chunkBytes?: number;
}

/** The bytes read at a time: a transcript runs to hundreds of MB, and is never held whole. */
export const USE_CHUNK_BYTES = 8 * 1024 * 1024;

interface DatedTranscript {
  readonly path: string;
  readonly changedAt: number;
}

/** What one transcript shows: its first `cwd`, and the skills and agent types it used. */
interface OneTranscript {
  cwd: string | undefined;
  readonly skills: Set<string>;
  readonly agents: Set<string>;
}

/** A cheap test before parsing: only a line naming the Skill or Agent tool or a slash command can show a use. */
function mayNameUse(line: string): boolean {
  return line.includes(`"${SKILL_TOOL}"`) || line.includes(`"${AGENT_TOOL}"`) || line.includes('<command-name>');
}

function addCwd(line: string, one: OneTranscript): void {
  if (one.cwd === undefined && line.includes('"cwd"')) {
    const entry = parseObject(line);
    one.cwd = entry === undefined ? undefined : stringField(entry, 'cwd');
  }
}

function addUses(line: string, one: OneTranscript): void {
  const parsed = parseTranscriptLine(line);
  if (parsed?.kind === 'call') {
    for (const tool of parsed.tools) {
      if (tool.skill !== undefined) {
        one.skills.add(tool.skill);
      }
      if (tool.agent !== undefined) {
        one.agents.add(tool.agent);
      }
    }
  } else if (parsed?.kind === 'prompt') {
    parsed.commands.forEach((command) => one.skills.add(command));
  }
}

async function readOne(source: TranscriptSource, path: string, one: OneTranscript, chunkBytes: number): Promise<number> {
  const size = (await source.size(path)) ?? 0;
  for (let offset = 0; offset < size; ) {
    const batch = await readLines(source, path, offset, size, chunkBytes);
    for (const line of batch.lines) {
      addCwd(line, one);
      if (mayNameUse(line)) {
        addUses(line, one);
      }
    }
    if (batch.end === offset) {
      break;
    }
    offset = batch.end;
  }
  return size;
}

function addUsedIn(usedIn: Map<string, Set<string>>, names: ReadonlySet<string>, cwd: string | undefined): void {
  for (const name of names) {
    const folders = usedIn.get(name) ?? new Set<string>();
    if (cwd !== undefined) {
      folders.add(cwd);
    }
    usedIn.set(name, folders);
  }
}

/** The transcripts (sessions' and their subagents') changed since `since`, newest first, ties by path. */
async function newestFirst(source: TranscriptSource, projectsDir: string, since: number): Promise<DatedTranscript[]> {
  const paths = (await discoverTranscripts(source, projectsDir, since)).flatMap((session) => [...session.main, ...session.subagents]);
  const dated = await Promise.all(paths.map(async (path) => ({ path, changedAt: (await source.changedAt(path)) ?? since })));
  return dated.sort((a, b) => b.changedAt - a.changedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The skills and agent types used in the transcripts (sessions' and their subagents') written since `window.since` in
 * any project on this machine, read newest first until `window.maxBytes`: a month of a busy machine's transcripts runs
 * to gigabytes. It reads each transcript `chunkBytes` at a time and parses only the lines that can name a use, and
 * the first one carrying a `cwd`, the folder the session started in: a project folder's name in `projectsDir` is a
 * lossy slug (`a/b-c` and `a-b/c` share one), so it cannot say where.
 */
export async function readTranscriptUse(source: TranscriptSource, projectsDir: string, window: UsageWindow): Promise<TranscriptUse> {
  const skills = new Map<string, Set<string>>();
  const agents = new Map<string, Set<string>>();
  const folders = new Map<string, number>();
  const dated = await newestFirst(source, projectsDir, window.since);
  let transcripts = 0;
  let bytes = 0;
  for (const { path } of dated) {
    if (bytes >= window.maxBytes) {
      break;
    }
    const one: OneTranscript = { cwd: undefined, skills: new Set(), agents: new Set() };
    bytes += await readOne(source, path, one, window.chunkBytes ?? USE_CHUNK_BYTES);
    transcripts += 1;
    addUsedIn(skills, one.skills, one.cwd);
    addUsedIn(agents, one.agents, one.cwd);
    if (one.cwd !== undefined) {
      folders.set(one.cwd, (folders.get(one.cwd) ?? 0) + 1);
    }
  }
  const unread = dated.length - transcripts;
  const oldestRead = dated[transcripts - 1];
  const since = unread === 0 || oldestRead === undefined ? window.since : oldestRead.changedAt;
  return { skills, agents, folders, transcripts, bytes, unread, since };
}

function usedBelow(usedIn: UsedIn, project: string, platform: NodeJS.Platform): Set<string> {
  const names = [...usedIn].filter(([, folders]) => [...folders].some((folder) => isAtOrBelow(folder, project, platform)));
  return new Set(names.map(([name]) => name));
}

/** The folders none of the others holds, one spelling of each (the last), sorted: where a name was used, without the subfolders. */
export function outermostFolders(folders: Iterable<string>, platform: NodeJS.Platform = process.platform): string[] {
  const unique = [...new Map([...folders].map((folder) => [pathKey(folder, platform), folder])).values()].sort();
  return unique.filter((folder) => !unique.some((other) => other !== folder && isAtOrBelow(folder, other, platform)));
}

/** What the sessions started in `project` or a folder below it used, out of what the transcripts read show. */
export function projectUse(use: TranscriptUse, project: string, platform: NodeJS.Platform = process.platform): ProjectUse {
  const transcripts = [...use.folders].reduce((sum, [folder, count]) => sum + (isAtOrBelow(folder, project, platform) ? count : 0), 0);
  return { transcripts, skills: usedBelow(use.skills, project, platform), agents: usedBelow(use.agents, project, platform) };
}
