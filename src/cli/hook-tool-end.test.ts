import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { inboxLineOf } from '../inbox/inbox.ts';
import { lineHash } from '../inbox/line-hash.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import { TOOL_END_WRITE_MS, type RestoreEntry } from '../restore/entry.ts';
import { RestoreRegistry, restoreSessionsDir } from '../restore/registry.ts';
import { TAB_CIRCLES } from '../tabs/status.ts';
import { APP, CLAUDE_SESSION, CliHarness, KIT, TEAM, TEAM_HOME, titledPromptOf, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { holdFileLock } from '../testing/held-file-lock.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { promptLine, transcript } from '../testing/transcript-lines.ts';
import { WakeAsks } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);
const ENTRY_FILE = join(restoreSessionsDir(KIT), `${CLAUDE_SESSION}.json`);
const ON_TEAM: JsonRecord = { ...TEAM, tabStatus: { enabled: true } };
const TITLE_OFF = { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1', CLAUDE_PROJECT_DIR: APP };
const TITLE_ON = { CLAUDE_PROJECT_DIR: APP };
const ASKS = join(TEAM_HOME, 'state', 'wake-asks');
const ALPHA_LOCK = join(TEAM_HOME, 'state', 'wake', 'alpha.lock');
const NO_OUTPUT: CliResult = { code: EXIT.ok, stdout: [], stderr: [] };

async function teamWith(config: JsonRecord = ON_TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await kit.files.write(TRANSCRIPT, transcript([promptLine('2030-01-08T09:50:00.000Z', 'fix the build')]));
  return kit;
}

function payload(event: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: event, session_id: CLAUDE_SESSION, cwd: APP, transcript_path: TRANSCRIPT, ...fields });
}

const BASH_END = payload('PostToolUse', { tool_name: 'Bash' });

/** The title the hook's one JSON line sets, or undefined when it printed none. */
function titleOf(result: CliResult): string | undefined {
  assert.equal(result.code, EXIT.ok);
  const [line] = result.stdout;
  const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
  const sequence = typeof parsed === 'object' && parsed !== null && 'terminalSequence' in parsed ? parsed.terminalSequence : undefined;
  return typeof sequence === 'string' ? /^\u001b\]0;(.*)\u0007$/su.exec(sequence)?.[1] : undefined;
}

async function entryOf(kit: CliHarness): Promise<RestoreEntry | undefined> {
  return new RestoreRegistry(kit.files, restoreSessionsDir(KIT)).read(CLAUDE_SESSION);
}

/** The lines the hook's one JSON object hands the model and the event it names them for; undefined when it hands none. */
function linesOf(result: CliResult): { readonly event: unknown; readonly lines: string } | undefined {
  assert.equal(result.code, EXIT.ok);
  const [line] = result.stdout;
  const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
  const output = isRecord(parsed) ? parsed['hookSpecificOutput'] : undefined;
  return isRecord(output) && typeof output['additionalContext'] === 'string' ? { event: output['hookEventName'], lines: output['additionalContext'] } : undefined;
}

/** A team whose `alpha` read its inbox from this tab, so the tab is alpha, then got a line from bravo; `wake`: a `--wake now` one. */
async function alphaWithLine(wake: boolean, config: JsonRecord = ON_TEAM): Promise<CliHarness> {
  const kit = await teamWith(config);
  await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  const posted = await kit.run(['inbox', 'add', '--to', 'alpha', '--text', 'the api is ready', ...(wake ? ['--wake', 'now'] : []), '--session', 'bravo']);
  assert.equal(posted.code, EXIT.ok);
  return kit;
}

function asksOf(kit: CliHarness): Promise<readonly unknown[]> {
  return new WakeAsks(kit.files, ASKS).read('alpha');
}

const PROMPT = JSON.stringify({ cwd: APP, session_id: CLAUDE_SESSION });
const LINE = /^INBOX alpha, new in .*\n- 2030-01-08 10:00 UTC bravo: the api is ready$/;

