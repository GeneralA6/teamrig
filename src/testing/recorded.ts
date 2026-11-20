import { readFileSync } from 'node:fs';
import { errorMessage, isNonNegativeInteger, isRecord, isStringArray, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { withStrings, type FolderNames } from './folder-names.ts';

/** The hosts a recorded session exists for, each a folder of `src/testing/recorded/`. */
export type RecordedHost = 'claude-code';

/** The recording's own facts: what recorded it, how many inputs each event has, their firing order, its transcripts. */
export const RECORDING_FILE = 'recording.json';

/** The fixture file that holds one event's hook inputs, in firing order. */
export function hookFile(event: string): string {
  return `hooks/${event}.json`;
}

/** One hook input the host sent during the recorded session. */
export interface RecordedInput {
  readonly event: string;
  /** Its place among its event's inputs, from 0. */
  readonly index: number;
  readonly input: JsonRecord;
}

/** A transcript the recorded session's hook inputs name. */
export interface RecordedTranscript {
  /** Its file in the fixture folder. */
  readonly file: string;
  /** Where the hook inputs say it is. */
  readonly path: string;
  /** Its lines as the host had written them when the session ended. */
  readonly text: string;
}

/** A recorded session of one host, its placeholders filled with the reader's folders. */
export interface Recording {
  readonly host: string;
  /** The host version that was recorded. */
  readonly version: string;
  readonly platform: string;
  readonly model: string;
  /** How many inputs each recorded event has. */
  readonly recorded: Readonly<Record<string, number>>;
  /** Why each event without an input could not be recorded. */
  readonly notRecorded: Readonly<Record<string, string>>;
  /** Every hook input, in firing order. */
  readonly inputs: readonly RecordedInput[];
  readonly transcripts: readonly RecordedTranscript[];
  /** The transcripts an input names that the host never wrote. */
  readonly unwritten: readonly string[];
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecordList(value: unknown): value is readonly JsonRecord[] {
  return Array.isArray(value) && value.every(isRecord);
}

function parsed(name: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not JSON: ${errorMessage(error)}`);
  }
}

function textOf(facts: JsonRecord, key: string): string {
  const value = stringField(facts, key);
  if (value === undefined) {
    throw new Error(`${RECORDING_FILE} has no text "${key}"`);
  }
  return value;
}

function listOf(facts: JsonRecord, key: string): readonly string[] {
  const value = facts[key];
  if (!isStringArray(value)) {
    throw new Error(`${RECORDING_FILE} has no list of texts "${key}"`);
  }
  return value;
}

function mapOf<T>(facts: JsonRecord, key: string, is: (value: unknown) => value is T, kind: string): Readonly<Record<string, T>> {
  const map = recordField(facts, key);
  if (map === undefined) {
    throw new Error(`${RECORDING_FILE} has no object "${key}"`);
  }
  return Object.fromEntries(
    Object.entries(map).map(([name, value]): [string, T] => {
      if (!is(value)) {
        throw new Error(`${RECORDING_FILE} "${key}" gives ${name} no ${kind}`);
      }
      return [name, value];
    }),
  );
}

/**
 * The recording whose fixture files `read` gives by their path in the fixture folder, each placeholder filled with a
 * folder of `names`. A placeholder is filled in the parsed values, never in a file's raw text: a Windows folder put
 * into JSON text would be read as escapes. A transcript line is parsed, filled and written as one line again.
 *
 * Throws when a file is not the JSON its name promises, and when the event files, the counts and the firing order of
 * `recording.json` disagree, so a half-replaced fixture is never replayed.
 */
export function recordingOf(read: (file: string) => string, names: FolderNames): Recording {
  const fill = (text: string): string => names.filled(text);
  const facts = parsed(RECORDING_FILE, read(RECORDING_FILE));
  if (!isRecord(facts)) {
    throw new Error(`${RECORDING_FILE} holds no JSON object`);
  }
  const recorded = mapOf(facts, 'recorded', isNonNegativeInteger, 'count');
  const byEvent = new Map<string, readonly JsonRecord[]>();
  for (const [event, count] of Object.entries(recorded)) {
    const file = hookFile(event);
    const inputs = withStrings(parsed(file, read(file)), fill);
    if (!isRecordList(inputs)) {
      throw new Error(`${file} holds no list of JSON objects`);
    }
    if (inputs.length !== count) {
      throw new Error(`${file} holds ${inputs.length} inputs, and ${RECORDING_FILE} counts ${count}`);
    }
    const other = inputs.findIndex((input) => stringField(input, 'hook_event_name') !== event);
    if (other !== -1) {
      throw new Error(`${file} input ${other + 1} is not of the event ${event}`);
    }
    byEvent.set(event, inputs);
  }
  const fired = new Map<string, number>();
  const inputs = listOf(facts, 'order').map((event): RecordedInput => {
    const index = fired.get(event) ?? 0;
    fired.set(event, index + 1);
    const input = byEvent.get(event)?.[index];
    if (input === undefined) {
      throw new Error(`${RECORDING_FILE} "order" names ${event} more than the ${recorded[event] ?? 0} times "recorded" counts`);
    }
    return { event, index, input };
  });
  const short = Object.entries(recorded).find(([event, count]) => (fired.get(event) ?? 0) !== count);
  if (short !== undefined) {
    throw new Error(`${RECORDING_FILE} "order" names ${short[0]} ${fired.get(short[0]) ?? 0} times, and "recorded" counts ${short[1]}`);
  }
  const transcripts = Object.entries(mapOf(facts, 'transcripts', isText, 'path')).map(([file, path]): RecordedTranscript => {
    const lines = read(file)
      .split('\n')
      .filter((line) => line !== '')
      .map((line, index) => `${JSON.stringify(withStrings(parsed(`${file} line ${index + 1}`, line), fill))}\n`);
    return { file, path: fill(path), text: lines.join('') };
  });
  return {
    host: textOf(facts, 'host'),
    version: textOf(facts, 'version'),
    platform: textOf(facts, 'platform'),
    model: textOf(facts, 'model'),
    recorded,
    notRecorded: mapOf(facts, 'notRecorded', isText, 'reason'),
    inputs,
    transcripts,
    unwritten: listOf(facts, 'unwritten').map(fill),
  };
}

/** The committed recording of `host`, read from the folder beside this file, with the folders of `names`. */
export function loadRecording(host: RecordedHost, names: FolderNames): Recording {
  return recordingOf((file) => readFileSync(new URL(`./recorded/${host}/${file}`, import.meta.url), 'utf8'), names);
}

/** The recording's inputs of one event, in firing order. */
export function inputsOf(recording: Recording, event: string): readonly RecordedInput[] {
  return recording.inputs.filter((input) => input.event === event);
}
