import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, TEAM, type CliResult } from '../testing/cli-harness.ts';

const OPUS = 'claude-opus-5-5';
const LEAD_ON_OPUS =
  'MODEL app-lead runs model claude-opus-5-5; the team config asks for model best at xhigh effort: type /model best (if this account has no Fable, best is Opus and nothing needs changing)';

function start(model?: string): string {
  return JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, source: 'startup', ...(model === undefined ? {} : { model }) });
}

/** The line the hook shows the user, if any. */
function noticeOf(result: CliResult): string | undefined {
  const parsed: unknown = JSON.parse(result.stdout[0] ?? '');
  assert.ok(isRecord(parsed));
  const notice = parsed['systemMessage'];
  return typeof notice === 'string' ? notice : undefined;
}

async function sessionStart(session: string, stdin: string, env: Readonly<Record<string, string>> = {}, kit = new CliHarness(TEAM)): Promise<CliResult> {
  return kit.run(['hook', 'session-start'], { stdin, env: { TEAMRIG_SESSION: session, ...env } });
}

describe('the SessionStart hook checks the model and effort', () => {
  it('tells the lead, and the user, when it runs below best at xhigh', async () => {
    const result = await sessionStart('lead', start(OPUS));
    assert.equal(noticeOf(result), LEAD_ON_OPUS);
    assert.ok(contextOf(result).includes(`\n${LEAD_ON_OPUS}`));
  });

  it('checks the effort when Claude Code gives it', async () => {
    const result = await sessionStart('lead', start('claude-fable-5'), { CLAUDE_EFFORT: 'high' });
    assert.equal(noticeOf(result), 'MODEL app-lead runs model claude-fable-5 at high effort; the team config asks for model best at xhigh effort: type /effort xhigh');
  });

  it('checks another session against its own launch entry, and by name', async () => {
    const kit = new CliHarness({ ...TEAM, launch: { alpha: { model: 'sonnet' } } });
    const result = await sessionStart('app-alpha', start('claude-haiku-5-5'), {}, kit);
    assert.equal(noticeOf(result), 'MODEL app-alpha runs model claude-haiku-5-5; the team config asks for model sonnet at the default effort: type /model sonnet');
  });

  it('stays silent when it matches, nothing is configured, the model is not given or the session is unknown', async () => {
    for (const [session, stdin] of [
      ['lead', start('claude-fable-5')],
      ['alpha', start(OPUS)],
      ['lead', start()],
      ['zulu', start(OPUS)],
    ] as const) {
      const result = await sessionStart(session, stdin);
      assert.equal(result.stdout.length, 1);
      assert.equal(noticeOf(result), undefined, `${session} ${stdin}`);
    }
  });
});
