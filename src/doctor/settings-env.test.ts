import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { claudeSettingsFiles, readSettingsEnv } from './settings-env.ts';

const USER = join('/u/.claude', 'settings.json');
const SHARED = join('/w/app', '.claude', 'settings.json');
const LOCAL = join('/w/app', '.claude', 'settings.local.json');

describe('claudeSettingsFiles', () => {
  it("lists the user's settings, then the project's shared and local ones", () => {
    assert.deepEqual(claudeSettingsFiles('/u/.claude', '/w/app'), [USER, SHARED, LOCAL]);
  });

  it("lists the user's file once when the project is the user's home folder", () => {
    assert.deepEqual(claudeSettingsFiles('/u/.claude', '/u'), [USER, join('/u', '.claude', 'settings.local.json')]);
  });
});

describe('readSettingsEnv', () => {
  it('reads the env block of each file that exists, in order, leaving out a missing one', async () => {
    const files = new MemoryFiles({
      [USER]: JSON.stringify({ model: 'opus', env: { CLAUDE_CODE_EFFORT_LEVEL: 'high', OTHER: 'x' } }),
      [LOCAL]: JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } }),
    });
    assert.deepEqual(await readSettingsEnv(files, [USER, SHARED, LOCAL]), [
      { kind: 'env', path: USER, env: { CLAUDE_CODE_EFFORT_LEVEL: 'high', OTHER: 'x' } },
      { kind: 'env', path: LOCAL, env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } },
    ]);
  });

  it('reads a number or a true/false as written, skips any other value, and takes a file without a block as empty', async () => {
    const files = new MemoryFiles({
      [USER]: JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 1, FLAG: true, NESTED: { a: 1 }, LIST: ['x'], NOTHING: null } }),
      [SHARED]: JSON.stringify({ permissions: { allow: [] } }),
      [LOCAL]: JSON.stringify({ env: 'CLAUDE_CODE_EFFORT_LEVEL=high' }),
    });
    assert.deepEqual(await readSettingsEnv(files, [USER, SHARED, LOCAL]), [
      { kind: 'env', path: USER, env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', FLAG: 'true' } },
      { kind: 'env', path: SHARED, env: {} },
      { kind: 'env', path: LOCAL, env: {} },
    ]);
  });

  it('reads a file that starts with a byte order mark', async () => {
    const files = new MemoryFiles({ [USER]: `﻿${JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } })}` });
    assert.deepEqual(await readSettingsEnv(files, [USER]), [{ kind: 'env', path: USER, env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } }]);
  });

  it('marks a file that is not JSON, or JSON but not an object, as unreadable without throwing', async () => {
    const files = new MemoryFiles({ [USER]: '{ "env": { "CLAUDE_CODE_EFFORT_LEVEL": "high", } ', [SHARED]: '["env"]', [LOCAL]: 'null' });
    assert.deepEqual(await readSettingsEnv(files, [USER, SHARED, LOCAL]), [
      { kind: 'unreadable', path: USER },
      { kind: 'unreadable', path: SHARED },
      { kind: 'unreadable', path: LOCAL },
    ]);
  });

  it('finds nothing when no settings file exists', async () => {
    assert.deepEqual(await readSettingsEnv(new MemoryFiles(), [USER, SHARED, LOCAL]), []);
  });
});
