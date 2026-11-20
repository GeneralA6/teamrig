import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stringField } from '../core/guards.ts';
import { FolderNames, withStrings, type RecordedFolders } from './folder-names.ts';
import { hookFile, inputsOf, loadRecording, RECORDING_FILE, recordingOf } from './recorded.ts';

const FOLDERS: RecordedFolders = { cwd: 'D:\\rec\\cwd', temp: '/tmp', home: '/home/someone' };
const NAMES = new FolderNames(FOLDERS);
const SESSION_FILE = 'transcripts/session.jsonl';
const SESSION_PATH = '{{home}}/.claude/projects/{{cwd-slug}}/s1.jsonl';
const FILLED_SESSION_PATH = '/home/someone/.claude/projects/D--rec-cwd/s1.jsonl';

function input(event: string, more: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { session_id: 's1', transcript_path: SESSION_PATH, cwd: '{{cwd}}', hook_event_name: event, ...more };
}

const FACTS = {
  host: 'claude-code',
  version: '9.9.9',
  platform: 'win32',
  model: 'haiku',
  recorded: { SessionStart: 1, PreToolUse: 2 },
  order: ['SessionStart', 'PreToolUse', 'PreToolUse'],
  notRecorded: { StopFailure: 'a recording cannot cause it' },
  transcripts: { [SESSION_FILE]: SESSION_PATH },
  cut: { [SESSION_FILE]: 0 },
  unwritten: ['{{home}}/.claude/projects/{{cwd-slug}}/s1/subagents/agent-a0.jsonl'],
};

const FILES: Readonly<Record<string, string>> = {
  [RECORDING_FILE]: JSON.stringify(FACTS),
  [hookFile('SessionStart')]: JSON.stringify([input('SessionStart', { source: 'startup' })]),
  [hookFile('PreToolUse')]: JSON.stringify([
    input('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '{{cwd}}/notes.txt' } }),
    input('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat {{temp}}/a.txt\necho done' } }),
  ]),
  [SESSION_FILE]: `${JSON.stringify({ type: 'user', cwd: '{{cwd}}' })}\n${JSON.stringify({ type: 'assistant', text: 'read {{cwd}}/notes.txt' })}\n`,
};

/** A reader of `files` with `changed` in place of some of them; a file it lacks is an error, as on disk. */
function reader(changed: Readonly<Record<string, string>> = {}): (file: string) => string {
  const files = { ...FILES, ...changed };
  return (file) => {
    const text = files[file];
    if (text === undefined) {
      throw new Error(`no file ${file}`);
    }
    return text;
  };
}

function withFacts(changed: Readonly<Record<string, unknown>>): (file: string) => string {
  return reader({ [RECORDING_FILE]: JSON.stringify({ ...FACTS, ...changed }) });
}

describe('hookFile', () => {
  it('names the fixture file of an event', () => {
    assert.equal(hookFile('PreToolUse'), 'hooks/PreToolUse.json');
  });
});

