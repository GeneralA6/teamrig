import { isRecord, stringField } from '../core/guards.ts';
import type { LabelSpec } from './host.ts';

/**
 * A repository's label file, `.github/labels.json`: `{ "labels": [ { "name", "color", "description" } ] }`, each
 * label as GitHub stores it. The repository's own checks hold its issue forms to it, and `teamrig issue label` makes
 * a label it names where the repository lacks it.
 */
export const LABEL_FILE = '.github/labels.json';

/** GitHub refuses a label description longer than this. */
export const LABEL_DESCRIPTION_MAX = 100;

/** The labels of a label file, refusing a malformed, duplicate or over-long one with a line naming it. */
export function parseLabelFile(json: string): LabelSpec[] {
  const body: unknown = JSON.parse(json);
  const list = isRecord(body) ? body['labels'] : undefined;
  if (!Array.isArray(list)) {
    throw new Error('labels.json: expected { "labels": [ { "name", "color", "description" } ] }');
  }
  const labels = list.map((entry: unknown): LabelSpec => {
    const name = isRecord(entry) ? stringField(entry, 'name') : undefined;
    const color = isRecord(entry) ? stringField(entry, 'color') : undefined;
    const description = isRecord(entry) ? stringField(entry, 'description') : undefined;
    if (name === undefined || name.trim() === '' || color === undefined || !/^[0-9a-f]{6}$/.test(color) || description === undefined) {
      throw new Error(`labels.json: each label needs a name, a six-digit lowercase hex color and a description (at ${JSON.stringify(entry)})`);
    }
    if (description.length > LABEL_DESCRIPTION_MAX) {
      throw new Error(`labels.json: ${name}'s description is over ${LABEL_DESCRIPTION_MAX} characters, which GitHub refuses`);
    }
    return { name, color, description };
  });
  const names = labels.map((label) => label.name.toLowerCase());
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice !== undefined) {
    throw new Error(`labels.json: ${twice} is listed twice (GitHub label names ignore case)`);
  }
  return labels;
}
