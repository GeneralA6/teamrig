import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretShapes } from '../core/secret-shapes.ts';
import { CommitScanner, DECLARED_FILE } from './commit-scan.ts';
import type { CommitAdds } from './git-adds.ts';
import { DEFAULT_SECRET_PATHS, SecretPaths } from './paths.ts';

const join = (...parts: string[]): string => parts.join('');
const TOKEN = join('gh', 'p_', 'a1'.repeat(18));
const AWS = join('AK', 'IA', 'Q7RT3XW9LP2MZN4K');
const HOME = 'C:/u';
const ROOT = 'C:/work/repo';
const GITHUB = 'GitHub token';
const paths = new SecretPaths([...DEFAULT_SECRET_PATHS, 'deploy/keys/**'], HOME, true);
const scanner = new CommitScanner(new SecretShapes(), paths, ROOT);

const commit = (sha: string, message: string, adds: Partial<Omit<CommitAdds, 'sha' | 'message'>> = {}): CommitAdds => ({
  sha,
  message,
  paths: adds.paths ?? [],
  lines: adds.lines ?? [],
});

describe('CommitScanner.staged', () => {
  it('names each added line in a secret shape by its file and line, each shape it is in, never its value', () => {
    const findings = scanner.staged({
      paths: ['src/a.ts', 'src/b.ts'],
      lines: [
        { file: 'src/a.ts', line: 3, text: join('const token = "', TOKEN, '";') },
        { file: 'src/a.ts', line: 4, text: 'const plain = "nothing here";' },
        { file: 'src/b.ts', line: 10, text: join('key: ', AWS) },
      ],
    });
    assert.deepEqual(findings, [
      { where: 'src/a.ts:3', description: GITHUB },
      { where: 'src/a.ts:3', description: 'literal value assigned to a secret-like name' },
      { where: 'src/b.ts:10', description: 'AWS access key id' },
    ]);
    assert.equal(JSON.stringify(findings).includes(TOKEN), false);
  });

  it('names a staged file the secret paths list, whatever it holds, matched under the repo root', () => {
    const staged = ['.env', 'api/.env.local', 'api/.env.example', 'certs/site.pem', 'deploy/keys/prod.json', 'README.md', 'tests/fixtures/x.key'];
    assert.deepEqual(scanner.staged({ paths: staged, lines: [] }), [
      { where: '.env', description: DECLARED_FILE },
      { where: 'api/.env.local', description: DECLARED_FILE },
      { where: 'certs/site.pem', description: DECLARED_FILE },
      { where: 'deploy/keys/prod.json', description: DECLARED_FILE },
      { where: 'tests/fixtures/x.key', description: DECLARED_FILE },
    ]);
  });

  it('names a staged key store, private key or Terraform state, but not a public key', () => {
    const staged = ['certs/client.p12', 'deploy/id_ed25519', 'deploy/id_ed25519.pub', 'infra/terraform.tfstate', 'infra/main.tf'];
    assert.deepEqual(
      scanner.staged({ paths: staged, lines: [] }).map(({ where }) => where),
      ['certs/client.p12', 'deploy/id_ed25519', 'infra/terraform.tfstate'],
    );
  });

  it('names both the file and the secret it holds, and a secret twice on one line once', () => {
    const findings = scanner.staged({
      paths: ['.env'],
      lines: [
        { file: '.env', line: 1, text: join('A=', TOKEN, ' B=', TOKEN) },
        { file: '.env', line: 2, text: join('C=', TOKEN) },
      ],
    });
    assert.deepEqual(findings, [
      { where: '.env', description: DECLARED_FILE },
      { where: '.env:1', description: GITHUB },
      { where: '.env:2', description: GITHUB },
    ]);
  });

  it('passes a placeholder, a reference and a path the secret paths do not list', () => {
    const lines = ['https://user:password@host/x', 'url: https://u:${DB_PASSWORD}@db/x', 'export TOKEN="$GITHUB_TOKEN"'];
    assert.deepEqual(scanner.staged({ paths: ['src/env.ts', '.envrc.md'], lines: lines.map((text, at) => ({ file: 'f', line: at + 1, text })) }), []);
  });

  it("reads a home-anchored glob against the repo root, so only a repo at home stages the user's own secret file", () => {
    const atHome = new CommitScanner(new SecretShapes(), paths, HOME);
    assert.deepEqual(atHome.staged({ paths: ['.npmrc'], lines: [] }), [{ where: '.npmrc', description: DECLARED_FILE }]);
    assert.deepEqual(scanner.staged({ paths: ['.npmrc'], lines: [] }), []);
  });

  it("finds a team's own pattern beside the write-time shapes", () => {
    const team = new CommitScanner(new SecretShapes(['acme_[0-9a-f]{12}']), paths, ROOT);
    assert.deepEqual(team.staged({ paths: [], lines: [{ file: 'a', line: 1, text: 'id ACME_0123456789ab' }] }).length, 1);
  });
});

describe('CommitScanner.message', () => {
  it('names a secret by its message line, the first being line 1, comment lines included', () => {
    const lines = ['fix: the login', '', join('# token ', TOKEN), 'plain body'];
    assert.deepEqual(scanner.message(lines), [{ where: 'commit message line 3', description: GITHUB }]);
  });

  it('passes a message without a secret', () => {
    assert.deepEqual(scanner.message(['docs: the scan', '', 'see https://user:password@host']), []);
  });
});

describe('CommitScanner.pushed', () => {
  it("names each commit's declared files, lines and message lines by its short id", () => {
    const commits = [
      commit('2a11ce333750631efa84d21a82649ca9d32d8b17', "Merge branch 'side'\n"),
      commit('74d7d9a1aa2ee96b68d514b1a3ab793902af21e3', join('second\n\nkey ', AWS, '\n'), {
        paths: ['a.txt', 'k.pem'],
        lines: [{ file: 'a.txt', line: 2, text: join('t=', TOKEN) }],
      }),
      commit('292903d346c154fc625af8012059a8c59c6913b0', 'first\n', { paths: ['a.txt'], lines: [{ file: 'a.txt', line: 1, text: 'one' }] }),
    ];
    assert.deepEqual(scanner.pushed(commits), [
      { where: '74d7d9a k.pem', description: DECLARED_FILE },
      { where: '74d7d9a a.txt:2', description: GITHUB },
      { where: '74d7d9a commit message line 3', description: 'AWS access key id' },
    ]);
  });

  it('names the same secret in two commits twice, and passes a push that adds none', () => {
    const line = { file: 'a.txt', line: 1, text: TOKEN };
    const twice = [commit('1111111aaaa', 'one', { lines: [line] }), commit('2222222bbbb', 'two', { lines: [line] })];
    assert.deepEqual(
      scanner.pushed(twice).map(({ where }) => where),
      ['1111111 a.txt:1', '2222222 a.txt:1'],
    );
    assert.deepEqual(scanner.pushed([]), []);
  });
});
