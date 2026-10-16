import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP, CLAUDE_SESSION, CliHarness, SKILLS_DIR, TEAM, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { promptLine, replyLine, resultsLine, transcript } from '../testing/transcript-lines.ts';

const AT = '2030-01-08T10:00:00.000Z';
const SKILL = join(SKILLS_DIR, 'alpha-ship', 'SKILL.md');
const SESSION_TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);
const HELPER_TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', CLAUDE_SESSION, 'subagents', 'agent-a1.jsonl');
const NOT_FOUND = '<tool_use_error>String to replace not found in file.\nString: Last verified: 2030-01-08 (T12: the build passed</tool_use_error>';
const REASON =
  `teamrig: a skill edit was refused and never redone, so the file lacks it: alpha-ship (${SKILL}: String to replace not found in file.).` +
  ' Another session may have changed the file since you read it: read it again and redo the change on its current text, or say why you dropped it.';

/** A turn that edits the skill, on the helper's or the session's thread, with the edit refused unless `redone`. */
function editTurn(sidechain: boolean, redone = false): string {
  const edit = (id: string, at: number): string[] => [
    replyLine({ id: `m${at}`, requestId: `r${at}`, at: AT, sidechain, usage: { cacheRead: 1000 }, tools: [{ id, name: 'Edit', path: SKILL }] }),
    resultsLine(AT, [{ id, text: at === 1 ? NOT_FOUND : 'ok', isError: at === 1 }], sidechain),
  ];
  return transcript([promptLine(AT, 'ship T13', sidechain), ...edit('e1', 1), ...(redone ? edit('e2', 2) : [])]);
}

function payload(extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ hook_event_name: 'SubagentStop', session_id: CLAUDE_SESSION, cwd: APP, transcript_path: SESSION_TRANSCRIPT, agent_transcript_path: HELPER_TRANSCRIPT, stop_hook_active: false, ...extra });
}

async function helperStop(kit: CliHarness, stdin = payload()): Promise<CliResult> {
  return kit.run(['hook', 'subagent-stop'], { stdin });
}

async function kitWith(path: string, text: string, kit = new CliHarness(TEAM)): Promise<CliHarness> {
  await kit.files.write(path, text);
  return kit;
}

describe('the subagent-stop hook', () => {
  it('sends a helper back once to a skill edit Claude Code refused that it handed back without redoing', async () => {
    const kit = await kitWith(HELPER_TRANSCRIPT, editTurn(true));
    const first = await helperStop(kit);
    assert.equal(first.code, 0);
    assert.deepEqual(JSON.parse(first.stdout.join('')), { decision: 'block', reason: REASON });
    assert.deepEqual((await helperStop(kit, payload({ stop_hook_active: true }))).stdout, []);
  });

  it('lets a helper go that redid the edit', async () => {
    assert.deepEqual((await helperStop(await kitWith(HELPER_TRANSCRIPT, editTurn(true, true)))).stdout, []);
  });

  it('prints nothing outside a team, without the helper transcript, for bad input or when the transcript cannot be read', async () => {
    assert.deepEqual((await helperStop(await kitWith(HELPER_TRANSCRIPT, editTurn(true), new CliHarness(TEAM, null)))).stdout, []);
    const kit = await kitWith(HELPER_TRANSCRIPT, editTurn(true));
    assert.deepEqual((await helperStop(kit, payload({ agent_transcript_path: undefined }))).stdout, []);
    assert.deepEqual((await helperStop(new CliHarness(TEAM))).stdout, []);
    assert.deepEqual((await helperStop(kit, 'not json')).stdout, []);
    const failing = await kit.run(['hook', 'subagent-stop'], { stdin: payload(), files: new FaultyFiles(kit.files).fail('readTail', HELPER_TRANSCRIPT, systemError('EIO')) });
    assert.equal(failing.code, 0);
    assert.deepEqual(failing.stdout, []);
  });
});

describe('the stop hook on a dropped skill edit', () => {
  const stdin = (active: boolean): string => JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, transcript_path: SESSION_TRANSCRIPT, stop_hook_active: active });
  const env = { TEAMRIG_SESSION: 'alpha' };

  it("sends the session back once to its turn's refused skill edit, before anything else the turn end says", async () => {
    const kit = await kitWith(SESSION_TRANSCRIPT, editTurn(false));
    assert.deepEqual(JSON.parse((await kit.run(['hook', 'stop'], { stdin: stdin(false), env })).stdout.join('')), { decision: 'block', reason: REASON });
    assert.doesNotMatch((await kit.run(['hook', 'stop'], { stdin: stdin(true), env })).stdout.join(''), /refused/);
  });

  it("leaves a turn whose edit was redone, and a helper's refusal, to the rest of the turn end", async () => {
    const redone = await kitWith(SESSION_TRANSCRIPT, editTurn(false, true));
    assert.doesNotMatch((await redone.run(['hook', 'stop'], { stdin: stdin(false), env })).stdout.join(''), /refused/);
    const sidechain = await kitWith(SESSION_TRANSCRIPT, editTurn(true));
    assert.doesNotMatch((await sidechain.run(['hook', 'stop'], { stdin: stdin(false), env })).stdout.join(''), /refused/);
  });
});
