import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord, stringField, type JsonRecord } from '../lib/guards.ts';
import { hookFile, RECORDING_FILE } from '../../src/testing/recorded.ts';
import { assemble, helperTranscript, SESSION_TRANSCRIPT, UNRECORDED_REASONS, type RawRecording } from './recording.ts';
import { Scrubber } from './scrub.ts';
import { cutStandIn } from './transcript.ts';

const SESSION_ID = '5b1f0c9e-6d2a-4e7b-9c3d-1a2b3c4d5e6f';
const PROJECT = '/rec/home/.claude/projects/-rec-base-cwd';
const SESSION_PATH = `${PROJECT}/${SESSION_ID}.jsonl`;
const HELPER_PATH = `${PROJECT}/${SESSION_ID}/subagents/agent-a1.jsonl`;
const UNWRITTEN_PATH = `${PROJECT}/${SESSION_ID}/subagents/agent-a0.jsonl`;
const SCRUBBED_ID = '00000000-0000-4000-8000-000000000001';
const SCRUBBED_PROJECT = '{{home}}/.claude/projects/{{cwd-slug}}';
const LONG = 'p'.repeat(200);

function scrubber(): Scrubber {
  return new Scrubber({ cwd: '/rec/base/cwd', temp: '/rec/base', home: '/rec/home', user: '', host: '' });
}

function input(event: string, more: JsonRecord = {}): JsonRecord {
  return { session_id: SESSION_ID, transcript_path: SESSION_PATH, cwd: '/rec/base/cwd', hook_event_name: event, ...more };
}

function scrubbedInput(event: string, more: JsonRecord = {}): JsonRecord {
  return { session_id: SCRUBBED_ID, transcript_path: `${SCRUBBED_PROJECT}/${SCRUBBED_ID}.jsonl`, cwd: '{{cwd}}', hook_event_name: event, ...more };
}

function recording(change: Partial<RawRecording> = {}): RawRecording {
  return {
    version: '2.1.329 (Claude Code)\n',
    platform: 'linux',
    model: 'haiku',
    events: ['SessionStart', 'PreToolUse', 'SubagentStop', 'PermissionRequest', 'StopFailure'],
    inputs: [
      input('SessionStart', { source: 'startup' }),
      input('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/rec/base/cwd/notes.txt' } }),
      input('SubagentStop', { agent_transcript_path: UNWRITTEN_PATH }),
      input('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo recorded-bash' } }),
      input('SubagentStop', { agent_transcript_path: HELPER_PATH }),
    ],
    session: {
      path: SESSION_PATH,
      text: `${JSON.stringify({ type: 'user', sessionId: SESSION_ID, message: { content: LONG } })}\n${JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', text: LONG } })}\n`,
    },
    helpers: [
      { path: UNWRITTEN_PATH, text: undefined },
      { path: HELPER_PATH, text: `${JSON.stringify({ type: 'assistant', cwd: '/rec/base/cwd' })}\n` },
    ],
    ...change,
  };
}

function parsed(files: Readonly<Record<string, string>>, file: string): unknown {
  return JSON.parse(files[file] ?? 'null');
}

/** The recording's own facts, which must be a JSON object. */
function factsOf(files: Readonly<Record<string, string>>): JsonRecord {
  const facts = parsed(files, RECORDING_FILE);
  assert.ok(isRecord(facts), `${RECORDING_FILE} holds no JSON object`);
  return facts;
}

