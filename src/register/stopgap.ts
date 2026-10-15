import { isAbsolute, join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { Flag } from './check.ts';
import type { Task } from './fold.ts';
import { byPlanOrder } from './views.ts';

/**
 * One `stopgap T<id>` tag in a text the team keeps (its CLAUDE.md, a rule file, a skill). A team marks a local
 * stopgap with the task whose release replaces it, so the stopgap can go once that task is finished.
 */
export interface StopgapTag {
  readonly id: string;
  /** Where the tag is: `<file>:<line>`. */
  readonly at: string;
}

const STOPGAP_TAG = /\bstopgap (T\d+)\b/g;

/** The places `check` names in one flag's detail; the rest are counted. */
export const MAX_PLACES_SHOWN = 3;

/** The `stopgap T<id>` tags in `text`, each placed as `<label>:<line>`. */
export function stopgapTags(label: string, text: string): StopgapTag[] {
  return text
    .split(/\r?\n/)
    .flatMap((line, index) => Array.from(line.matchAll(STOPGAP_TAG), (match) => ({ id: match[1] ?? '', at: `${label}:${index + 1}` })));
}

/**
 * The tags in a team's own files. Each entry is a path relative to `folder`, or absolute: one ending in `.md` is a
 * file, any other a folder whose `.md` files are read in name order. A missing file or folder has none.
 */
export async function readStopgapTags(files: Files, folder: string, entries: readonly string[]): Promise<StopgapTag[]> {
  const tags: StopgapTag[] = [];
  for (const entry of entries) {
    const label = entry.replace(/[\\/]+$/, '');
    const path = isAbsolute(label) ? label : join(folder, label);
    const named = /\.md$/i.test(label)
      ? [{ label, path }]
      : (await files.list(path))
          .filter((name) => /\.md$/i.test(name))
          .sort()
          .map((name) => ({ label: `${label}/${name}`, path: join(path, name) }));
    for (const file of named) {
      const text = await files.read(file.path);
      if (text !== undefined) {
        tags.push(...stopgapTags(file.label, text));
      }
    }
  }
  return tags;
}

/**
 * STOPGAP-DONE, one flag per finished task that tags still name: a done task's release landed, so its stopgaps
 * are to be removed; a dropped one's never will, so each stopgap needs a new task or a decision to keep it. Tags
 * of active tasks, and of ids the register does not know, are not flagged. The flags come in plan order.
 */
export function stopgapFlags(tags: readonly StopgapTag[], tasks: ReadonlyMap<string, Task>): Flag[] {
  const places = new Map<string, string[]>();
  for (const tag of tags) {
    places.set(tag.id, [...(places.get(tag.id) ?? []), tag.at]);
  }
  const flags = [...places].flatMap(([id, at]) => {
    const task = tasks.get(id);
    if (task === undefined || (task.status !== 'done' && task.status !== 'dropped')) {
      return [];
    }
    const shown = at.slice(0, MAX_PLACES_SHOWN).join(', ');
    const more = at.length > MAX_PLACES_SHOWN ? ` and ${at.length - MAX_PLACES_SHOWN} more` : '';
    const ask = task.status === 'done' ? 'remove the stopgap' : 'replace the task or keep the stopgap by a decision';
    return [{ kind: 'STOPGAP-DONE' as const, task, detail: `tagged in ${shown}${more}; ${ask}` }];
  });
  return flags.sort((a, b) => byPlanOrder(a.task, b.task));
}
