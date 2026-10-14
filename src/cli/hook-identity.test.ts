import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FaultyFiles } from '../testing/faulty-files.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';

const LEAD_UNSET =
  'You are the `lead` session of team `app` (name `app-lead`, roles: lead). $TEAMRIG_SESSION is not set here, so pass --session lead to every `teamrig` task and inbox command.';

describe('the SessionStart hook in a tab with no session set', () => {
  const START = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, source: 'compact' });

  it('knows the tab by the area it read its inbox as, so the setup tab stays the lead', async () => {
    const kit = new CliHarness(TEAM);
    await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    const text = contextOf(await kit.run(['hook', 'session-start'], { stdin: START }));
    assert.ok(text.includes(`\n\n${LEAD_UNSET}\n`));
  });

  it('still loads the rules when the inbox marks cannot be read', async () => {
    const kit = new CliHarness(TEAM);
    const files = new FaultyFiles(kit.files).fail('read', join(TEAM_HOME, 'state', 'inbox-marks.jsonl'), new Error('disk gone'));
    const text = contextOf(await kit.run(['hook', 'session-start'], { stdin: START, files }));
    assert.match(text, /No session is set \(\$TEAMRIG_SESSION\): ask the user which session you are/);
  });
});
