import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ASK_EXIT } from '../mod/slash-hand.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { slashRule } from './commands/slash.ts';
import { COMMAND_HELP, COMMAND_TABLE } from './run.ts';
import { EXIT } from './runtime.ts';

/** How a line reached the tab: Enter at its prompt, unless a test says otherwise. */
interface Sent {
  readonly origin?: string;
  readonly agreed?: string;
}

/** `/teamrig <args>` in the harness's tab, with the mod's payload on stdin. */
function slash(kit: CliHarness, args: string, options: RunOptions = {}, sent: Sent = { origin: 'composer' }): Promise<CliResult> {
  const stdin = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: options.cwd ?? APP, args, ...sent });
  return kit.run(['hook', 'slash-command'], { ...options, stdin });
}

/** A tab started with `$TEAMRIG_SESSION` set to alpha. */
const ALPHA_TAB: RunOptions = { env: { TEAMRIG_SESSION: 'alpha' } };

describe('/teamrig with nothing after it', () => {
  it('prints the short help, what runs as the tab session and what asks first', async () => {
    const result = await slash(new CliHarness(), '  ');
    assert.equal(result.code, EXIT.ok);
    const rule = slashRule(COMMAND_TABLE);
    assert.deepEqual(result.stdout, [`${COMMAND_HELP.forCommand(undefined)}\n${rule}`]);
    assert.match(rule, /Without --session, list, show, check, plan, verify, stats, report done, goal list, goal show, inbox status, rules, meeting list, decisions\nrun as this tab's session; a command that changes the team's files/);
  });

  it('prints the same help when stdin holds no JSON', async () => {
    const kit = new CliHarness();
    const result = await kit.run(['hook', 'slash-command'], { stdin: 'not json' });
    assert.equal(result.code, EXIT.ok);
    assert.ok(result.stdout[0]?.startsWith(COMMAND_HELP.forCommand(undefined)));
  });
});

