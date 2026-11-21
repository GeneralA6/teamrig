import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { callsHookLine, hookScriptsDir, missingHookLines, type HookLine } from './hook-lines.ts';

const STAGED: HookLine = { hook: 'pre-commit', command: 'secrets', sub: 'staged', line: 'teamrig secrets staged || exit 1' };
const MESSAGE: HookLine = { hook: 'commit-msg', command: 'secrets', sub: 'message', line: 'teamrig secrets message "$1" || exit 1' };
const OTHER_COMMAND: HookLine = { hook: 'commit-msg', command: 'stamp', sub: 'commit', line: 'teamrig stamp commit "$1"' };

describe('callsHookLine', () => {
  it("needs the line's own command and subcommand, called through teamrig or its source", () => {
    const cases = [
      ['teamrig secrets staged || exit 1', true],
      ['exec npx teamrig  secrets staged', true],
      ['node src/cli/main.ts secrets staged', true],
      ['teamrig secrets message "$1"', false],
      ['teamrig secrets stagedx', false],
      ['teamrig stamp staged', false],
      ['other-teamrig-tool secrets staged', false],
      ['secrets staged', false],
      ['#!/bin/sh\n  # teamrig secrets staged\nnpm test', false],
      ['#!/bin/sh\nnpm test\nteamrig secrets staged', true],
    ] as const;
    for (const [script, calls] of cases) {
      assert.equal(callsHookLine(script, STAGED), calls, script);
    }
  });

  it('tells two commands in one hook apart', () => {
    const script = '#!/bin/sh\nteamrig secrets message "$1" || exit 1\n';
    assert.equal(callsHookLine(script, MESSAGE), true);
    assert.equal(callsHookLine(script, OTHER_COMMAND), false);
  });
});

describe('hookScriptsDir', () => {
  it("is husky's .husky for its .husky/_, else the hooks folder itself", () => {
    assert.equal(hookScriptsDir(join('/', 'r', '.husky', '_')), join('/', 'r', '.husky'));
    assert.equal(hookScriptsDir(join('/', 'r', 'hooks', '_')), join('/', 'r', 'hooks', '_'));
    assert.equal(hookScriptsDir(join('/', 'r', '.git', 'hooks')), join('/', 'r', '.git', 'hooks'));
  });
});

describe('missingHookLines', () => {
  it('lists, in the order given, each line whose script lacks it or is missing', async () => {
    const files = new MemoryFiles();
    const dir = join('/', 'r', '.git', 'hooks');
    await files.write(join(dir, 'commit-msg'), '#!/bin/sh\nteamrig secrets message "$1" || exit 1\n');
    assert.deepEqual(await missingHookLines(files, dir, [STAGED, MESSAGE, OTHER_COMMAND]), [STAGED, OTHER_COMMAND]);
  });

  it('lists none when every script calls its line', async () => {
    const files = new MemoryFiles();
    const dir = join('/', 'r', '.husky');
    await files.write(join(dir, 'pre-commit'), '#!/bin/sh\nteamrig secrets staged || exit 1\n');
    assert.deepEqual(await missingHookLines(files, dir, [STAGED]), []);
  });
});