describe('assemble', () => {
  it("writes each event's inputs in firing order, each written transcript and the recording's facts, all scrubbed", () => {
    const files = assemble(recording(), scrubber());
    assert.deepEqual(Object.keys(files).sort(), [
      'hooks/PreToolUse.json',
      'hooks/SessionStart.json',
      'hooks/SubagentStop.json',
      RECORDING_FILE,
      'transcripts/helper-1.jsonl',
      SESSION_TRANSCRIPT,
    ]);
    assert.deepEqual(parsed(files, hookFile('SessionStart')), [scrubbedInput('SessionStart', { source: 'startup' })]);
    assert.deepEqual(parsed(files, hookFile('PreToolUse')), [
      scrubbedInput('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '{{cwd}}/notes.txt' } }),
      scrubbedInput('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo recorded-bash' } }),
    ]);
    assert.deepEqual(parsed(files, hookFile('SubagentStop')), [
      scrubbedInput('SubagentStop', { agent_transcript_path: `${SCRUBBED_PROJECT}/${SCRUBBED_ID}/subagents/agent-a0.jsonl` }),
      scrubbedInput('SubagentStop', { agent_transcript_path: `${SCRUBBED_PROJECT}/${SCRUBBED_ID}/subagents/agent-a1.jsonl` }),
    ]);
    assert.equal(
      files[SESSION_TRANSCRIPT],
      `${JSON.stringify({ type: 'user', sessionId: SCRUBBED_ID, message: { content: LONG } })}\n${JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', text: cutStandIn(200) } })}\n`,
    );
    assert.equal(files[helperTranscript(1)], `${JSON.stringify({ type: 'assistant', cwd: '{{cwd}}' })}\n`);
    assert.deepEqual(parsed(files, RECORDING_FILE), {
      host: 'claude-code',
      version: '2.1.329',
      platform: 'linux',
      model: 'haiku',
      recorded: { SessionStart: 1, PreToolUse: 2, SubagentStop: 2 },
      order: ['SessionStart', 'PreToolUse', 'SubagentStop', 'PreToolUse', 'SubagentStop'],
      notRecorded: { PermissionRequest: UNRECORDED_REASONS['PermissionRequest'], StopFailure: UNRECORDED_REASONS['StopFailure'] },
      transcripts: {
        [SESSION_TRANSCRIPT]: `${SCRUBBED_PROJECT}/${SCRUBBED_ID}.jsonl`,
        'transcripts/helper-1.jsonl': `${SCRUBBED_PROJECT}/${SCRUBBED_ID}/subagents/agent-a1.jsonl`,
      },
      cut: { [SESSION_TRANSCRIPT]: 1, 'transcripts/helper-1.jsonl': 0 },
      unwritten: [`${SCRUBBED_PROJECT}/${SCRUBBED_ID}/subagents/agent-a0.jsonl`],
    });
    for (const [file, text] of Object.entries(files)) {
      assert.ok(text.endsWith('\n'), file);
    }
  });

  it('records an event that has a reason not to fire when it fires anyway', () => {
    const base = recording();
    const files = assemble({ ...base, inputs: [...base.inputs, input('PermissionRequest', { tool_name: 'Bash' })] }, scrubber());
    assert.deepEqual(parsed(files, hookFile('PermissionRequest')), [scrubbedInput('PermissionRequest', { tool_name: 'Bash' })]);
    const facts = factsOf(files);
    assert.deepEqual(facts, {
      ...facts,
      recorded: { SessionStart: 1, PreToolUse: 2, SubagentStop: 2, PermissionRequest: 1 },
      order: ['SessionStart', 'PreToolUse', 'SubagentStop', 'PreToolUse', 'SubagentStop', 'PermissionRequest'],
      notRecorded: { StopFailure: UNRECORDED_REASONS['StopFailure'] },
    });
  });

  it('keeps what the version line says when it holds no version number', () => {
    assert.equal(stringField(factsOf(assemble(recording({ version: ' dev build \n' }), scrubber())), 'version'), 'dev build');
  });

  it('refuses a hook input that names no event', () => {
    assert.throws(() => assemble(recording({ inputs: [{ session_id: SESSION_ID, cwd: '/rec/base/cwd' }] }), scrubber()), {
      message: 'a hook input names no event: ["session_id","cwd"]',
    });
  });

  it('refuses a recording that lacks a wired event with no reason for it', () => {
    assert.throws(() => assemble(recording({ events: ['SessionStart', 'Notification', 'StopFailure', 'Stop'] }), scrubber()), {
      message: 'no input was recorded for Notification, Stop, and nothing says why',
    });
  });

  it('refuses a recording whose scrubbed files still hold what the repository scrub refuses, naming each place', () => {
    const base = recording();
    // Built here, so this file holds no address the repository scrub would refuse.
    const address = ['10', '20', '30', '40'].join('.');
    const leaking = { ...base, inputs: [...base.inputs, input('PreToolUse', { tool_name: 'Bash', tool_input: { command: `ping ${address}` } })] };
    assert.throws(
      () => assemble(leaking, scrubber()),
      /^Error: the scrubbed recording still holds private data:\nhooks\/PreToolUse\.json:\d+:\d+ ipv4: IPv4 address outside the loopback and documentation ranges "10\."\.\.\. \(11 chars\)$/,
    );
  });
});
