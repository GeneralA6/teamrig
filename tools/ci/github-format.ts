import { isRecord, stringField } from '../lib/guards.ts';

/**
 * The format every issue and pull request on the repo carries: the sections that hold a task's fields
 * (what, why, how to tell it is done) and the type label the import reads as the task's type. The issue
 * forms under .github/ISSUE_TEMPLATE and the pull request template are held to these lists by
 * github-format.test.ts, so the forms, the docs and the format checks read one source.
 */

/** One section of an issue form: its `### <name>` heading in the issue body, and whether the form requires it. */
export interface FormSection {
  readonly name: string;
  readonly required: boolean;
}

/** An issue form: the type label it sets and its sections, in order. */
export interface IssueForm {
  readonly label: string;
  readonly sections: readonly FormSection[];
}

const required = (name: string): FormSection => ({ name, required: true });

/** The forms by file name (without `.yml`); each sets one type label. */
export const ISSUE_FORMS: Readonly<Record<string, IssueForm>> = {
  bug: { label: 'bug', sections: [required('What happened'), required('What was expected'), required('Steps'), required('Version'), required('OS')] },
  task: { label: 'task', sections: [required('What'), required('Why'), required('Done when')] },
  feature: { label: 'feature', sections: [required('Problem'), required('Proposal'), { name: 'Alternatives', required: false }] },
};

/** The pull request template's `## ` sections, in order. */
export const PULL_SECTIONS: readonly string[] = ['What', 'Why', 'Changes', 'Old-code proof', 'Tests', 'Issue', 'Checklist'];

/** A label as GitHub stores it. */
export interface RepoLabel {
  readonly name: string;
  /** Six hex digits, no `#`. */
  readonly color: string;
  readonly description: string;
}

/** GitHub refuses a label description longer than this. */
export const LABEL_DESCRIPTION_MAX = 100;

/** The labels of `.github/labels.json`, refusing a malformed, duplicate or over-long one. */
export function parseLabels(json: string): RepoLabel[] {
  const body: unknown = JSON.parse(json);
  const list = isRecord(body) ? body['labels'] : undefined;
  if (!Array.isArray(list)) {
    throw new Error('labels.json: expected { "labels": [ { "name", "color", "description" } ] }');
  }
  const labels = list.map((entry: unknown): RepoLabel => {
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

/** One input of an issue form file, as its YAML declares it. */
export interface FormInput {
  readonly label: string;
  readonly required: boolean;
}

/**
 * The inputs of an issue form file (textarea, input and dropdown; markdown blocks show text only), read from
 * the two-space `body:` list the forms here use. Not a YAML parser: github-format.test.ts proves it on the
 * repo's own forms, whose layout it fixes.
 */
export function formInputs(yaml: string): FormInput[] {
  const body = yaml.slice(yaml.search(/^body:\n/m));
  return body
    .split(/^ {2}- type: /m)
    .slice(1)
    .filter((block) => /^(textarea|input|dropdown)\n/.test(block))
    .map((block) => {
      const label = /^ {6}label: (.+)$/m.exec(block)?.[1];
      if (label === undefined) {
        throw new Error(`an issue form input has no label: ${block.slice(0, 40)}`);
      }
      return { label, required: /^ {6}required: true$/m.test(block) };
    });
}

/** The labels an issue form file sets, from its `labels: [a, b]` line. */
export function formLabels(yaml: string): string[] {
  const line = /^labels: \[([^\]]*)\]$/m.exec(yaml)?.[1];
  return line === undefined ? [] : line.split(',').map((label) => label.trim()).filter((label) => label !== '');
}

/** The `## ` headings of a Markdown file, in order. */
export function sectionsOf(markdown: string): string[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]?.trim() ?? '');
}
