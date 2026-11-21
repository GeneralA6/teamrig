import { isRecord, stringField } from '../../../plugin-api/index.ts';

/**
 * Which of a project's issue types a new issue opens as. Jira opens no issue without a type, and each project has its
 * own list, so the type is picked from what the project lets the sign-in create: its Task, the plain unit of work in
 * Jira's own templates, else its first type that is no sub-task (a sub-task opens only under a parent).
 */

/** The type an issue opens as when the project has it, as Jira's templates name it. */
export const OPENING_TYPE = 'Task';

/**
 * The id of the type to open an issue as, read from Jira's answer on the types an issue of a project can be created
 * with (`{ issueTypes: [{ id, name, subtask }] }`); undefined when it names none an issue can open as.
 */
export function openingType(answer: unknown): string | undefined {
  const listed: unknown = isRecord(answer) ? answer['issueTypes'] : undefined;
  const types = (Array.isArray(listed) ? listed : []).flatMap((value: unknown) => {
    const id = isRecord(value) ? stringField(value, 'id') : undefined;
    return isRecord(value) && id !== undefined && id !== '' && value['subtask'] !== true ? [{ id, name: stringField(value, 'name') ?? '' }] : [];
  });
  return (types.find((type) => type.name === OPENING_TYPE) ?? types[0])?.id;
}
