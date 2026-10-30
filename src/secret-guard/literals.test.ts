import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretShapes } from '../core/secret-shapes.ts';
import { literalFindings, writtenFindings } from './literals.ts';

const join = (...parts: string[]): string => parts.join('');
const TOKEN = join('gh', 'p_', 'a1'.repeat(18));
const PASSWORD = join('s3', 'cret', 'Value9');

describe('literalFindings', () => {
  it('names each shape a command line holds once, by its shape and never its value', () => {
    const findings = literalFindings(join('git push https://app:', PASSWORD, '@queue.local/r.git && echo ', TOKEN, ' ', TOKEN), new SecretShapes());
    assert.deepEqual(findings, [
      { kind: 'literal', id: 'github-token', description: 'GitHub token' },
      { kind: 'literal', id: 'url-credentials', description: 'credentials in a URL' },
    ]);
    assert.doesNotMatch(JSON.stringify(findings), new RegExp(`${TOKEN}|${PASSWORD}`));
  });

  it('finds none in a line that only refers to a secret kept elsewhere', () => {
    assert.deepEqual(literalFindings('curl -H "Authorization: Bearer $TOKEN" "${DB_URI}" https://app:<db_password>@queue.local', new SecretShapes()), []);
  });

  it("finds the team's own patterns too", () => {
    assert.deepEqual(literalFindings(join('deploy --key tok_', 'q8r7s6t5'), new SecretShapes(['tok_[a-z0-9]{8}'])), [
      { kind: 'literal', id: 'config-1', description: 'secret pattern from the team config' },
    ]);
  });
});

describe('writtenFindings', () => {
  it('names each shape the written texts hold once, across texts, by its shape and never its value', () => {
    const findings = writtenFindings([join('const a = "', TOKEN, '";'), join('url: https://app:', PASSWORD, '@queue.local/q'), TOKEN], new SecretShapes());
    assert.deepEqual(findings, [
      { kind: 'written', id: 'github-token', description: 'GitHub token' },
      { kind: 'written', id: 'url-credentials', description: 'credentials in a URL' },
    ]);
    assert.doesNotMatch(JSON.stringify(findings), new RegExp(`${TOKEN}|${PASSWORD}`));
  });

  it('finds none in text that builds a fixture from parts or refers to a secret kept elsewhere', () => {
    assert.deepEqual(writtenFindings(["const token = join('gh', 'p_', 'a1'.repeat(18));", 'url: postgres://user:password@localhost/app', ''], new SecretShapes()), []);
  });
});
