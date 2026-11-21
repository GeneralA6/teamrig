import { isNonNegativeInteger, isRecord } from '../core/guards.ts';
import type { Task } from './fold.ts';

// No node: import here: a task line holds the mark, and the read entry (src/read) runs without Node's modules.

/**
 * What a snapshot's task line keeps of a description it leaves out (T4781). A description is the longest text a task
 * holds (an imported issue's body is its description), and the working set's readers rank, list and check tasks
 * without it, so a task line carries this mark in its place and the snapshot's size follows the tasks kept, not
 * their texts. The history keeps every description whole: `show` and the meeting's agenda read it there.
 */
export interface DescriptionCut {
  /** The whole text's `length`: its UTF-16 code units. */
  readonly chars: number;
  /** {@link textHash} of the whole text: tells an edited text from the one cut, and guards nothing. */
  readonly hash: string;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HASH = /^[0-9a-f]{8}$/;

/**
 * FNV-1a (32 bits) of a text's UTF-16 code units, each as its low byte then its high byte, as 8 hex digits. Change
 * detection only: with the length beside it, two texts sharing a mark by chance is about 1 in 4 billion edits, and a
 * text made to share one harms nothing, since the mark only decides whether a sync writes the text again.
 */
export function textHash(text: string): string {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    hash = Math.imul(hash ^ (unit & 0xff), FNV_PRIME);
    hash = Math.imul(hash ^ (unit >>> 8), FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** The mark a task line keeps of `text`. */
export function cutOf(text: string): DescriptionCut {
  return { chars: text.length, hash: textHash(text) };
}

/**
 * The task as a task line holds it: its description left out, its mark in its place. A task with no description is
 * returned as is, one already cut too, so cutting twice gives the same task.
 */
export function cutTask(task: Task): Task {
  return task.description === null ? task : { ...task, description: null, descriptionCut: cutOf(task.description) };
}

/**
 * True when the task's description is `text`: equal to it on a task holding its description whole (null is none), and
 * matching the mark on a cut one, so a reader that only asks whether a text changed never needs the history.
 */
export function holdsDescription(task: Task, text: string | null): boolean {
  const { descriptionCut } = task;
  if (descriptionCut === null) {
    return task.description === text;
  }
  if (text === null) {
    return false;
  }
  const mark = cutOf(text);
  return mark.chars === descriptionCut.chars && mark.hash === descriptionCut.hash;
}

/**
 * The task with the description its task line left out: a cut task takes the text of `whole`, the same task as the
 * history folds it, and holds no mark. A task that is not cut is returned as is, and a cut one stays cut when the
 * history lacks it or holds another text than the one cut, so a reader never shows a text the mark does not name.
 */
export function describedTask(task: Task, whole: Task | undefined): Task {
  if (task.descriptionCut === null || whole === undefined || !holdsDescription(task, whole.description)) {
    return task;
  }
  return { ...task, description: whole.description, descriptionCut: null };
}

/** The mark a task line's `descriptionCut` holds, null for none, or why the value is neither. */
export function parseDescriptionCut(value: unknown): DescriptionCut | null | string {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return 'descriptionCut is neither a mark nor null';
  }
  const { chars, hash } = value;
  if (!isNonNegativeInteger(chars) || typeof hash !== 'string' || !HASH.test(hash)) {
    return `bad descriptionCut ${JSON.stringify(value)}`;
  }
  return { chars, hash };
}
