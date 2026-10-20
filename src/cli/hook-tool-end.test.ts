import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import { TOOL_END_WRITE_MS, type RestoreEntry } from '../restore/entry.ts';
import { RestoreRegistry, restoreSessionsDir } from '../restore/registry.ts';
import { TAB_CIRCLES } from '../tabs/status.ts';
import { APP, CLAUDE_SESSION, CliHarness, KIT, TEAM, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { promptLine, transcript } from '../testing/transcript-lines.ts';
import { EXIT } from './runtime.ts';

const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);
const ENTRY_FILE = join(restoreSessionsDir(KIT), `${CLAUDE_SESSION}.json`);
const ON_TEAM: JsonRecord = { ...TEAM, tabStatus: { enabled: true } };
const TITLE_OFF = { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1', CLAUDE_PROJECT_DIR: APP };

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
