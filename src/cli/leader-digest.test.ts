import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, CONFIG_PATH, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { REGISTER_ONLY_LINE } from './commands/register.ts';
import { EXIT } from './runtime.ts';

const STATE = join(TEAM_HOME, 'state');
const CURSORS = join(STATE, 'leader-digest');
const HEADING = /^teamrig: register changes in your tree since your last prompt \((\d+) tasks?\):$/m;
/** A team with a sub-lead: alpha leads bravo; charlie answers to the lead. */
const SUB_LEADS: JsonRecord = { sessions: ['lead', 'alpha', 'bravo', 'charlie'], roles: { lead: 'lead' }, leads: { alpha: ['bravo'] } };

async function ok(kit: CliHarness, argv: readonly string[]): Promise<CliResult> {
  const result = await kit.run(argv);
  assert.equal(result.code, EXIT.ok, `${argv.join(' ')}: ${result.stderr.join('\n')}`);
  return result;
}

/** What the prompt hook gave the model: its plain lines, or the context of the one JSON line it prints when it titles the tab. */
function contextText(result: CliResult): string {
  const [first] = result.stdout;
  if (result.stdout.length === 1 && first !== undefined && first.startsWith('{')) {
    const parsed: unknown = JSON.parse(first);
    const output = isRecord(parsed) ? parsed['hookSpecificOutput'] : undefined;
    const context = isRecord(output) ? output['additionalContext'] : undefined;
    return typeof context === 'string' ? context : '';
  }
  return result.stdout.join('\n');
}

async function prompt(kit: CliHarness, session: string): Promise<string> {
  const stdin = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  const result = await kit.run(['hook', 'inbox-reminder'], { env: { TEAMRIG_SESSION: session }, stdin });
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return contextText(result);
}

/** The digest's task lines, `- T<n> ...` each. */
function digestRows(text: string): string[] {
  return text.split('\n').filter((line) => /^- T\d+ /.test(line));
}

async function addTask(kit: CliHarness, session: string, title: string): Promise<void> {
  await ok(kit, ['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--session', session]);
  kit.clock.advance(1_000);
}

