import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { passRecordGuardOutput, passRecordReach, passRecordReason } from './pass-record-guard.ts';

const RECORD = 'C:/work/repo/.git/local-ci/0123abcd.json';

const call = (tool_name: string, tool_input: Record<string, string>): Record<string, unknown> => ({ hook_event_name: 'PreToolUse', tool_name, tool_input });
const shell = (command: string, tool = 'Bash'): Record<string, unknown> => call(tool, { command });

describe('passRecordReach', () => {
  it('names a file tool writing in the records folder, whatever its slashes, case or root', () => {
    assert.equal(passRecordReach(call('Write', { file_path: RECORD })), `this Write writes ${RECORD}, in the folder of the trees' pass records`);
    for (const [tool, field, path] of [
      ['Edit', 'file_path', 'C:\\work\\repo\\.git\\local-ci\\0123abcd.json'],
      ['MultiEdit', 'file_path', '.git/local-ci/0123abcd.json'],
      ['NotebookEdit', 'notebook_path', 'local-ci/notes.ipynb'],
      ['Write', 'file_path', 'C:/work/repo/.git/LOCAL-CI/0123abcd.json'],
    ] as const) {
      assert.match(passRecordReach(call(tool, { [field]: path })) ?? '', new RegExp(`^this ${tool} writes `), path);
    }
  });

  it('passes a file tool writing anywhere else, the code that names the folder too', () => {
    for (const path of ['C:/work/repo/src/push-guard/pass-record.ts', 'C:/work/my-local-ci/a.json', 'C:/work/local-ci-tools/a.json', 'C:/work/repo/.git/local-ci']) {
      assert.equal(passRecordReach(call('Write', { file_path: path })), undefined, path);
    }
  });

  it('names a shell line that names the folder, a write built in inline code too', () => {
    for (const [command, tool] of [
      ['echo {} > .git/local-ci/0123abcd.json', 'Bash'],
      ['Remove-Item .git\\local-ci\\0123abcd.json', 'PowerShell'],
      [`node -e "require('fs').writeFileSync(require('path').join(d, 'local-ci', t + '.json'), '{}')"`, 'Bash'],
      ['cp record.json "$(git rev-parse --git-common-dir)/Local-CI/"', 'Bash'],
    ] as const) {
      assert.equal(passRecordReach(shell(command, tool)), `this ${tool} line names local-ci, the folder of the trees' pass records`, command);
    }
  });

  it('passes a shell line that does not name it: the runner, a push, a longer name', () => {
    for (const command of ['node tools/ci/local.ts', 'git push origin topic', 'ls my-local-ci-tool', 'npm run local-ci-check']) {
      assert.equal(passRecordReach(shell(command)), undefined, command);
    }
  });

  it('passes the tools that only read, and a call it cannot read', () => {
    assert.equal(passRecordReach(call('Read', { file_path: RECORD })), undefined);
    assert.equal(passRecordReach(call('Grep', { pattern: 'local-ci', path: 'src' })), undefined);
    assert.equal(passRecordReach({ tool_name: 'Write' }), undefined);
    assert.equal(passRecordReach({ tool_name: 'Bash', tool_input: { command: 1 } }), undefined);
    assert.equal(passRecordReach({ tool_input: { command: 'cat .git/local-ci/x.json' } }), undefined);
  });
});

describe('passRecordGuardOutput', () => {
  it('refuses a call that reaches a record, with the reason', () => {
    const reach = `this Write writes ${RECORD}, in the folder of the trees' pass records`;
    assert.deepEqual(JSON.parse(passRecordGuardOutput(call('Write', { file_path: RECORD }))), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: passRecordReason(reach) },
    });
  });

  it('prints nothing for a call that does not, or input that is not a payload', () => {
    assert.equal(passRecordGuardOutput(shell('git status')), '');
    for (const payload of [null, 'text', 3, []]) {
      assert.equal(passRecordGuardOutput(payload), '', String(payload));
    }
  });

  it('says what to do instead and that it is not to be routed around', () => {
    const reason = passRecordReason('this Bash line names local-ci');
    assert.match(reason, /^teamrig pass-record guard: this Bash line names local-ci\. Only the repo's local runner writes a record/);
    assert.match(reason, /read a record with the Read tool/);
    assert.match(reason, /Do not retry this or route around it/);
  });
});
