/**
 * The change sources this teamrig has, in the order their entries win when two name one change: a project's own
 * notes first, then its register, then bare commits. The config's `changes.sources` names them; the registry
 * (registry.ts) holds one source per id, which its spec checks.
 */
export const CHANGE_SOURCE_IDS = ['notes', 'register', 'git'] as const;

export type ChangeSourceId = (typeof CHANGE_SOURCE_IDS)[number];

export function isChangeSourceId(text: string): text is ChangeSourceId {
  return CHANGE_SOURCE_IDS.some((id) => id === text);
}
