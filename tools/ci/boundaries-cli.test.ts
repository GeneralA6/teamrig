import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS_REPO } from '../lib/repo-root.ts';
import { type CliRun, TempRepo } from '../lib/temp-repo.ts';
import { BOUNDARY_RULES } from './boundaries.ts';

const CLI = fileURLToPath(new URL('./boundaries-cli.ts', import.meta.url));
const WARN = 'boundaries: warn mode, so the counts fail nothing yet\n';
/** The count lines and the closing line, given each rule's count in the rules' order. */
const counted = (...counts: readonly number[]): string => `${BOUNDARY_RULES.map((rule, index) => `boundaries: ${counts[index] ?? 0} ${rule.title}\n`).join('')}${WARN}`;

describe('boundaries-cli', () => {
  let repo: TempRepo;
  /** Runs the CLI on the temp repo from a folder outside it, so a read by the cwd would find nothing. */
  const check = (args: readonly string[] = []): CliRun => repo.runOutside(CLI, [...args, '--root', repo.dir]);
  /** A repo with a finding of every rule, and files the check must not read. */
  const crossed = (): void => {
    repo.write('tools/docs/pages/draw.ts', "import host from '../../../src/adapters/hosts/first/index.ts';\n");
    repo.write('src/core/run.ts', "import { b } from '../cli/b.ts';\n");
    repo.write('src/cli/b.ts', "import host from '../adapters/hosts/first/index.ts';\nexport const codexHome = host;\nexport const jiraKey = 1;\n");
    repo.write('src/adapters/hosts/first/index.ts', "import { isRecord } from '../../../core/guards.ts';\n");
    repo.write('src/cli/notes.md', 'codex\n');
    repo.write('docs/draw.ts', "import host from '../src/adapters/hosts/first/index.ts';\n");
  };
  beforeEach(() => {
    repo = new TempRepo('boundaries');
  });
  afterEach(() => repo.remove());

  it('counts each rule over the .ts files of src and tools of the --root repo, and exits 0 whatever it finds', () => {
    crossed();
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, counted(1, 2, 1, 2));
  });

  it('--list prints each finding before the counts, src before tools, each sorted by its / path', () => {
    crossed();
    const result = check(['--list']);
    assert.equal(result.status, 0, result.stderr);
    const findings = [
      'src/adapters/hosts/first/index.ts:1: adapter-imports: src/core/guards.ts',
      'src/cli/b.ts:1: adapter-reach: src/adapters/hosts/first/index.ts',
      'src/cli/b.ts:2: tool-names: codex',
      'src/cli/b.ts:3: tool-names: jira',
      'src/core/run.ts:1: core-imports: src/cli/b.ts',
      'tools/docs/pages/draw.ts:1: adapter-reach: src/adapters/hosts/first/index.ts',
    ];
    assert.equal(result.stdout, `${findings.join('\n')}\n${counted(1, 2, 1, 2)}`);
  });

  it('counts nothing in a repo with no src or tools folder', () => {
    const result = check(['--list']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, counted(0, 0, 0, 0));
  });

  it('checks its own repo, not the cwd, when no --root is given, and writes nothing in the cwd', () => {
    const foreign = repo.runOutside(CLI);
    assert.equal(foreign.stderr, '');
    assert.equal(foreign.status, 0);
    assert.deepEqual(foreign, repo.runOutside(CLI, ['--root', TOOLS_REPO]));
    assert.deepEqual(readdirSync(repo.outside), []);
  });

  it('exits 2 on an unknown option or a --root with no folder', () => {
    const unknown = check(['--fix']);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, 'boundaries: unknown option --fix (usage: boundaries-cli.ts [--list] [--root <repo>])\n');
    const bare = repo.runOutside(CLI, ['--root']);
    assert.equal(bare.status, 2);
    assert.equal(bare.stderr, 'boundaries: --root needs a folder\n');
  });
});
