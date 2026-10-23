import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM } from '../testing/cli-harness.ts';

/** {@link TEAM} with alpha a sub-lead over bravo: the lead reaches bravo past alpha. */
const LED_TEAM: JsonRecord = { ...TEAM, leads: { alpha: ['bravo'] } };

const REMINDER_TAIL = 'next time; an urgent incident (a message starting CRITICAL) stays direct.';

function sendResult(to: string, message: string, success = true): string {
  return JSON.stringify({
    session_id: CLAUDE_SESSION,
    cwd: APP,
    hook_event_name: 'PostToolUse',
    tool_name: 'SendMessage',
    tool_input: { to, message },
    tool_response: { success, message: success ? 'sent' : 'No agent named that is reachable.' },
  });
}

function asSession(id: string): { readonly env: { readonly TEAMRIG_SESSION: string } } {
  return { env: { TEAMRIG_SESSION: id } };
}

describe('the route-reminder hook', () => {
  it('tells the lead, by message names, to route work for a session under a sub-lead via that sub-lead', async () => {
    const kit = new CliHarness(LED_TEAM);
    const result = await kit.run(['hook', 'route-reminder'], { stdin: sendResult('app-bravo', 'take T1'), ...asSession('lead') });
    assert.equal(result.code, 0);
    const [line] = result.stdout;
    assert.ok(line !== undefined);
    assert.match(line, /"hookEventName":"PostToolUse"/);
    assert.ok(line.includes(`teamrig: app-bravo works under app-alpha: route such work via app-alpha ${REMINDER_TAIL}`));
  });

  it('says nothing for a CRITICAL message, the direct leader, a failed send or a team with no sub-lead', async () => {
    const led = new CliHarness(LED_TEAM);
    const flat = new CliHarness(TEAM);
    const quiet = [
      await led.run(['hook', 'route-reminder'], { stdin: sendResult('app-bravo', 'CRITICAL: the nightly run is down'), ...asSession('lead') }),
      await led.run(['hook', 'route-reminder'], { stdin: sendResult('app-bravo', 'take T1'), ...asSession('alpha') }),
      await led.run(['hook', 'route-reminder'], { stdin: sendResult('app-bravo', 'take T1', false), ...asSession('lead') }),
      await flat.run(['hook', 'route-reminder'], { stdin: sendResult('app-bravo', 'take T1'), ...asSession('lead') }),
    ];
    assert.deepEqual(
      quiet.map((result) => [result.code, result.stdout]),
      quiet.map(() => [0, []]),
    );
  });
});

describe('inbox add past a sub-lead', () => {
  it('posts the line, then tells the sender by ids to route such work via the sub-lead', async () => {
    const kit = new CliHarness(LED_TEAM);
    const result = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'take T1', '--session', 'lead']);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, [
      'POSTED to bravo; bravo is reminded at its next prompt',
      `teamrig: bravo works under alpha: route such work via alpha ${REMINDER_TAIL}`,
    ]);
  });

  it('adds nothing for a CRITICAL line or the direct leader', async () => {
    const kit = new CliHarness(LED_TEAM);
    const critical = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'CRITICAL: the nightly run is down', '--session', 'lead']);
    const direct = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'take T1', '--session', 'alpha']);
    assert.deepEqual(critical.stdout, ['POSTED to bravo; bravo is reminded at its next prompt']);
    assert.deepEqual(direct.stdout, ['POSTED to bravo; bravo is reminded at its next prompt']);
  });

  it('reminds once for each session a list names past a sub-lead, never for a group', async () => {
    const kit = new CliHarness(LED_TEAM);
    const listed = await kit.run(['inbox', 'add', '--to', 'bravo,alpha,bravo', '--text', 'take T1', '--session', 'lead']);
    const grouped = await kit.run(['inbox', 'add', '--to', 'group:alpha', '--text', 'take T1', '--session', 'lead']);
    const everyone = await kit.run(['inbox', 'add', '--to', 'all', '--text', 'take T1', '--session', 'lead']);
    assert.equal(listed.stdout.filter((line) => line.endsWith(REMINDER_TAIL)).length, 1);
    assert.equal(listed.stdout.at(-1), `teamrig: bravo works under alpha: route such work via alpha ${REMINDER_TAIL}`);
    assert.deepEqual(
      [grouped, everyone].map((result) => result.stdout.filter((line) => line.endsWith(REMINDER_TAIL))),
      [[], []],
    );
  });
});
