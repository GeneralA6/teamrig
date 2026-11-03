import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { SecretScanner } from '../core/secrets.ts';
import { KeepList } from '../permissions/allow-rules.ts';
import type { SettingsFile } from '../permissions/settings-scope.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { hookOutputKey, type HookOutputs } from './scan-hook-output.ts';
import { scanSettings, type SettingsFinding } from './scan-settings.ts';

const CLAUDE_DIR = join(resolve('/', 'u'), '.claude');
const USER = join(CLAUDE_DIR, 'settings.json');
const SHARED = join(resolve('/', 'work', 'app'), '.claude', 'settings.json');
const LOCAL = join(resolve('/', 'work', 'app'), '.claude', 'settings.local.json');
const SCOPE: readonly SettingsFile[] = [
  { path: USER, kind: 'user' },
  { path: SHARED, kind: 'shared' },
  { path: LOCAL, kind: 'local' },
];
const HELD = 'hunter2-abcdef';
const SECRETS = new SecretScanner(['hunter2-']);

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const USER_SETTINGS = json({
  permissions: { allow: ['Bash', 'Bash(npm run test)'], defaultMode: 'bypassPermissions' },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: ['start.js', '--token', HELD] }] }],
    UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'node prompt.js' }, { type: 'prompt', prompt: 'not a command' }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'node guard.js' }] }],
  },
});

/** What the transcripts read show the user settings' context hooks printing; an exec-form hook is recorded by its command and args joined. */
const HOOKS: HookOutputs = new Map([
  [hookOutputKey('SessionStart', `node start.js --token ${HELD}`), { runs: 4, printed: 4, chars: 10_000 }],
  [hookOutputKey('UserPromptSubmit', 'node prompt.js'), { runs: 10, printed: 3, chars: 300 }],
  [hookOutputKey('PreToolUse', 'node guard.js'), { runs: 9, printed: 9, chars: 900 }],
]);
const NO_HOOKS: HookOutputs = new Map();

describe('scanSettings', () => {
  it('names the wide allow rules by count, prompts turned off, the hooks that printed into the context (an exec-form one with its args) and the missing deny list', async () => {
    const files = new MemoryFiles({ [USER]: USER_SETTINGS, [SHARED]: json({ permissions: { allow: ['Read'] } }) });
    const found = await scanSettings(files, CLAUDE_DIR, SCOPE, new KeepList([]), SECRETS, HOOKS);
    assert.deepEqual(
      found.map((finding) => [finding.kind, finding.path]),
      [
        ['wide-allow', USER],
        ['bypass', USER],
        ['context-hook', USER],
        ['context-hook', USER],
        ['wide-allow', SHARED],
        ['no-deny', USER],
      ],
    );
    assert.match(found[0]?.what ?? '', /^1 allow rule\(s\) approve a whole tool or hold a credential: /);
    assert.equal(
      found[2]?.what,
      'SessionStart hook "node start.js --token [redacted secret pattern from the team config]": printed ~2,500 chars (~625 tokens) a run on average over 4 run(s) read, something in 4; it enters the context',
    );
    assert.equal(found[3]?.what, 'UserPromptSubmit hook "node prompt.js": printed ~30 chars (~8 tokens) a run on average over 10 run(s) read, something in 3; it enters the context');
    assert.equal(found.some((finding) => finding.what.includes(HELD)), false);
  });

  it('names no context hook that the transcripts read never saw run, or saw print nothing into the context (T1233)', async () => {
    const files = new MemoryFiles({ [USER]: USER_SETTINGS });
    const silent: HookOutputs = new Map([[hookOutputKey('SessionStart', 'node'), { runs: 5, printed: 0, chars: 0 }]]);
    for (const hooks of [NO_HOOKS, silent]) {
      const kinds = (await scanSettings(files, CLAUDE_DIR, SCOPE, new KeepList([]), SECRETS, hooks)).map((finding) => finding.kind);
      assert.deepEqual(kinds, ['wide-allow', 'bypass', 'no-deny']);
    }
  });

  it("folds the same finding in a file's worktree copies into the first one that holds it, with their count", async () => {
    const trees = join(resolve('/', 'work', 'app'), '.claude', 'worktrees');
    const treeA = join(trees, 'a', '.claude', 'settings.local.json');
    const treeB = join(trees, 'b', '.claude', 'settings.local.json');
    const treeC = join(trees, 'c', '.claude', 'settings.local.json');
    const scope: readonly SettingsFile[] = [
      { path: LOCAL, kind: 'local' },
      { path: treeA, kind: 'local', projectFile: LOCAL },
      { path: treeB, kind: 'local', projectFile: LOCAL },
      { path: treeC, kind: 'local', projectFile: LOCAL },
    ];
    const wide = json({ permissions: { allow: ['Bash', 'Read'], deny: ['Read(./.env)'] } });
    const narrower = json({ permissions: { allow: ['Bash'] } });
    const rows = (found: readonly SettingsFinding[]) => found.map((finding) => [finding.kind, finding.path, finding.copies]);
    const withProject = await scanSettings(new MemoryFiles({ [LOCAL]: wide, [treeA]: wide, [treeB]: narrower, [treeC]: wide }), CLAUDE_DIR, scope, new KeepList([]), SECRETS, NO_HOOKS);
    assert.deepEqual(rows(withProject), [
      ['wide-allow', LOCAL, 2],
      ['wide-allow', treeB, 0],
    ]);
    const copiesOnly = await scanSettings(new MemoryFiles({ [treeA]: wide, [treeC]: wide }), CLAUDE_DIR, scope, new KeepList([]), SECRETS, NO_HOOKS);
    assert.deepEqual(rows(copiesOnly), [['wide-allow', treeA, 1]]);
  });

  it('finds nothing in a scope whose files deny something and allow only what the keep-list keeps', async () => {
    const files = new MemoryFiles({ [USER]: json({ permissions: { allow: ['Bash'] } }), [LOCAL]: json({ permissions: { deny: ['Read(./.env)'] } }) });
    assert.deepEqual(await scanSettings(files, CLAUDE_DIR, SCOPE, new KeepList(['Bash']), SECRETS, NO_HOOKS), []);
  });
});