describe('hook tool-end', () => {
  it("titles the tab working and records the session's entry, from one payload", async () => {
    const kit = await teamWith();
    assert.equal(titleOf(await kit.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_OFF })), `${TAB_CIRCLES.working} fix the build`);
    const entry = await entryOf(kit);
    assert.deepEqual([entry?.state, entry?.updatedAt, entry?.projectDir], ['working', kit.clock.now(), APP]);
  });

  it('writes the entry again only once TOOL_END_WRITE_MS passed, at a failed tool too', async () => {
    const kit = await teamWith();
    await kit.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_OFF });
    const first = kit.clock.now();
    kit.clock.advance(TOOL_END_WRITE_MS - MS_PER_MINUTE);
    await kit.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_OFF });
    assert.equal((await entryOf(kit))?.updatedAt, first);
    kit.clock.advance(MS_PER_MINUTE);
    await kit.run(['hook', 'tool-end'], { stdin: payload('PostToolUseFailure', { tool_name: 'Bash', error: 'exit 1' }), env: TITLE_OFF });
    assert.equal((await entryOf(kit))?.updatedAt, kit.clock.now());
  });

  it("keeps a ready session ready at a helper's tool end, which runs on past the turn's end", async () => {
    const kit = await teamWith();
    await kit.run(['hook', 'restore-track'], { stdin: payload('Stop', { stop_hook_active: false }), env: TITLE_OFF });
    kit.clock.advance(TOOL_END_WRITE_MS);
    await kit.run(['hook', 'tool-end'], { stdin: payload('PostToolUse', { tool_name: 'Read', agent_id: 'a1' }), env: TITLE_OFF });
    const entry = await entryOf(kit);
    assert.deepEqual([entry?.state, entry?.updatedAt], ['ready', kit.clock.now()]);
  });

  it("records the session but prints nothing with Claude Code's own title on, tab status off or outside a team", async () => {
    for (const [kit, env] of [
      [await teamWith(), { CLAUDE_PROJECT_DIR: APP }],
      [await teamWith(TEAM), TITLE_OFF],
      [new CliHarness(ON_TEAM, null), TITLE_OFF],
    ] as const) {
      assert.deepEqual(await kit.run(['hook', 'tool-end'], { stdin: BASH_END, env }), { code: EXIT.ok, stdout: [], stderr: [] });
      assert.equal((await entryOf(kit))?.state, 'working');
    }
  });

  it('does each part when the other fails, and nothing for input that is no payload', async () => {
    const kit = await teamWith();
    const noEntry = new FaultyFiles(kit.files).fail('write', ENTRY_FILE, systemError('EACCES'));
    assert.equal(titleOf(await kit.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_OFF, files: noEntry })), `${TAB_CIRCLES.working} fix the build`);
    assert.equal(await entryOf(kit), undefined);
    const noTranscript = new FaultyFiles(kit.files).fail('readTail', TRANSCRIPT, systemError('EACCES'));
    assert.deepEqual(await kit.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_OFF, files: noTranscript }), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.equal((await entryOf(kit))?.state, 'working');
    const other = await teamWith();
    assert.deepEqual(await other.run(['hook', 'tool-end'], { stdin: 'not json', env: TITLE_OFF }), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.equal(await entryOf(other), undefined);
  });
});