describe('the leader digest at UserPromptSubmit', () => {
  it("shows a member's register-only change to the lead at its next prompt, once, after a silent first prompt", async () => {
    const kit = new CliHarness(TEAM);
    assert.doesNotMatch(await prompt(kit, 'lead'), HEADING, 'the first prompt only sets the cursor');
    assert.ok(kit.files.paths().includes(join(CURSORS, 'lead.json')));
    kit.clock.advance(1_000);
    await addTask(kit, 'alpha', 'Ship the signup page');
    await ok(kit, ['set', 'T1', '--status', 'in-progress', '--note', 'spec written;   wave 1\nof 3 running', '--session', 'alpha']);
    const shown = await prompt(kit, 'lead');
    assert.match(shown, HEADING);
    assert.deepEqual(digestRows(shown), ['- T1 new -> in-progress: spec written; wave 1 of 3 running']);
    assert.doesNotMatch(await prompt(kit, 'lead'), HEADING, 'a change shows once');
  });

  it('shows a change written in the very millisecond the cursor was set, once', async () => {
    const kit = new CliHarness(TEAM);
    await ok(kit, ['add', '--title', 'Ship the signup page', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    await prompt(kit, 'lead');
    // The clock has not moved: this event shares the instant of the one the cursor was set at.
    await ok(kit, ['update', 'T1', '--note', 'the form is in', '--session', 'alpha']);
    assert.deepEqual(digestRows(await prompt(kit, 'lead')), ['- T1 open: the form is in']);
    assert.doesNotMatch(await prompt(kit, 'lead'), HEADING);
  });

  it('dedupes to one line per task: its net status change and its newest note, cut to 80 characters', async () => {
    const kit = new CliHarness(TEAM);
    await addTask(kit, 'alpha', 'Ship the signup page');
    await addTask(kit, 'bravo', 'Fix the login flake');
    await prompt(kit, 'lead');
    kit.clock.advance(1_000);
    await ok(kit, ['set', 'T1', '--status', 'in-progress', '--note', 'started', '--session', 'alpha']);
    kit.clock.advance(1_000);
    await ok(kit, ['update', 'T1', '--note', 'wave 1 landed', '--session', 'alpha']);
    kit.clock.advance(1_000);
    const long = `${'x'.repeat(90)} end`;
    await ok(kit, ['update', 'T2', '--note', long, '--session', 'bravo']);
    kit.clock.advance(1_000);
    await ok(kit, ['update', 'T1', '--note', 'wave 2 landed', '--session', 'alpha']);
    const rows = digestRows(await prompt(kit, 'lead'));
    assert.deepEqual(rows, ['- T1 open -> in-progress: wave 2 landed', `- T2 open: ${'x'.repeat(77)}...`], 'newest change first');
  });

  it('caps the digest at 10 lines and counts the rest on one line', async () => {
    const kit = new CliHarness(TEAM);
    await prompt(kit, 'lead');
    kit.clock.advance(1_000);
    for (let n = 1; n <= 12; n += 1) {
      await addTask(kit, 'alpha', `Task number ${n}`);
    }
    const shown = await prompt(kit, 'lead');
    assert.match(shown, /\(12 tasks\):/);
    const rows = digestRows(shown);
    assert.equal(rows.length, 10);
    assert.equal(rows[0], '- T12 new -> open: Task number 12');
    assert.equal(rows[9], '- T3 new -> open: Task number 3');
    assert.match(shown, /^\.\.\.\(\+2 more: teamrig list\)$/m);
  });

  it("leaves out the leader's own writes, and a task of its tree it alone changed", async () => {
    const kit = new CliHarness(TEAM);
    await prompt(kit, 'lead');
    kit.clock.advance(1_000);
    await ok(kit, ['add', '--title', 'Ship the signup page', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
    kit.clock.advance(1_000);
    assert.doesNotMatch(await prompt(kit, 'lead'), HEADING);
    await ok(kit, ['update', 'T1', '--note', 'on it', '--session', 'alpha']);
    assert.deepEqual(digestRows(await prompt(kit, 'lead')), ['- T1 open: on it']);
  });

  it('goes to leaders only: a sub-lead sees its own group, the lead its whole tree, a member nothing and no cursor', async () => {
    const kit = new CliHarness(SUB_LEADS);
    for (const session of ['lead', 'alpha', 'bravo', 'charlie']) {
      assert.doesNotMatch(await prompt(kit, session), HEADING);
    }
    kit.clock.advance(1_000);
    await addTask(kit, 'bravo', 'Bravo work');
    await addTask(kit, 'charlie', 'Charlie work');
    const alpha = digestRows(await prompt(kit, 'alpha'));
    assert.deepEqual(alpha, ['- T1 new -> open: Bravo work'], "the sub-lead sees its member's task alone");
    assert.deepEqual(digestRows(await prompt(kit, 'lead')), ['- T2 new -> open: Charlie work', '- T1 new -> open: Bravo work']);
    for (const member of ['bravo', 'charlie']) {
      assert.doesNotMatch(await prompt(kit, member), HEADING, `${member} is shown nothing`);
      assert.ok(!kit.files.paths().includes(join(CURSORS, `${member}.json`)), `${member} gets no cursor`);
    }
  });

  it("withholds a note that matches one of the team's secret patterns, even one added after the note was written", async () => {
    const kit = new CliHarness(TEAM);
    await addTask(kit, 'alpha', 'Ship the signup page');
    await prompt(kit, 'lead');
    kit.clock.advance(1_000);
    await ok(kit, ['update', 'T1', '--note', 'staging pass is zebra-4242', '--session', 'alpha']);
    await kit.files.write(CONFIG_PATH, JSON.stringify({ ...TEAM, register: { secretPatterns: ['zebra-\\d+'] } }));
    const shown = await prompt(kit, 'lead');
    assert.deepEqual(digestRows(shown), ['- T1 open: (note withheld: it matches a secret shape)']);
    assert.ok(!shown.includes('zebra'));
  });

  it('never wakes anyone: it posts no inbox line and asks no wake', async () => {
    const kit = new CliHarness(TEAM);
    await prompt(kit, 'lead');
    kit.clock.advance(1_000);
    await addTask(kit, 'alpha', 'Ship the signup page');
    await ok(kit, ['update', 'T1', '--note', 'started', '--session', 'alpha']);
    const before = kit.files.paths().filter((path) => path.startsWith(join(STATE, 'inbox')) || path.startsWith(join(STATE, 'wake-asks')));
    const inboxes = before.map((path) => kit.files.get(path));
    assert.match(await prompt(kit, 'lead'), HEADING);
    const after = kit.files.paths().filter((path) => path.startsWith(join(STATE, 'inbox')) || path.startsWith(join(STATE, 'wake-asks')));
    assert.deepEqual(after, before, 'no inbox and no wake ask was added');
    assert.deepEqual(
      after.map((path) => kit.files.get(path)),
      inboxes,
      'no inbox line was posted',
    );
    assert.ok(!after.some((path) => path.startsWith(join(STATE, 'wake-asks'))));
  });
});

describe('register-only wording on set and update', () => {
  it("says NOTED for a member's note that told no leader, and not for one that told the lead or for the lead's own", async () => {
    const kit = new CliHarness(TEAM);
    await addTask(kit, 'alpha', 'Ship the signup page');
    const started = await ok(kit, ['set', 'T1', '--status', 'in-progress', '--note', 'started', '--session', 'alpha']);
    assert.match(started.stdout[0] ?? '', /^SET T1 /, 'the task line stays the one stdout line');
    assert.deepEqual(started.stderr, [REGISTER_ONLY_LINE]);
    assert.deepEqual((await ok(kit, ['update', 'T1', '--note', 'wave 1 landed', '--session', 'alpha'])).stderr, [REGISTER_ONLY_LINE]);
    assert.deepEqual((await ok(kit, ['update', 'T1', '--priority', 'p1', '--session', 'alpha'])).stderr, [], 'no note, no NOTED');
    const asked = await ok(kit, ['set', 'T1', '--status', 'waiting', '--waits', 'decision:lead', '--note', 'which signup flow', '--session', 'alpha']);
    assert.ok(!asked.stderr.includes(REGISTER_ONLY_LINE), 'a wait on the lead tells the lead');
    assert.deepEqual((await ok(kit, ['update', 'T1', '--note', 'the lead looked', '--session', 'lead'])).stderr, [], "the lead's own note");
  });

  it('pins the wording', () => {
    assert.equal(REGISTER_ONLY_LINE, 'NOTED in the register (the lead sees it at its next prompt)');
  });
});
