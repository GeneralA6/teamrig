import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMAND_EFFECTS } from '../../src/cli/run.ts';
import { TEST_SYSTEMS, type TestSystem } from '../ci/change-kind.ts';

/**
 * docs/features.md held to the CLI: it names every command a person or a session runs, as `teamrig <command>` or
 * `<command>` in code. A command whose every form is `internal` (run by Claude Code, a hook or the plugin's mod) is
 * not a feature of its own and is left out.
 */

const FEATURES = readFileSync(fileURLToPath(new URL('../../docs/features.md', import.meta.url)), 'utf8');
const CI = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');

/** How the features page names each runner of the test matrix. */
const SYSTEMS: Readonly<Record<TestSystem, string>> = { 'ubuntu-latest': 'Linux', 'windows-latest': 'Windows', 'macos-latest': 'macOS' };

/**
 * The systems a code change is tested on (the matrix reads them from change-kind-cli.ts) and the Node versions of the
 * CI `test` job's matrix, as its one-line list gives them.
 */
function testMatrix(): { readonly os: readonly TestSystem[]; readonly node: readonly string[] } {
  const job = CI.slice(CI.indexOf('\n  test:\n'));
  const node = (/\n\s+node: \[([^\]]*)\]/.exec(job)?.[1] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return { os: TEST_SYSTEMS, node };
}
/** A command word: lower-case words joined by hyphens (`deploy-status`), none of them a regular-expression character. */
const WORD = /^[a-z]+(-[a-z]+)*$/;

/** Each command's first word, and whether every command under it is internal. */
function topLevelCommands(): ReadonlyMap<string, boolean> {
  const internal = new Map<string, boolean>();
  for (const [command, effect] of Object.entries(COMMAND_EFFECTS)) {
    const word = command.split(' ')[0] ?? command;
    internal.set(word, (internal.get(word) ?? true) && effect === 'internal');
  }
  return internal;
}

describe('docs/features.md', () => {
  const commands = topLevelCommands();

  it('reads the command table: a command a person runs, and one only Claude Code runs', () => {
    assert.equal(commands.get('add'), false);
    assert.equal(commands.get('hook'), true);
  });

  it('names every command a person or a session runs', () => {
    const unnamed = [...commands]
      .filter(([, internal]) => !internal)
      .map(([word]) => word)
      .filter((word) => {
        assert.match(word, WORD, `a command word the spec cannot match safely: ${word}`);
        return !new RegExp(`\`(teamrig )?${word}[\` ]`).test(FEATURES);
      });
    assert.deepEqual(unnamed, [], 'docs/features.md names no row for these commands: add one where the feature belongs');
  });

  it("names each system and Node version of CI's test matrix, and that every merge waits on it (#1177)", () => {
    const row = FEATURES.split('\n').find((line) => line.startsWith('| **Windows, macOS and Linux** |')) ?? '';
    const matrix = testMatrix();
    assert.ok(matrix.os.length > 0 && matrix.node.length > 0, 'the test job has a matrix');
    for (const os of matrix.os) {
      assert.ok(row.includes(SYSTEMS[os]), `${os}: ${row}`);
    }
    assert.ok(row.includes(`Node ${matrix.node.join(' and ')}`), row);
    assert.match(row, /merges only when every check passed/);
    assert.match(row, /proven on Windows only/);
    assert.doesNotMatch(FEATURES, /macOS is untested/);
  });
});
