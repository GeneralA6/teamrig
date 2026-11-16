import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DEFAULT_GITHUB } from '../../src/config/defaults.ts';
import { DESIGN_LABEL_SPEC } from '../../src/issues/design-label.ts';
import { parseLabelFile } from '../../src/issues/label-file.ts';
import { formInputs, formLabels, ISSUE_FORMS, PULL_SECTIONS, sectionsOf } from './github-format.ts';

const read = (path: string): string => readFileSync(new URL(`../../.github/${path}`, import.meta.url), 'utf8');

describe('formInputs and formLabels', () => {
  it('reads the inputs, skipping markdown, and the labels line', () => {
    const yaml = [
      'name: x',
      'labels: [bug, p1]',
      'body:',
      '  - type: markdown',
      '    attributes:',
      '      value: hello',
      '  - type: textarea',
      '    attributes:',
      '      label: What happened',
      '    validations:',
      '      required: true',
      '  - type: input',
      '    attributes:',
      '      label: Version',
      '',
    ].join('\n');
    assert.deepEqual(formInputs(yaml), [
      { label: 'What happened', required: true },
      { label: 'Version', required: false },
    ]);
    assert.deepEqual(formLabels(yaml), ['bug', 'p1']);
    assert.deepEqual(formLabels('name: x\n'), []);
  });

  it('refuses an input with no label', () => {
    assert.throws(() => formInputs('body:\n  - type: input\n    id: x\n'), /has no label/);
  });
});

describe('.github issue forms, labels and pull request template', () => {
  const labels = parseLabelFile(read('labels.json'));
  const names = new Set(labels.map((label) => label.name));
  const forms = readdirSync(new URL('../../.github/ISSUE_TEMPLATE/', import.meta.url)).filter((file) => file !== 'config.yml');

  it('has exactly the forms ISSUE_FORMS lists', () => {
    assert.deepEqual(forms.sort(), Object.keys(ISSUE_FORMS).map((form) => `${form}.yml`).sort());
  });

  for (const [form, { label, sections }] of Object.entries(ISSUE_FORMS)) {
    it(`${form}.yml sets its type label and asks for its sections, in order`, () => {
      const yaml = read(`ISSUE_TEMPLATE/${form}.yml`);
      assert.deepEqual(formLabels(yaml), [label]);
      assert.deepEqual(formInputs(yaml), sections.map(({ name, required }) => ({ label: name, required })));
    });
  }

  it('takes no blank issue and sends a vulnerability to a private advisory', () => {
    const config = read('ISSUE_TEMPLATE/config.yml');
    assert.match(config, /^blank_issues_enabled: false$/m);
    assert.match(config, /^ {4}url: https:\/\/github\.com\/[\w.-]+\/teamrig\/security\/advisories\/new$/m);
  });

  it('lists every label the forms, the format checks and the import use', () => {
    const used = [...Object.values(ISSUE_FORMS).map((form) => form.label), 'p1', 'p2', 'p3', 'needs-format', 'duplicate', DEFAULT_GITHUB.acceptLabel];
    for (const name of used) {
      assert.ok(names.has(name), `labels.json lacks ${name}`);
    }
  });

  it('lists the design label as teamrig makes it, so the form and the code agree (T3096)', () => {
    assert.deepEqual(labels.find((label) => label.name === DESIGN_LABEL_SPEC.name), DESIGN_LABEL_SPEC);
  });

  it('gives the pull request template its sections, in order', () => {
    assert.deepEqual(sectionsOf(read('pull_request_template.md')), PULL_SECTIONS);
  });
});
