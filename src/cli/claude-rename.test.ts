import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, RENAMES_PATH, renameRecordsOf, TEAM, titledPromptOf, USER_HOME } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { EXIT } from './runtime.ts';

const NAMED: JsonRecord = { ...TEAM, names: { lead: 'captain' } };
const TRANSCRIPT = join(USER_HOME, 'transcripts', 'session.jsonl');

function hookInput(fields: JsonRecord): string {
  return JSON.stringify({ cwd: APP, session_id: CLAUDE_SESSION, ...fields });
}

describe('runCli: a Claude Code rename', () => {
  it('records the session title at SessionStart for the session in $TEAMRIG_SESSION, and says so', async () => {
    const kit = new CliHarness(NAMED);
    const result = await kit.run(['hook', 'session-start'], { env: { TEAMRIG_SESSION: 'app-alpha' }, stdin: hookInput({ session_title: 'scout' }) });
    const text = contextOf(result);
    assert.ok(text.includes('You are the `alpha` session of team `app` (name `scout`). Message the lead as `captain`.'));
    assert.ok(text.includes('This session was renamed in Claude Code, so its team name is now `scout` (was `app-alpha`); the old name still finds it.'));
    assert.deepEqual(await renameRecordsOf(kit), [['alpha', 'app-alpha', 'scout', 'alpha']]);
  });

  it('records a title on a prompt for the session this Claude Code session last read an inbox as', async () => {
    const kit = new CliHarness(NAMED);
    await kit.run(['inbox', 'read', '--session', 'bravo'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    const result = await kit.run(['hook', 'inbox-reminder'], { stdin: hookInput({ session_title: 'ranger' }) });
    assert.deepEqual(result.stdout, ["teamrig: this session's team name is now `ranger` (was `app-bravo`), from its Claude Code title; the old name still finds it."]);
    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { stdin: hookInput({ session_title: 'ranger' }) })).stdout, []);
    assert.deepEqual((await kit.run(['who', 'bravo'])).stdout, ['ranger']);
  });

  it("reads the title from the transcript's newest custom-title when the payload has none", async () => {
    const kit = new CliHarness(NAMED);
    const lines = [
      { type: 'custom-title', customTitle: 'scout' },
      { type: 'user', message: 'hello' },
      { type: 'custom-title', customTitle: 'ranger' },
      { type: 'ai-title', aiTitle: 'Fix the build' },
    ];
    await kit.files.write(TRANSCRIPT, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const result = await kit.run(['hook', 'inbox-reminder'], { env: { TEAMRIG_SESSION: 'bravo' }, stdin: hookInput({ transcript_path: TRANSCRIPT }) });
    assert.match(result.stdout[0] ?? '', /team name is now `ranger` \(was `app-bravo`\)/);
    assert.deepEqual(await renameRecordsOf(kit), [['bravo', 'app-bravo', 'ranger', 'bravo']]);
  });

  it('records nothing without a title or a known session', async () => {
    const kit = new CliHarness(NAMED);
    const untitled = await kit.run(['hook', 'inbox-reminder'], { env: { TEAMRIG_SESSION: 'bravo' }, stdin: hookInput({}) });
    assert.deepEqual(titledPromptOf(untitled), { title: 'app-bravo', context: undefined }, 'titled by its name, not renamed');
    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { env: { TEAMRIG_SESSION: 'zulu' }, stdin: hookInput({ session_title: 'scout' }) })).stdout, []);
    const unbound = await kit.run(['hook', 'inbox-reminder'], { stdin: hookInput({ session_title: 'scout' }) });
    assert.equal(unbound.stdout.length, 1, 'only how to bind it');
    assert.match(unbound.stdout[0] ?? '', /^teamrig: this tab's title "scout" names no session of team app, so it is not bound\./);
    const noClaudeSession = JSON.stringify({ cwd: APP, session_title: 'scout' });
    assert.doesNotMatch(contextOf(await kit.run(['hook', 'session-start'], { stdin: noClaudeSession })), /Claude Code title|renamed in Claude Code/);
    assert.equal(await kit.files.read(RENAMES_PATH), undefined);
  });

  it('notes a title that cannot be the team name at SessionStart, and stays silent on a prompt', async () => {
    const kit = new CliHarness(NAMED);
    const env = { TEAMRIG_SESSION: 'alpha' };
    const text = contextOf(await kit.run(['hook', 'session-start'], { env, stdin: hookInput({ session_title: 'captain' }) }));
    assert.ok(text.includes('This session\'s Claude Code title "captain" is not its team name: captain is already the name of lead.'));
    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { env, stdin: hookInput({ session_title: 'Fix the build' }) })).stdout, []);
    assert.equal(await kit.files.read(RENAMES_PATH), undefined);
  });

  it('never fails the hook when the rename cannot be recorded', async () => {
    const kit = new CliHarness(NAMED);
    const files = new FaultyFiles(kit.files).fail('append', RENAMES_PATH, systemError('EACCES', 'EACCES: permission denied'));
    const result = await kit.run(['hook', 'session-start'], { env: { TEAMRIG_SESSION: 'alpha' }, stdin: hookInput({ session_title: 'scout' }), files });
    assert.equal(result.code, EXIT.ok);
    const text = contextOf(result);
    assert.ok(text.includes("This session's Claude Code title could not be checked against its team name (EACCES: permission denied); the next prompt tries again."));
    assert.ok(text.includes('(name `app-alpha`)'));
  });
});
