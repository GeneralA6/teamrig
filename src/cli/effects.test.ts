import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_EFFECTS, COMMAND_FLAGS } from './run.ts';

/**
 * Every command's effect, written out: a command added to the CLI fails this test until someone
 * decides whether `/teamrig` may run it as the tab's session at once (`read`), only once the person
 * agreed to run it so (`write`), or never (`internal`).
 */
const EXPECTED = {
  add: 'write',
  set: 'write',
  update: 'write',
  list: 'read',
  show: 'read',
  check: 'read',
  plan: 'read',
  verify: 'read',
  'inbox read': 'write',
  'inbox status': 'read',
  'inbox add': 'write',
  'team create': 'write',
  'team tree': 'read',
  rules: 'read',
  'rules scan': 'read',
  'skills scorecard': 'read',
  'rules keep': 'write',
  'rules forget': 'write',
  start: 'write',
  'meeting start': 'write',
  'meeting agenda': 'write',
  'meeting end': 'write',
  open: 'write',
  launch: 'internal',
  restore: 'read',
  'restore run': 'write',
  'restore check': 'write',
  'restore install': 'write',
  'restore uninstall': 'write',
  'restore resume': 'internal',
  restart: 'internal',
  who: 'read',
  rename: 'write',
  heavy: 'write',
  integrate: 'write',
  roll: 'write',
  claim: 'write',
  release: 'write',
  windows: 'read',
  load: 'write',
  'load end': 'write',
  deploys: 'read',
  hire: 'write',
  retire: 'write',
  refresh: 'write',
  doctor: 'read',
  compact: 'write',
  'gh sync': 'write',
  budget: 'read',
  'budget lift': 'write',
  'budget setup': 'write',
  burst: 'read',
  'burst start': 'write',
  'burst end': 'write',
  statusline: 'internal',
  'statusline install': 'write',
  'statusline uninstall': 'write',
  'config validate': 'read',
  'config migrate': 'write',
  'commits check': 'read',
  'worktree remove': 'write',
  test: 'write',
  'hook push-guard': 'internal',
  'hook package-guard': 'internal',
  'hook cold-send': 'internal',
  'hook failed-send': 'internal',
  'hook loop-nudge': 'internal',
  'hook helper-gate': 'internal',
  'hook inbox-reminder': 'internal',
  'hook session-start': 'internal',
  'hook stop': 'internal',
  'hook subagent-start': 'internal',
  'hook subagent-stop': 'internal',
  'hook restore-track': 'internal',
  'hook tab-status': 'internal',
  'hook readonly-allow': 'internal',
  'hook picker-guard': 'internal',
  'hook refresh-wake': 'internal',
  'hook clear-dir': 'internal',
  'hook clear-claim': 'internal',
  'hook wake-check': 'internal',
  'hook wake-dropped': 'internal',
  'hook slash-command': 'internal',
};

describe('the effect of every command', () => {
  it('is classified, for every command the CLI has', () => {
    assert.deepEqual(Object.keys(COMMAND_EFFECTS).sort(), Object.keys(COMMAND_FLAGS).sort());
  });

  it('is the one decided for it', () => {
    assert.deepEqual({ ...COMMAND_EFFECTS }, EXPECTED);
  });
});
