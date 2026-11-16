import { CHANGE_SOURCE_IDS } from './ids.ts';
import type { ChangeSource } from './source.ts';
import { GIT_SOURCE } from './sources/git.ts';
import { NOTES_SOURCE } from './sources/notes.ts';
import { REGISTER_SOURCE } from './sources/register.ts';

const BY_ID: Readonly<Record<(typeof CHANGE_SOURCE_IDS)[number], ChangeSource>> = { notes: NOTES_SOURCE, register: REGISTER_SOURCE, git: GIT_SOURCE };

/** Every change source, in `CHANGE_SOURCE_IDS` order. */
export const CHANGE_SOURCES: readonly ChangeSource[] = CHANGE_SOURCE_IDS.map((id) => BY_ID[id]);
