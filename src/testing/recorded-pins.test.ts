import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { errorMessage, isRecord, recordField, stringField } from '../core/guards.ts';
import { APP, USER_HOME } from './cli-harness.ts';
import { FolderNames, PLACEHOLDERS } from './folder-names.ts';
import { hookMatches, pluginHooks } from './plugin-hooks.ts';
import { expectedFolder, pinsIn, recordedPins, TRANSCRIPT_LINES_FILE } from './recorded-pins.ts';
import { hookFile, inputsOf, loadRecording } from './recorded.ts';

/** What brings the committed pins up to the code, after a change that is meant to alter them. */
const REGENERATE = 'node tools/record/pins-cli.ts';

const RECORDING = loadRecording('claude-code', new FolderNames({ cwd: APP, temp: resolve('/', 'tmp'), home: USER_HOME }));

let replay: Promise<Readonly<Record<string, string>>> | undefined;

/** The pins of the committed recording, replayed once for the whole file. */
function replayed(): Promise<Readonly<Record<string, string>>> {
  replay ??= recordedPins('claude-code');
  return replay;
}

/** The runs a pinned hooks file holds; anything else fails the test. */
function runsOf(pins: Readonly<Record<string, string>>, event: string): readonly Readonly<Record<string, unknown>>[] {
  const runs: unknown = JSON.parse(pins[hookFile(event)] ?? 'null');
  assert.ok(Array.isArray(runs), `no pinned runs of ${event}`);
  return runs.map((run: unknown) => {
    assert.ok(isRecord(run), `a pinned run of ${event} is no JSON object`);
    return run;
  });
}

describe('recordedPins', () => {
  let pins: Readonly<Record<string, string>>;
  before(async () => {
    pins = await replayed();
  });

  it('pins one file for each recorded event, and one for what is read from the transcripts', () => {
    assert.deepEqual(Object.keys(pins).sort(), [...Object.keys(RECORDING.recorded).map(hookFile), TRANSCRIPT_LINES_FILE].sort());
  });

  it("pins each wired hook an input reaches in the manifest's order, with its exit code and its JSON answer parsed", () => {
    const starts = runsOf(pins, 'SessionStart');
    const wired = pluginHooks();
    const reached = inputsOf(RECORDING, 'SessionStart').flatMap(({ index, input }) =>
      wired.filter((hook) => hookMatches(hook, input)).map((hook) => ({ index, hook: hook.argv.join(' ') })),
    );
    assert.ok(reached.length > 0);
    assert.deepEqual(
      starts.map((run) => ({ index: run['index'], hook: run['hook'] })),
      reached,
    );
    const [first] = starts;
    assert.ok(first !== undefined);
    assert.equal(first['code'], 0);
    assert.deepEqual(first['stderr'], []);
    const [answer, ...rest] = Array.isArray(first['stdout']) ? first['stdout'].map((line: unknown) => line) : [];
    assert.deepEqual(rest, []);
    assert.ok(isRecord(answer), 'the session-start answer is pinned as text');
    assert.equal(stringField(recordField(answer, 'hookSpecificOutput') ?? {}, 'hookEventName'), 'SessionStart');
  });

  it('pins what the usage meter reads out of each transcript, by its line', () => {
    const transcripts: unknown = JSON.parse(pins[TRANSCRIPT_LINES_FILE] ?? 'null');
    assert.ok(Array.isArray(transcripts));
    assert.deepEqual(
      transcripts.map((transcript: unknown) => (isRecord(transcript) ? transcript['file'] : undefined)),
      RECORDING.transcripts.map(({ file }) => file),
    );
    for (const transcript of transcripts) {
      assert.ok(isRecord(transcript));
      const read: unknown = transcript['read'];
      assert.ok(Array.isArray(read) && read.length > 0, `nothing is read from ${String(transcript['file'])}`);
      const total = transcript['lines'];
      for (const entry of read) {
        assert.ok(isRecord(entry) && isRecord(entry['value']));
        const line = entry['line'];
        assert.ok(typeof line === 'number' && typeof total === 'number' && line >= 1 && line <= total);
      }
    }
  });

  it('names every folder of the replay by its placeholder, so the pins are the same on every machine', () => {
    const app = JSON.stringify(APP).slice(1, -1);
    assert.deepEqual(
      Object.entries(pins)
        .filter(([, text]) => text.includes(app))
        .map(([file]) => file),
      [],
    );
    assert.ok(
      Object.values(pins).some((text) => text.includes(PLACEHOLDERS.cwd)),
      'no pin names the session folder',
    );
  });
});

describe('the recorded Claude Code session', () => {
  let pins: Readonly<Record<string, string>>;
  let committed: Readonly<Record<string, string>>;
  before(async () => {
    pins = await replayed();
    committed = pinsIn(expectedFolder('claude-code'));
  });

  it('has a committed pin for each file teamrig pins, and no other', () => {
    assert.deepEqual(Object.keys(committed).sort(), Object.keys(pins).sort(), `the committed pins are not the files teamrig pins now: run ${REGENERATE} and commit the diff`);
  });

  it('is handled as the committed pins say: a change that is meant regenerates them', () => {
    for (const [file, text] of Object.entries(pins)) {
      const expected = committed[file];
      if (expected === undefined) {
        continue;
      }
      try {
        assert.deepEqual(JSON.parse(text), JSON.parse(expected));
      } catch (error) {
        // The assertion's own message is the diff, which a message given to deepEqual would replace.
        throw new Error(`${file}: teamrig no longer does what is pinned; when the change is meant, run ${REGENERATE} and commit the diff\n${errorMessage(error)}`);
      }
    }
  });

  it('has an input, or a reason it has none, for every event the plugin wires a hook to', () => {
    const known = new Set([...Object.keys(RECORDING.recorded), ...Object.keys(RECORDING.notRecorded)]);
    assert.deepEqual(
      [...new Set(pluginHooks().map((hook) => hook.event))].filter((event) => !known.has(event)),
      [],
    );
  });
});
