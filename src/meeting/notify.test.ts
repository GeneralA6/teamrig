import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { NOTICE_TEXT_VAR, NOTICE_TITLE_VAR, noticeOf, noticeRequest, POWERSHELL_APP_ID, showNotice, WINDOWS_TOAST_SCRIPT } from './notify.ts';
import type { ScheduledMeeting } from './schedule.ts';

const MEETING: ScheduledMeeting = {
  id: 'M3',
  at: Date.parse('2030-01-08T14:00:00Z'),
  minutes: 20,
  session: 'web',
  with: [],
  tasks: [],
  about: "the pricing tiers; it's $(Get-Date) & \"quoted\"",
  brief: null,
  status: 'scheduled',
  notifiedAt: null,
  by: 'lead',
  changedAt: 0,
  note: null,
};
const NOTICE = noticeOf(MEETING);
const ENV = { PATH: '/usr/bin' };

function decoded(args: readonly string[]): string {
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1] ?? '', 'base64').toString('utf16le');
}

describe('noticeOf', () => {
  it('names the meeting, the session met, its length and the command that starts it', () => {
    assert.deepEqual(NOTICE, {
      id: 'M3',
      title: 'teamrig meeting M3 now',
      text: `web: ${MEETING.about} (20 min). Start: teamrig meeting start M3`,
    });
  });
});

describe('noticeRequest', () => {
  it('shows a Windows toast under PowerShell\'s own app id, the words passed as variables, never in the script', () => {
    const request = noticeRequest('win32', NOTICE, ENV, '/work');
    assert.equal(request?.command, 'powershell.exe');
    assert.deepEqual(request?.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = decoded(request?.args ?? []);
    assert.equal(script, WINDOWS_TOAST_SCRIPT);
    assert.ok(script.includes(`CreateToastNotifier('${POWERSHELL_APP_ID}')`));
    assert.ok(!script.includes('pricing'), 'no word of the meeting is in the script');
    assert.equal(request?.env[NOTICE_TITLE_VAR], NOTICE.title);
    assert.equal(request?.env[NOTICE_TEXT_VAR], NOTICE.text);
    assert.equal(request?.env['PATH'], '/usr/bin');
    assert.equal(request?.cwd, '/work');
  });

  it('shows a macOS banner whose words are the script\'s run arguments', () => {
    assert.deepEqual(noticeRequest('darwin', NOTICE, ENV, '/work'), {
      command: 'osascript',
      args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', NOTICE.title, NOTICE.text],
      cwd: '/work',
      env: ENV,
    });
  });

  it('runs notify-send on Linux, its options ended before the words', () => {
    assert.deepEqual(noticeRequest('linux', NOTICE, ENV, '/work')?.args, ['--app-name=teamrig', '--', NOTICE.title, NOTICE.text]);
  });

  it('knows no notification on another OS', () => {
    assert.equal(noticeRequest('freebsd', NOTICE, ENV, '/work'), undefined);
  });
});

describe('showNotice', () => {
  it('starts the notification hidden and tells how its start went', async () => {
    const processes = new FakeProcesses();
    assert.deepEqual(await showNotice(processes, 'linux', NOTICE, ENV, '/work'), { kind: 'started', end: 'spawned' });
    assert.equal(processes.hidden[0]?.command, 'notify-send');
    processes.onStart('notify-send', { kind: 'missing' });
    assert.deepEqual(await showNotice(processes, 'linux', NOTICE, ENV, '/work'), { kind: 'missing' });
  });

  it('starts nothing where teamrig knows no notification', async () => {
    const processes = new FakeProcesses();
    assert.deepEqual(await showNotice(processes, 'aix', NOTICE, ENV, '/work'), { kind: 'unsupported' });
    assert.equal(processes.hidden.length, 0);
  });
});
