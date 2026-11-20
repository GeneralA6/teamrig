import { isRecord, stringField } from '../../../plugin-api/index.ts';

/**
 * Which of a project's issue types a new issue opens as. Jira opens no issue without a type, and each project has its
 * own list, so the type is picked from what the project lets the sign-in create: its Task, the plain unit of work in
 * Jira's own templates, else its first type that is no sub-task (a sub-task opens only under a parent).
 */

/** The type an issue opens as when the project has it, as Jira's templates name it. */
export const OPENING_TYPE = 'Task';

interface OpenableType {
  readonly id: string;
  readonly name: string;
}

/**
 * The types an issue can open as, read from Jira's answer on the types an issue of a project can be created with
 * (`{ issueTypes: [{ id, name, subtask }] }`).
 */
function openableTypes(answer: unknown): readonly OpenableType[] {
  const listed: unknown = isRecord(answer) ? answer['issueTypes'] : undefined;
  return (Array.isArray(listed) ? listed : []).flatMap((value: unknown) => {
    const id = isRecord(value) ? stringField(value, 'id') : undefined;
    return isRecord(value) && id !== undefined && id !== '' && value['subtask'] !== true ? [{ id, name: stringField(value, 'name') ?? '' }] : [];
  });
}

/**
 * The id of the type to open an issue as, of those Jira's answer lists; undefined when it names none an issue can
 * open as. `wanted` is the type the team's config names: only that one is taken, its name in any case, as a team
 * that names a type means no other.
 */
export function openingType(answer: unknown, wanted?: string): string | undefined {
  const types = openableTypes(answer);
  if (wanted !== undefined) {
    return types.find((type) => type.name.toLowerCase() === wanted.toLowerCase())?.id;
  }
  return (types.find((type) => type.name === OPENING_TYPE) ?? types[0])?.id;
}

/** The names of the types an issue can open as, for a line that says which ones a team may name. */
export function openableNames(answer: unknown): readonly string[] {
  return openableTypes(answer).flatMap((type) => (type.name === '' ? [] : [type.name]));
}
