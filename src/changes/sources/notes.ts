import { join } from 'node:path';
import type { ChangeAudience, ChangeEntry, ChangeKind, ChangeSource } from '../source.ts';
import { oneLine, readFailure } from './shared.ts';

/** The folder of a project's change notes, one `<slug>.md` per change, joined into its CHANGELOG.md at release. */
export const NOTES_FOLDER = 'changes';

const KINDS: readonly ChangeKind[] = ['action', 'behaviour', 'feature', 'fix', 'other'];
const AUDIENCES: readonly ChangeAudience[] = ['lead', 'all'];

function isKind(text: string): text is ChangeKind {
  return KINDS.some((kind) => kind === text);
}

function isAudience(text: string): text is ChangeAudience {
  return AUDIENCES.some((audience) => audience === text);
}

/** A note's file, read: its entry, or what is wrong with it, by file and line. */
type ReadNote = { readonly kind: 'entry'; readonly entry: ChangeEntry } | { readonly kind: 'bad'; readonly warning: string };

/** `key: value` lines between `---` fences, then the text. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** A front matter key: `area`, `kind`. */
const FIELD_KEY = /^[a-z]+$/;

/** A list in a note's front matter: `files: src/open/, docs/commands.md`. */
function listOf(value: string | undefined): string[] {
  return (value ?? '').split(',').flatMap((part) => (part.trim() === '' ? [] : [part.trim()]));
}

/**
 * One note: front matter with `area`, `kind` (action, behaviour, feature, fix or other, default other), `audience`
 * (lead or all, default lead), for an action its `action` (the step to take), and `files` and `refs` as comma lists;
 * the text below it. A note without the fences, an unknown key's value, or an action with no step is named, not read.
 */
export function readNote(path: string, text: string): ReadNote {
  const match = FRONT_MATTER.exec(text);
  if (match === null) {
    return { kind: 'bad', warning: `${path}:1 has no front matter: start it with --- lines naming its area and kind` };
  }
  const [, head = '', body = ''] = match;
  const fields = new Map<string, string>();
  for (const [index, raw] of head.split(/\r?\n/).entries()) {
    // Split at its colon in code: a `key:\s*(.*)$` pattern backtracks over a long line with a break in it.
    const line = oneLine(raw).trim();
    const colon = line.indexOf(':');
    const key = colon === -1 ? '' : line.slice(0, colon);
    if (!FIELD_KEY.test(key)) {
      if (line !== '') {
        return { kind: 'bad', warning: `${path}:${index + 2} is no "key: value" line` };
      }
      continue;
    }
    fields.set(key, line.slice(colon + 1).trim());
  }
  const kind = fields.get('kind') ?? 'other';
  const audience = fields.get('audience') ?? 'lead';
  const action = fields.get('action');
  if (!isKind(kind)) {
    return { kind: 'bad', warning: `${path}: kind "${kind}" is none of ${KINDS.join(', ')}` };
  }
  if (!isAudience(audience)) {
    return { kind: 'bad', warning: `${path}: audience "${audience}" is none of ${AUDIENCES.join(', ')}` };
  }
  if (kind === 'action' && (action === undefined || action === '')) {
    return { kind: 'bad', warning: `${path}: kind action needs an action line, the step to take` };
  }
  const textOf = body.trim();
  if (textOf === '') {
    return { kind: 'bad', warning: `${path}: no text below the front matter` };
  }
  return {
    kind: 'entry',
    entry: {
      source: 'notes',
      version: undefined,
      at: undefined,
      area: (fields.get('area') ?? '').toLowerCase() || 'general',
      kind,
      audience,
      text: textOf,
      action: kind === 'action' ? action : undefined,
      files: listOf(fields.get('files')),
      refs: listOf(fields.get('refs')),
    },
  };
}

/**
 * The project's change notes not released yet: `changes/<slug>.md`, each classified by its own front matter. A
 * released note lives in the project's CHANGELOG.md, which the keep-a-changelog source reads.
 */
export const NOTES_SOURCE: ChangeSource = {
  id: 'notes',
  capabilities: { byVersion: false, byDate: false, byFile: false, byArea: false, classified: true },
  detect: async ({ files, project }) => (await files.list(join(project, NOTES_FOLDER))).some((name) => name.endsWith('.md')),
  read: async ({ files, project }) => {
    try {
      const folder = join(project, NOTES_FOLDER);
      const names = (await files.list(folder)).filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md').sort();
      const entries: ChangeEntry[] = [];
      const warnings: string[] = [];
      for (const name of names) {
        const text = await files.read(join(folder, name));
        if (text === undefined) {
          continue;
        }
        const note = readNote(`${NOTES_FOLDER}/${name}`, text);
        if (note.kind === 'entry') {
          entries.push(note.entry);
        } else {
          warnings.push(note.warning);
        }
      }
      return { kind: 'read', entries, warnings };
    } catch (error) {
      return readFailure(error);
    }
  },
};