describe('recordingOf', () => {
  it('gives what recorded the session, its counts and the reasons for what it lacks', () => {
    const recording = recordingOf(reader(), NAMES);
    assert.deepEqual(
      { host: recording.host, version: recording.version, platform: recording.platform, model: recording.model },
      { host: 'claude-code', version: '9.9.9', platform: 'win32', model: 'haiku' },
    );
    assert.deepEqual(recording.recorded, { SessionStart: 1, PreToolUse: 2 });
    assert.deepEqual(recording.notRecorded, { StopFailure: 'a recording cannot cause it' });
  });

  it('gives the inputs in firing order, each with its place in its event and its folders filled', () => {
    const recording = recordingOf(reader(), NAMES);
    assert.deepEqual(
      recording.inputs.map(({ event, index }) => [event, index]),
      [
        ['SessionStart', 0],
        ['PreToolUse', 0],
        ['PreToolUse', 1],
      ],
    );
    assert.deepEqual(recording.inputs[1]?.input, {
      session_id: 's1',
      transcript_path: FILLED_SESSION_PATH,
      cwd: 'D:\\rec\\cwd',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'D:\\rec\\cwd/notes.txt' },
    });
    assert.deepEqual(recording.inputs[2]?.input['tool_input'], { command: 'cat /tmp/a.txt\necho done' });
  });

  it('gives each transcript its path and its lines, filled line by line, and the paths nothing was written to', () => {
    const recording = recordingOf(reader(), NAMES);
    assert.deepEqual(recording.transcripts, [
      {
        file: SESSION_FILE,
        path: FILLED_SESSION_PATH,
        text: `${JSON.stringify({ type: 'user', cwd: 'D:\\rec\\cwd' })}\n${JSON.stringify({ type: 'assistant', text: 'read D:\\rec\\cwd/notes.txt' })}\n`,
      },
    ]);
    assert.deepEqual(recording.unwritten, ['/home/someone/.claude/projects/D--rec-cwd/s1/subagents/agent-a0.jsonl']);
  });

  it('refuses a recording.json that is no JSON, no object, or lacks a fact', () => {
    assert.throws(() => recordingOf(reader({ [RECORDING_FILE]: '{' }), NAMES), /recording\.json is not JSON: /);
    assert.throws(() => recordingOf(reader({ [RECORDING_FILE]: '[]' }), NAMES), /recording\.json holds no JSON object/);
    assert.throws(() => recordingOf(withFacts({ version: 9 }), NAMES), /recording\.json has no text "version"/);
    assert.throws(() => recordingOf(withFacts({ order: ['SessionStart', 1] }), NAMES), /recording\.json has no list of texts "order"/);
    assert.throws(() => recordingOf(withFacts({ recorded: [] }), NAMES), /recording\.json has no object "recorded"/);
    assert.throws(() => recordingOf(withFacts({ recorded: { SessionStart: -1 } }), NAMES), /recording\.json "recorded" gives SessionStart no count/);
    assert.throws(() => recordingOf(withFacts({ transcripts: { [SESSION_FILE]: 1 } }), NAMES), /"transcripts" gives transcripts\/session\.jsonl no path/);
    assert.throws(() => recordingOf(withFacts({ notRecorded: { StopFailure: null } }), NAMES), /"notRecorded" gives StopFailure no reason/);
  });

  it('refuses an event file that is no list of objects, has another count, or holds another event', () => {
    const file = hookFile('SessionStart');
    assert.throws(() => recordingOf(reader({ [file]: '{}' }), NAMES), /hooks\/SessionStart\.json holds no list of JSON objects/);
    assert.throws(() => recordingOf(reader({ [file]: '[1]' }), NAMES), /hooks\/SessionStart\.json holds no list of JSON objects/);
    assert.throws(() => recordingOf(reader({ [file]: '[]' }), NAMES), /hooks\/SessionStart\.json holds 0 inputs, and recording\.json counts 1/);
    assert.throws(() => recordingOf(reader({ [file]: JSON.stringify([input('Stop')]) }), NAMES), /hooks\/SessionStart\.json input 1 is not of the event SessionStart/);
    assert.throws(() => recordingOf(withFacts({ recorded: { ...FACTS.recorded, Stop: 1 } }), NAMES), /no file hooks\/Stop\.json/);
  });

  it('refuses a firing order that names an event more or fewer times than it was recorded', () => {
    assert.throws(
      () => recordingOf(withFacts({ order: [...FACTS.order, 'SessionStart'] }), NAMES),
      /"order" names SessionStart more than the 1 times "recorded" counts/,
    );
    assert.throws(() => recordingOf(withFacts({ order: [...FACTS.order, 'Stop'] }), NAMES), /"order" names Stop more than the 0 times "recorded" counts/);
    assert.throws(() => recordingOf(withFacts({ order: ['SessionStart', 'PreToolUse'] }), NAMES), /"order" names PreToolUse 1 times, and "recorded" counts 2/);
  });

  it('refuses a transcript line that is no JSON, naming the line', () => {
    assert.throws(() => recordingOf(reader({ [SESSION_FILE]: '{"type":"user"}\nnot json\n' }), NAMES), /transcripts\/session\.jsonl line 2 is not JSON: /);
  });
});

describe('inputsOf', () => {
  it('gives the inputs of one event in firing order, none for an event that was not recorded', () => {
    const recording = recordingOf(reader(), NAMES);
    assert.deepEqual(
      inputsOf(recording, 'PreToolUse').map(({ index, input }) => [index, input['tool_name']]),
      [
        [0, 'Read'],
        [1, 'Bash'],
      ],
    );
    assert.deepEqual(inputsOf(recording, 'Stop'), []);
  });
});

describe('loadRecording', () => {
  const recording = loadRecording('claude-code', NAMES);

  it('reads the committed Claude Code recording with every count it states', () => {
    assert.equal(recording.host, 'claude-code');
    assert.match(recording.version, /^\d+\.\d+\.\d+$/);
    assert.ok(recording.inputs.length > 0);
    assert.equal(
      recording.inputs.length,
      Object.values(recording.recorded).reduce((sum, count) => sum + count, 0),
    );
    for (const [event, count] of Object.entries(recording.recorded)) {
      assert.equal(inputsOf(recording, event).length, count, event);
    }
  });

  it('leaves no placeholder in an input or a transcript', () => {
    const texts: string[] = [];
    const kept = (text: string): string => {
      texts.push(text);
      return text;
    };
    withStrings(
      recording.inputs.map(({ input }) => input),
      kept,
    );
    withStrings([recording.transcripts, recording.unwritten], kept);
    assert.ok(texts.length > 0);
    assert.deepEqual(
      texts.filter((text) => text.includes('{{')),
      [],
    );
  });

  it('runs every input in the session folder it is given and names a transcript the recording holds', () => {
    const [session] = recording.transcripts;
    assert.ok(session !== undefined);
    const known = new Set([...recording.transcripts.map(({ path }) => path), ...recording.unwritten]);
    for (const { event, index, input } of recording.inputs) {
      assert.equal(stringField(input, 'cwd'), FOLDERS.cwd, `${event} ${index}`);
      assert.equal(stringField(input, 'transcript_path'), session.path, `${event} ${index}`);
      const helper = stringField(input, 'agent_transcript_path');
      assert.ok(helper === undefined || known.has(helper), `${event} ${index} names ${helper ?? ''}`);
    }
  });
});
