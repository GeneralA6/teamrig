import { parseTranscriptLine, type ToolUse } from '../budget/line.ts';

/**
 * A skill edit Claude Code refused and the turn never redid. Skills are plain files that every session
 * of a team edits (a trap it hit, a date it verified), outside any branch or review, so when two edit one
 * at once Claude Code refuses the later edit (the file changed since it was read, or its anchor text is
 * gone). That refusal is correct; the loss comes after it, when the agent ends its turn as if the edit
 * landed. These read the turn from its transcript, so the turn's end can send the agent back.
 */
export interface DroppedEdit {
  /** The skill's folder name. */
  readonly skill: string;
  /** The file as the tool named it. */
  readonly path: string;
  /** The refusal's first line, without Claude Code's error tags. */
  readonly error: string;
}

/** Whose calls a transcript's turn counts: the session's main thread, or a helper's (its own file is all sidechain). */
export type TranscriptThread = 'main' | 'helper';

/** The tools that change a file in place. A shell edit is left out: a failed shell call is seldom a lost edit. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write']);

/** A file in a skill folder Claude Code loads: `.claude/skills/<name>/`, the user's or a project's. */
const SKILL_FILE = /(?:^|\/)\.claude\/skills\/([^/]+)\/[^/]/;

/** The longest refusal kept, in characters: its first line says why. */
const ERROR_CHARS = 160;

/** The skill a path is in, from forward or back slashes; undefined outside a skill folder. */
export function skillOf(path: string): string | undefined {
  return SKILL_FILE.exec(path.replaceAll('\\', '/'))?.[1];
}

/** One key per file however the tool spelled its path: slashes and letter case vary on Windows. */
function fileKey(path: string): string {
  return path.replaceAll('\\', '/').toLowerCase();
}

function errorLine(text: string): string {
  const line = text.replaceAll(/<\/?tool_use_error>/g, '').trim().split('\n')[0] ?? '';
  return line.length > ERROR_CHARS ? `${line.slice(0, ERROR_CHARS - 3)}...` : line;
}

/**
 * The skill edits the current turn had refused and never redid, from transcript text (`cut`: a tail that
 * may start mid-line, so its first line is skipped). A later edit of the same file that went through
 * counts as redone; a prompt starts a new turn, but a compaction's summary does not: the turn goes on, with
 * the refusal now out of the agent's context. A tail without any error result is not parsed at all.
 */
export function droppedEditsOf(text: string, cut: boolean, thread: TranscriptThread): DroppedEdit[] {
  if (!text.includes('"is_error":true')) {
    return [];
  }
  const edits = new Map<string, ToolUse>();
  const dropped = new Map<string, DroppedEdit>();
  const lines = text.split('\n');
  for (const raw of cut ? lines.slice(1) : lines) {
    const line = parseTranscriptLine(raw);
    if (line?.kind === 'prompt' && line.trigger !== 'continuation') {
      edits.clear();
      dropped.clear();
    } else if (line?.kind === 'call' && line.mainThread === (thread === 'main')) {
      for (const tool of line.tools) {
        if (EDIT_TOOLS.has(tool.name) && tool.path !== undefined && skillOf(tool.path) !== undefined) {
          edits.set(tool.id, tool);
        }
      }
    } else if (line?.kind === 'results') {
      for (const result of line.results) {
        const path = edits.get(result.id)?.path;
        const skill = path === undefined ? undefined : skillOf(path);
        if (path === undefined || skill === undefined) {
          continue;
        }
        if (result.isError) {
          dropped.set(fileKey(path), { skill, path, error: errorLine(result.text) });
        } else {
          dropped.delete(fileKey(path));
        }
      }
    }
  }
  return [...dropped.values()];
}

/** The instruction that sends the agent back to its dropped skill edits; `command` is the kit's name. */
export function droppedEditReason(dropped: readonly DroppedEdit[], command: string): string {
  const each = dropped.map((edit) => `${edit.skill} (${edit.path}: ${edit.error})`).join('; ');
  const what = dropped.length === 1 ? 'a skill edit was refused and never redone, so the file lacks it' : `${dropped.length} skill edits were refused and never redone, so the files lack them`;
  return (
    `${command}: ${what}: ${each}. Another session may have changed the file since you read it:` +
    ' read it again and redo the change on its current text, or say why you dropped it.'
  );
}
