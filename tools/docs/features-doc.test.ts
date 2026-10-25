import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMAND_EFFECTS } from '../../src/cli/run.ts';

/**
 * docs/features.md held to the CLI: it names every command a person or a session runs, as `teamrig <command>` or
 * `<command>` in code. A command whose every form is `internal` (run by Claude Code, a hook or the plugin's mod) is
 * not a feature of its own and is left out.
 */

const FEATURES = readFileSync(fileURLToPath(new URL('../../docs/features.md', import.meta.url)), 'utf8');
const WORD = /^[a-z]+$/;

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

  // CI is paused (.github/workflows/ci.yml), so only the systems a proof ran on are named (T1175).
  it('names the systems it is proven on, Windows and Linux, and macOS as untested', () => {
    const row = FEATURES.split('\n').find((line) => line.startsWith('| **Windows and Linux** |')) ?? '';
    assert.match(row, /on Linux the full test suite and a smoke run of the commands and hooks pass/);
    assert.match(row, /macOS is untested/);
    assert.doesNotMatch(FEATURES, /tested on all three/);
  });
});