describe('/teamrig with a read command', () => {
  it('runs it as the tab session from $TEAMRIG_SESSION and says so first', async () => {
    const kit = new CliHarness();
    const direct = await kit.run(['inbox', 'status', '--session', 'alpha'], ALPHA_TAB);
    const result = await slash(kit, 'inbox status', ALPHA_TAB);
    assert.equal(result.code, direct.code);
    assert.deepEqual(result.stdout, ["--session alpha (this tab's session)", ...direct.stdout]);
  });

  it('runs it as the area the tab read its inbox as when $TEAMRIG_SESSION is unset', async () => {
    const kit = new CliHarness();
    await kit.run(['inbox', 'read', '--session', 'bravo'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    const direct = await kit.run(['rules', '--session', 'bravo']);
    const result = await slash(kit, 'rules');
    assert.deepEqual(result.stdout, ["--session bravo (this tab's session)", ...direct.stdout]);
  });

  it('passes an explicit --session through unchanged', async () => {
    const kit = new CliHarness();
    const direct = await kit.run(['inbox', 'status', '--session', 'bravo'], ALPHA_TAB);
    assert.deepEqual(await slash(kit, 'inbox status --session bravo', ALPHA_TAB), direct);
  });

  it('runs it as typed, after one note, in a tab that is no team session yet', async () => {
    const kit = new CliHarness();
    const direct = await kit.run(['list']);
    const result = await slash(kit, 'list');
    assert.equal(result.code, direct.code);
    assert.deepEqual(result.stdout, ['This tab is no team session yet, so it runs without --session; /teamrig inbox read --session <you> binds it.', ...direct.stdout]);
  });

  it('runs it as typed, with no note, outside any team', async () => {
    const kit = new CliHarness(TEAM, null);
    const direct = await kit.run(['list']);
    assert.deepEqual(await slash(kit, 'list'), direct);
  });

  it('runs it as typed in a team whose config cannot be loaded', async () => {
    const kit = new CliHarness(null);
    const direct = await kit.run(['list'], ALPHA_TAB);
    assert.deepEqual(await slash(kit, 'list', ALPHA_TAB), direct);
  });

  it("reads the tab's team even after the tab moved into another team's project", async () => {
    const kit = new CliHarness();
    const other = resolve('/', 'work', 'other');
    await kit.files.write(resolve(other, '.teamrig.json'), '{"team": "other"}');
    const tab: RunOptions = { cwd: other, env: { CLAUDE_PROJECT_DIR: APP } };
    const direct = await kit.run(['who'], { env: { CLAUDE_PROJECT_DIR: APP } });
    assert.equal(direct.code, EXIT.ok);
    assert.deepEqual(await slash(kit, 'who', tab), direct);
  });

  it('runs a command that takes no --session as typed', async () => {
    const kit = new CliHarness();
    assert.deepEqual(await slash(kit, 'who', ALPHA_TAB), await kit.run(['who'], ALPHA_TAB));
  });

  it('runs from any origin, another session or claude -p included', async () => {
    const kit = new CliHarness();
    const direct = await kit.run(['inbox', 'status', '--session', 'alpha'], ALPHA_TAB);
    for (const origin of ['peer', 'sdk', 'channel']) {
      assert.deepEqual((await slash(kit, 'inbox status', ALPHA_TAB, { origin })).stdout, ["--session alpha (this tab's session)", ...direct.stdout]);
    }
    assert.deepEqual(await slash(kit, 'who', ALPHA_TAB, {}), await kit.run(['who'], ALPHA_TAB));
  });
});

describe('/teamrig with a command that changes the team files', () => {
  it('prints the line with the tab session and exits 4 instead of running it', async () => {
    const kit = new CliHarness();
    await kit.run(['inbox', 'add', '--session', 'bravo', '--to', 'alpha', '--text', 'hello']);
    const result = await slash(kit, 'inbox read', ALPHA_TAB);
    assert.equal(result.code, EXIT.ask);
    assert.deepEqual(result.stdout, ['teamrig inbox read --session alpha']);
    assert.match((await kit.run(['inbox', 'status', '--session', 'alpha'])).stdout.join('\n'), /alpha\s+1/);
  });

  it('runs that line once the person agreed to it, saying whose session it runs as', async () => {
    const kit = new CliHarness();
    await kit.run(['inbox', 'add', '--session', 'bravo', '--to', 'alpha', '--text', 'hello there']);
    const result = await slash(kit, 'inbox read', ALPHA_TAB, { origin: 'composer', agreed: 'teamrig inbox read --session alpha' });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.equal(result.stdout[0], "--session alpha (this tab's session)");
    assert.ok(result.stdout.join('\n').includes('hello there'));
  });

  it('asks again, running nothing, when the agreed line is not the one it would run now', async () => {
    const kit = new CliHarness();
    const result = await slash(kit, 'inbox read', ALPHA_TAB, { origin: 'composer', agreed: 'teamrig inbox read --session bravo' });
    assert.equal(result.code, EXIT.ask);
    assert.deepEqual(result.stdout, ['teamrig inbox read --session alpha']);
  });

  it('shows a quoted word and a command line after -- as they will run', async () => {
    const result = await slash(new CliHarness(), 'test -- echo "two words"', ALPHA_TAB);
    assert.equal(result.code, EXIT.ask);
    assert.deepEqual(result.stdout, ['teamrig test --session alpha -- echo "two words"']);
  });

  it('runs it as typed with --session, a quoted text kept as one word', async () => {
    const kit = new CliHarness();
    const sent = await slash(kit, 'inbox add --session alpha --to bravo --text "two words here"', ALPHA_TAB);
    assert.equal(sent.code, EXIT.ok, sent.stderr.join('\n'));
    const read = await kit.run(['inbox', 'read', '--session', 'bravo']);
    assert.ok(read.stdout.join('\n').includes('two words here'));
  });

  it('runs it through Remote Control as typed at the prompt', async () => {
    const result = await slash(new CliHarness(), 'inbox read', ALPHA_TAB, { origin: 'bridge' });
    assert.equal(result.code, EXIT.ask);
  });

  it('runs it as typed, after one note, in a tab that is no team session yet', async () => {
    const kit = new CliHarness();
    const direct = await kit.run(['inbox', 'read']);
    const result = await slash(kit, 'inbox read');
    assert.equal(result.code, direct.code);
    assert.equal(result.stdout[0], 'This tab is no team session yet, so it runs without --session; /teamrig inbox read --session <you> binds it.');
    assert.deepEqual(result.stderr, direct.stderr);
  });

  it('refuses it from another session, a channel, claude -p or an unnamed origin, and runs nothing', async () => {
    const kit = new CliHarness();
    for (const origin of ['peer', 'channel', 'sdk', 'plugin', 'unclassified']) {
      const result = await slash(kit, 'inbox add --session alpha --to bravo --text "x y"', ALPHA_TAB, { origin });
      assert.equal(result.code, EXIT.refused, origin);
      assert.match(
        result.stdout.join('\n'),
        new RegExp(`^REFUSED teamrig inbox add --session alpha --to bravo --text "x y" changes the team's files, and /teamrig runs that only when you type it in the tab; this line came from ${origin}\\.`),
      );
    }
    const unnamed = await slash(kit, 'set T1 --status done', ALPHA_TAB, {});
    assert.equal(unnamed.code, EXIT.refused);
    assert.match(unnamed.stdout.join('\n'), /this line came from an unnamed source\. Run it in a terminal instead\.$/);
    assert.deepEqual((await kit.run(['inbox', 'status', '--session', 'bravo'])).stdout, (await new CliHarness().run(['inbox', 'status', '--session', 'bravo'])).stdout);
  });
});

describe('/teamrig with a line it does not run', () => {
  it('refuses a quote that is never closed', async () => {
    const result = await slash(new CliHarness(), 'inbox add --text "open');
    assert.equal(result.code, EXIT.usage);
    assert.ok(result.stderr[0]?.startsWith('a double quote is never closed\n\n'));
  });

  it('refuses a command Claude Code runs itself', async () => {
    const result = await slash(new CliHarness(), 'hook stop', ALPHA_TAB);
    assert.equal(result.code, EXIT.usage);
    assert.ok(result.stderr[0]?.startsWith('teamrig hook stop is run by Claude Code or by teamrig itself, never from /teamrig\n\n'));
  });

  it('refuses itself, so a line never runs /teamrig again', async () => {
    const result = await slash(new CliHarness(), 'hook slash-command', ALPHA_TAB);
    assert.equal(result.code, EXIT.usage);
  });

  it('leaves a help request or a line the CLI cannot read to the CLI, from any origin', async () => {
    const kit = new CliHarness();
    for (const line of [['list', '--help'], ['nope'], ['version'], ['set', '--tier', 'p1']]) {
      assert.deepEqual(await slash(kit, line.join(' '), ALPHA_TAB, { origin: 'peer' }), await kit.run(line, ALPHA_TAB));
    }
  });

  it('takes no words of its own', async () => {
    const result = await new CliHarness().run(['hook', 'slash-command', 'extra'], { stdin: '{}' });
    assert.equal(result.code, EXIT.usage);
  });
});

describe("the mod's exit code for a line to agree to", () => {
  it('is the CLI exit code for it', () => {
    assert.equal(ASK_EXIT, EXIT.ask);
  });
});
