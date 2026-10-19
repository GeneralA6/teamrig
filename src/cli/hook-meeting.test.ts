import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MEETING_LAPSE_MS } from '../meeting/state.ts';
import { APP, CLAUDE_SESSION, CliHarness, decisionOf, TEAM } from '../testing/cli-harness.ts';

const LEAD_TAB = '0123abcd-0000-4000-8000-0000000000b1';

function send(to: string, message: string, from = CLAUDE_SESSION): string {
  return JSON.stringify({ session_id: from, cwd: APP, tool_name: 'SendMessage', tool_input: { to, message } });
}

/** A team whose lead opened the meeting, with the lead's tab known by its inbox read and alpha's by $TEAMRIG_SESSION. */
async function teamInMeeting(config = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: LEAD_TAB } });
  const started = await kit.run(['meeting', 'start', '--session', 'lead']);
  assert.equal(started.code, 0, started.stderr.join('\n'));
  return kit;
}

describe('the cold-send hook during the daily meeting', () => {
  it('holds every message to the lead but a CRITICAL one, a resend too', async () => {
    const kit = await teamInMeeting();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const held = await kit.run(['hook', 'cold-send'], { stdin: send('lead', 'the build is green'), env: { TEAMRIG_SESSION: 'alpha' } });
      assert.equal(decisionOf(held), 'deny');
      assert.match(held.stdout[0] ?? '', /Held: app-lead is in the owner's daily meeting since Tue 01-08 10:00 UTC\. .*teamrig inbox add --to lead --text/);
    }
    const critical = await kit.run(['hook', 'cold-send'], { stdin: send('lead', 'CRITICAL: the site is down'), env: { TEAMRIG_SESSION: 'alpha' } });
    assert.deepEqual(critical.stdout, []);
  });

  it("names the meeting's start on the team's clock", async () => {
    const kit = await teamInMeeting();
    const held = await kit.run(['hook', 'cold-send'], { stdin: send('lead', 'the build is green'), env: { TEAMRIG_SESSION: 'alpha' }, timeZone: 'Asia/Jerusalem' });
    assert.match(held.stdout[0] ?? '', /Held: app-lead is in the owner's daily meeting since Tue 01-08 12:00 IST\. /);
  });

  it("lets the lead's own messages and messages to other sessions go", async () => {
    const kit = await teamInMeeting();
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: send('lead', 'a note to self', LEAD_TAB) })).stdout, []);
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: send('bravo', 'the build is green'), env: { TEAMRIG_SESSION: 'alpha' } })).stdout, []);
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: send('explore-helper', 'look') })).stdout, []);
  });

  it('holds even with the cold hold off, and lets go once the meeting ended or lapsed', async () => {
    const kit = await teamInMeeting({ ...TEAM, messages: { coldAfterMinutes: 0 } });
    assert.equal(decisionOf(await kit.run(['hook', 'cold-send'], { stdin: send('lead', 'the build is green') })), 'deny');
    await kit.run(['meeting', 'end', '--session', 'lead']);
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: send('lead', 'the build is green') })).stdout, []);

    await kit.run(['meeting', 'start', '--session', 'lead']);
    kit.clock.advance(MEETING_LAPSE_MS);
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: send('lead', 'the build is green') })).stdout, []);
  });

  it('holds nothing with no lead or no meeting', async () => {
    const noMeeting = new CliHarness(TEAM);
    assert.deepEqual((await noMeeting.run(['hook', 'cold-send'], { stdin: send('lead', 'the build is green') })).stdout, []);
    const noLead = new CliHarness({ sessions: ['alpha', 'bravo'] });
    assert.deepEqual((await noLead.run(['hook', 'cold-send'], { stdin: send('alpha', 'the build is green') })).stdout, []);
  });
});
