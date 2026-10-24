import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, EVENTS_PATH, TEAM, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { promptLine, replyLine, resultsLine, transcript, type FixtureTool } from '../testing/transcript-lines.ts';

const AT = '2030-01-08T10:00:00.000Z';
const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);
const EDIT: FixtureTool = { id: 'last', name: 'Edit', path: join(APP, 'src', 'a.ts') };
const AS_LEAD = { TEAMRIG_SESSION: 'lead' };

/** The kit with its transcript holding one turn, started by `prompt`, ending with `last`. */
async function withTurn(kit: CliHarness, last: FixtureTool, prompt = 'go'): Promise<CliHarness> {
  const reply = replyLine({ id: 'm1', requestId: 'r1', at: AT, usage: { cacheRead: 100_000 }, tools: [last] });
  await kit.files.write(TRANSCRIPT, transcript([promptLine(AT, prompt), reply, resultsLine(AT, [{ id: last.id, text: 'ok' }])]));
  return kit;
}

/** A team whose transcript holds one turn, started by `prompt`, ending with `last`. */
function teamWith(last: FixtureTool, config: JsonRecord = TEAM, prompt = 'go'): Promise<CliHarness> {
  return withTurn(new CliHarness(config), last, prompt);
}

/** The loop-nudge hook after `tool`, over `files` when given (such as a `FaultyFiles` over the kit's). */
function afterTool(kit: CliHarness, tool: FixtureTool, env: Readonly<Record<string, string>>, files?: Files): Promise<CliResult> {
  const stdin = JSON.stringify({
    session_id: CLAUDE_SESSION,
    cwd: APP,
    transcript_path: TRANSCRIPT,
    tool_name: tool.name,
    tool_use_id: tool.id,
    tool_input: { ...(tool.path === undefined ? {} : { file_path: tool.path }), ...(tool.url === undefined ? {} : { url: tool.url }) },
  });
  return kit.run(['hook', 'loop-nudge'], { stdin, env, ...(files === undefined ? {} : { files }) });
}

describe('the lead boundary hooks', () => {
  it('hand the lead one line at its first edit outside its own files, and nothing to another session', async () => {
    const kit = await teamWith(EDIT);
    assert.match((await afterTool(kit, EDIT, AS_LEAD)).stdout.join(''), /teamrig: the lead edited a\.ts itself\. The lead hands such work/);
    assert.deepEqual((await afterTool(kit, EDIT, { TEAMRIG_SESSION: 'alpha' })).stdout, []);
  });

  it('leave the lead own paths alone, and stay quiet with leadBoundary off', async () => {
    const own: FixtureTool = { id: 'last', name: 'Write', path: join(USER_HOME, 'ops', 'lead', 'agenda.md') };
    const config = { ...TEAM, leadBoundary: { ownPaths: ['~/ops/lead'] } };
    assert.deepEqual((await afterTool(await teamWith(own, config), own, AS_LEAD)).stdout, []);
    const temp = join(USER_HOME, 'temp');
    const scratch: FixtureTool = { id: 'last', name: 'Write', path: join(temp, 'claude', 'work-app', 'old-session', 'scratchpad', 'lead-tasks.tsv') };
    const inTemp = { ...AS_LEAD, CLAUDE_CODE_TMPDIR: temp };
    assert.deepEqual((await afterTool(await teamWith(scratch), scratch, inTemp)).stdout, [], 'a session scratchpad is the lead own');
    const beside: FixtureTool = { ...scratch, path: join(temp, 'claude', 'work-app', 'lead-tasks.tsv') };
    assert.match((await afterTool(await teamWith(beside), beside, inTemp)).stdout.join(''), /the lead edited lead-tasks\.tsv itself/);
    const off = await teamWith(EDIT, { ...TEAM, leadBoundary: { enabled: false } });
    assert.deepEqual((await afterTool(off, EDIT, AS_LEAD)).stdout, []);
  });

  it('hand the lead one line at its first web lookup, naming the owner of the task its prompt asks about (T736)', async () => {
    const fetch: FixtureTool = { id: 'last', name: 'WebFetch', url: 'https://vendor.example/terms' };
    const kit = await teamWith(fetch, TEAM, 'The owner asks about T1: what do the vendor terms allow?');
    await kit.run(['add', '--title', 'Vendor terms', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
    assert.match(
      (await afterTool(kit, fetch, AS_LEAD)).stdout.join(''),
      /teamrig: the lead did research itself \(vendor\.example\)\. Send the question to alpha as a register task with a deadline and relay its answer \[leadBoundary\]\./,
    );
    assert.deepEqual((await afterTool(kit, fetch, { TEAMRIG_SESSION: 'alpha' })).stdout, []);
    const unnamed = await teamWith(fetch);
    assert.match((await afterTool(unnamed, fetch, AS_LEAD)).stdout.join(''), /research itself \(vendor\.example\)\. Send the question to the session that owns it/);
  });

  it('keep the research line generic when the register cannot be read (T736)', async () => {
    const fetch: FixtureTool = { id: 'last', name: 'WebFetch', url: 'https://vendor.example/terms' };
    const kit = await teamWith(fetch, TEAM, 'The owner asks about T1: what do the vendor terms allow?');
    await kit.run(['add', '--title', 'Vendor terms', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
    const unreadable = new FaultyFiles(kit.files).fail('read', EVENTS_PATH, systemError('EACCES', 'EACCES: permission denied'));
    const out = (await afterTool(kit, fetch, AS_LEAD, unreadable)).stdout.join('');
    assert.match(out, /research itself \(vendor\.example\)\. Send the question to the session that owns it/);
    assert.doesNotMatch(out, /alpha/);
  });

  it('show the owner the lead own work at the turn end, on the lead tab only', async () => {
    const kit = await teamWith(EDIT);
    const stdin = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, transcript_path: TRANSCRIPT });
    const lead = await kit.run(['hook', 'stop'], { stdin, env: AS_LEAD });
    assert.match(lead.stdout.join(''), /Lead boundary: this turn the lead did 1 edit \(a\.ts\) itself; it delegates such work \[leadBoundary\]\./);
    const alpha = await kit.run(['hook', 'stop'], { stdin, env: { TEAMRIG_SESSION: 'alpha' } });
    assert.doesNotMatch(alpha.stdout.join(''), /Lead boundary/);
  });

  it("send a lead's search of a sub-team folder to the child team's lead it hangs under, and leave its rules to the lead (T1019)", async () => {
    const notes: FixtureTool = { id: 'last', name: 'Grep', path: join(teamHomeOf('ui'), 'notes', 'pixel') };
    const kit = await withTurn(await treeHarness(), notes);
    assert.match((await afterTool(kit, notes, AS_LEAD)).stdout.join(''), /research itself \(ui\/notes\/pixel\)\. Send the question to web\/lead as a register task/);
    const stdin = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, transcript_path: TRANSCRIPT });
    assert.match((await kit.run(['hook', 'stop'], { stdin, env: AS_LEAD })).stdout.join(''), /the lead did 1 research lookup \(ui\/notes\/pixel\) itself/);
    const web = { TEAMRIG_TEAM: 'web', TEAMRIG_SESSION: 'lead' };
    assert.match((await afterTool(kit, notes, web)).stdout.join(''), /Send the question to ui\/lead as/, 'a middle lead sends it to its own child team');
    const rules: FixtureTool = { id: 'last', name: 'Edit', path: join(teamHomeOf('web'), 'rules.md') };
    assert.deepEqual((await afterTool(await withTurn(kit, rules), rules, AS_LEAD)).stdout, [], "a sub-team's rules are the parent lead's own");
  });
});
