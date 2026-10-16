import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode } from '../core/guards.ts';
import { claudeConfigDir, type Env } from '../core/home.ts';
import { CLAUDE_SESSION_ID } from '../inbox/marks.ts';
import { nodeTranscriptBytes, type TranscriptBytes } from './cursor.ts';

/** One entry of a folder: its name, whether it is a folder, and when it last changed (epoch ms). */
export interface FolderEntry {
  readonly name: string;
  readonly folder: boolean;
  readonly changedAt: number;
}

/** Listing the folders Claude Code keeps transcripts in. */
export interface TranscriptFolders {
  /** The entries of a folder; empty when it does not exist. */
  entries(dir: string): Promise<readonly FolderEntry[]>;
  /** When a file last changed (epoch ms); undefined when it does not exist or is a folder. */
  changedAt(path: string): Promise<number | undefined>;
}

/** Everything `teamrig budget` reads of Claude Code's transcripts: their folders and their bytes. */
export interface TranscriptSource extends TranscriptBytes, TranscriptFolders {}

/** The real filesystem. An entry removed while it is listed is left out. */
export const nodeTranscriptFolders: TranscriptFolders = {
  async entries(dir) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
        return [];
      }
      throw error;
    }
    const entries: FolderEntry[] = [];
    for (const name of names) {
      try {
        const stats = await stat(join(dir, name));
        entries.push({ name, folder: stats.isDirectory(), changedAt: stats.mtimeMs });
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          throw error;
        }
      }
    }
    return entries;
  },
  async changedAt(path) {
    try {
      const stats = await stat(path);
      return stats.isFile() ? stats.mtimeMs : undefined;
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
        return undefined;
      }
      throw error;
    }
  },
};

export const nodeTranscriptSource: TranscriptSource = { ...nodeTranscriptBytes, ...nodeTranscriptFolders };

/** Claude Code's folder name for a project: its path with every character but a letter or digit made `-`. */
export function claudeProjectSlug(project: string): string {
  return project.replace(/[^A-Za-z0-9]/g, '-');
}

/** Claude Code's folder of project transcripts: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function claudeProjectsDir(env: Env, userHome: string): string {
  return join(claudeConfigDir(env, userHome), 'projects');
}

/** Transcripts by kind: Claude Code sessions' own, and their subagents'. */
export interface TranscriptSet {
  /** The sessions' own transcripts, one per project folder each ran in. */
  readonly main: readonly string[];
  readonly subagents: readonly string[];
}

/** The transcripts of one Claude Code session: its own (none when only its subagents wrote), then its subagents'. */
export interface ClaudeSessionFiles extends TranscriptSet {
  readonly claudeSession: string;
}

interface FoundFiles {
  readonly main: string[];
  readonly subagents: string[];
}

const TRANSCRIPT = '.jsonl';
const SUBAGENTS = 'subagents';

function jsonlChangedSince(entry: FolderEntry, since: number): boolean {
  return !entry.folder && entry.name.endsWith(TRANSCRIPT) && entry.changedAt >= since;
}

/**
 * Every Claude Code session with a transcript written since `since`: `<projects>/<project>/<session>.jsonl`,
 * and its subagents' `<projects>/<project>/<session>/subagents/*.jsonl`, which count as the session's.
 * Sorted by session id, so a run reads them in the same order every time.
 */
export async function discoverTranscripts(folders: TranscriptFolders, projectsDir: string, since: number): Promise<ClaudeSessionFiles[]> {
  const found = new Map<string, FoundFiles>();
  const sessionOf = (id: string): FoundFiles => {
    const existing = found.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const created: FoundFiles = { main: [], subagents: [] };
    found.set(id, created);
    return created;
  };
  for (const project of await folders.entries(projectsDir)) {
    if (!project.folder) {
      continue;
    }
    const projectDir = join(projectsDir, project.name);
    for (const entry of await folders.entries(projectDir)) {
      const id = entry.folder ? entry.name : entry.name.slice(0, -TRANSCRIPT.length);
      if (!CLAUDE_SESSION_ID.test(id)) {
        continue;
      }
      if (!entry.folder) {
        if (jsonlChangedSince(entry, since)) {
          sessionOf(id).main.push(join(projectDir, entry.name));
        }
        continue;
      }
      const subagentDir = join(projectDir, entry.name, SUBAGENTS);
      const written = (await folders.entries(subagentDir)).filter((sub) => jsonlChangedSince(sub, since));
      if (written.length > 0) {
        sessionOf(id).subagents.push(...written.map((sub) => join(subagentDir, sub.name)).sort());
      }
    }
  }
  return [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([claudeSession, files]) => ({ claudeSession, main: files.main.sort(), subagents: files.subagents }));
}

/**
 * When any of these Claude Code sessions last wrote its own transcript, in any project folder (epoch
 * ms); undefined when none has one. It checks one path per session and project folder and never lists
 * every transcript, so a hook can afford it.
 */
export async function lastWriteOf(folders: TranscriptFolders, projectsDir: string, claudeSessions: readonly string[]): Promise<number | undefined> {
  let last: number | undefined;
  for (const project of await folders.entries(projectsDir)) {
    if (!project.folder) {
      continue;
    }
    for (const id of claudeSessions) {
      const changedAt = await folders.changedAt(join(projectsDir, project.name, `${id}${TRANSCRIPT}`));
      if (changedAt !== undefined && (last === undefined || changedAt > last)) {
        last = changedAt;
      }
    }
  }
  return last;
}
