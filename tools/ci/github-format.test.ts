import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DEFAULT_GITHUB } from '../../src/config/defaults.ts';
import { formInputs, formLabels, ISSUE_FORMS, LABEL_DESCRIPTION_MAX, parseLabels, PULL_SECTIONS, sectionsOf } from './github-format.ts';

const read = (path: string): string => readFileSync(new URL(`../../.github/${path}`, import.meta.url), 'utf8');

describe('parseLabels', () => {
  const one = (label: Record<string, unknown>): string => JSON.stringify({ labels: [label] });

  it('reads each label', () => {
    assert.deepEqual(parseLabels(one({ name: 'bug', color: 'd73a4a', description: 'Type: a bug' })), [{ name: 'bug', color: 'd73a4a', description: 'Type: a bug' }]);
  });

  it('refuses a missing list, a malformed label, an over-long description and a name listed twice in any case', () => {
    assert.throws(() => parseLabels('[]'), /expected \{ "labels"/);
    assert.throws(() => parseLabels(one({ name: 'bug', color: '#d73a4a', description: 'x' })), /six-digit lowercase hex color/);
    assert.throws(() => parseLabels(one({ name: ' ', color: 'd73a4a', description: 'x' })), /needs a name/);
    assert.throws(() => parseLabels(one({ name: 'bug', color: 'd73a4a' })), /needs a name/);
    assert.throws(() => parseLabels(one({ name: 'bug', color: 'd73a4a', description: 'x'.repeat(LABEL_DESCRIPTION_MAX + 1) })), /over 100 characters/);
    const twice = { labels: [{ name: 'Bug', color: 'd73a4a', description: '' }, { name: 'bug', color: 'd73a4a', description: '' }] };
    assert.throws(() => parseLabels(JSON.stringify(twice)), /bug is listed twice/);
  });
});

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
  const labels = parseLabels(read('labels.json'));
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

  it('gives the pull request template its sections, in order', () => {
    assert.deepEqual(sectionsOf(read('pull_request_template.md')), PULL_SECTIONS);
  });
});