describe('hook tool-end: a busy session sees its --wake now lines', () => {
  it('hands the model the new lines once, with the title in the same object, and takes the ask', async () => {
    const kit = await alphaWithLine(true);
    const result = await kit.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_OFF });
    assert.equal(result.stdout.length, 1);
    assert.equal(titleOf(result), `${TAB_CIRCLES.working} fix the build`);
    assert.equal(linesOf(result)?.event, 'PostToolUse');
    assert.match(linesOf(result)?.lines ?? '', LINE);
    assert.deepEqual(await asksOf(kit), [], 'the wake check does not wake the tab for a line it saw');
    assert.equal(linesOf(await kit.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_ON })), undefined);
    assert.equal(titledPromptOf(await kit.run(['hook', 'inbox-reminder'], { stdin: PROMPT })).context, undefined, 'recorded as shown: the prompt hook does not repeat it');
  });

  it("names a failed tool's event, and takes a damaged ask with the valid ones", async () => {
    const kit = await alphaWithLine(true);
    await kit.files.write(join(ASKS, 'alpha', '1-0.json'), 'not an ask');
    const result = await kit.run(['hook', 'tool-end'], { stdin: payload('PostToolUseFailure', { tool_name: 'Bash', error: 'exit 1' }), env: TITLE_ON });
    assert.equal(titleOf(result), undefined);
    assert.equal(linesOf(result)?.event, 'PostToolUseFailure');
    assert.deepEqual(await asksOf(kit), []);
  });

  it("leaves the ask to the wake check at a helper's tool end and while a check holds the session's wake lock", async () => {
    for (const [stdin, locked] of [
      [payload('PostToolUse', { tool_name: 'Read', agent_id: 'a1' }), false],
      [BASH_END, true],
    ] as const) {
      const kit = await alphaWithLine(true);
      if (locked) {
        await holdFileLock(kit, ALPHA_LOCK);
      }
      assert.deepEqual(await kit.run(['hook', 'tool-end'], { stdin, env: TITLE_ON }), NO_OUTPUT);
      assert.equal((await asksOf(kit)).length, 1);
    }
  });

  it('hands nothing for a line without an ask, which the next prompt shows, nor with wake.enabled false', async () => {
    const plain = await alphaWithLine(false);
    assert.deepEqual(await plain.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_ON }), NO_OUTPUT);
    assert.match(titledPromptOf(await plain.run(['hook', 'inbox-reminder'], { stdin: PROMPT })).context ?? '', LINE);
    const off = await alphaWithLine(false, { ...ON_TEAM, wake: { enabled: false } });
    await new WakeAsks(off.files, ASKS).post('alpha', { from: 'bravo', text: 'the api is ready', at: off.clock.now() });
    assert.deepEqual(await off.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_ON }), NO_OUTPUT);
  });

  it('takes a --wake-by ask only from its time, and drops it without a word once the session saw its line', async () => {
    for (const seen of [false, true]) {
      const kit = await alphaWithLine(false);
      const at = kit.clock.now();
      const line = lineHash(inboxLineOf(new Date(at), 'bravo', 'the api is ready'));
      await new WakeAsks(kit.files, ASKS).post('alpha', { from: 'bravo', text: 'the api is ready', at, by: { at: at + 10 * MS_PER_MINUTE, line } });
      assert.deepEqual(await kit.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_ON }), NO_OUTPUT);
      assert.equal((await asksOf(kit)).length, 1, 'held until its time');
      if (seen) {
        assert.match(titledPromptOf(await kit.run(['hook', 'inbox-reminder'], { stdin: PROMPT })).context ?? '', LINE);
      }
      kit.clock.advance(10 * MS_PER_MINUTE);
      const result = await kit.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_ON });
      assert.match(linesOf(result)?.lines ?? '', seen ? /^$/ : LINE, `seen: ${seen}`);
      assert.deepEqual(await asksOf(kit), [], `seen: ${seen}`);
    }
  });

  it('still titles the tab when reading the asks fails', async () => {
    const kit = await alphaWithLine(true);
    const files = new FaultyFiles(kit.files).fail('list', join(ASKS, 'alpha'), systemError('EACCES'));
    const result = await kit.run(['hook', 'tool-end'], { stdin: BASH_END, env: TITLE_OFF, files });
    assert.equal(titleOf(result), `${TAB_CIRCLES.working} fix the build`);
    assert.equal(linesOf(result), undefined);
    assert.equal((await asksOf(kit)).length, 1);
  });
});
