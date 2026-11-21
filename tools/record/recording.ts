import { hookFile, RECORDING_FILE } from '../../src/testing/recorded.ts';
import { stringField, type JsonRecord } from '../lib/guards.ts';
import { GENERIC_RULES } from '../scrub/rules.ts';
import { formatFinding, scanText } from '../scrub/scan.ts';
import type { Scrubber } from './scrub.ts';
import { fixtureTranscript } from './transcript.ts';

/** What one run of the recorder got from Claude Code, as it was on the machine. */
export interface RawRecording {
  /** What `claude --version` printed. */
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly model: string;
  /** The events the plugin's hooks.json wires: each must be recorded or have a reason. */
  readonly events: readonly string[];
  /** Every hook input, in firing order. */
  readonly inputs: readonly JsonRecord[];
  /** The session's transcript, which every hook input names. */
  readonly session: WrittenTranscript;
  /** The transcript each stopped helper's input names, in the order the helpers stopped. */
  readonly helpers: readonly RawTranscript[];
}

/** A transcript a hook input names, as it was on the machine. */
export interface RawTranscript {
  /** Where the input says the transcript is. */
  readonly path: string;
  /** What Claude Code wrote there; undefined when it wrote nothing, as for the helper that sums up a compaction. */
  readonly text: string | undefined;
}

export interface WrittenTranscript extends RawTranscript {
  readonly text: string;
}

/**
 * Why a sealed `claude -p` turn cannot fire an event. An event with a reason here that fires anyway is recorded, and
 * one that does not fire and has no reason fails the recording, so a fixture never lacks an event silently.
 */
export const UNRECORDED_REASONS: Readonly<Record<string, string>> = {
  PermissionRequest: 'fires when a permission dialog opens, which a headless turn never shows',
  Elicitation: 'fires when an MCP server asks the user for input; the recorded session has no MCP server',
  ElicitationResult: 'fires when the user answers an MCP server; the recorded session has no MCP server',
  StopFailure: 'fires when a turn ends on an API error, which a recording cannot cause',
};

export const SESSION_TRANSCRIPT = 'transcripts/session.jsonl';

/** The fixture file of the `number`th helper that wrote a transcript, counted from 1. */
export function helperTranscript(number: number): string {
  return `transcripts/helper-${number}.jsonl`;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The fixture files of a recording, by their path in the fixture folder, everything private scrubbed:
 * `hooks/<Event>.json` (that event's inputs in firing order), `transcripts/session.jsonl`,
 * `transcripts/helper-<n>.jsonl` and `recording.json` (the Claude Code version, the platform, the model, how many
 * inputs each event has, the event of each input in firing order, so a reader can replay the session across the event
 * files, why each missing event was not recorded, the path the inputs give each transcript file, how many long
 * bookkeeping strings each transcript file had cut, and the transcripts an input names that Claude Code never wrote).
 *
 * Throws when a wired event neither fired nor has a reason, and when a scrubbed file still holds something the
 * repository scrub refuses, naming each: a recording is committed, so it must pass that scrub as written.
 */
export function assemble(raw: RawRecording, scrubber: Scrubber): Readonly<Record<string, string>> {
  const byEvent = new Map<string, unknown[]>();
  const order: string[] = [];
  for (const input of raw.inputs) {
    const event = stringField(input, 'hook_event_name');
    if (event === undefined) {
      throw new Error(`a hook input names no event: ${JSON.stringify(Object.keys(input))}`);
    }
    order.push(event);
    byEvent.set(event, [...(byEvent.get(event) ?? []), scrubber.value(input)]);
  }
  const silent = raw.events.filter((event) => !byEvent.has(event));
  const unexplained = silent.filter((event) => UNRECORDED_REASONS[event] === undefined);
  if (unexplained.length > 0) {
    throw new Error(`no input was recorded for ${unexplained.join(', ')}, and nothing says why`);
  }
  const written = [raw.session, ...raw.helpers.filter((helper): helper is WrittenTranscript => helper.text !== undefined)];
  const transcripts = written.map(({ path, text }, index) => {
    const file = index === 0 ? SESSION_TRANSCRIPT : helperTranscript(index);
    return { file, path, fixture: fixtureTranscript(file, text, scrubber) };
  });
  const files: Record<string, string> = {
    [RECORDING_FILE]: pretty({
      host: 'claude-code',
      version: /\d+(?:\.\d+)+/.exec(raw.version)?.[0] ?? raw.version.trim(),
      platform: raw.platform,
      model: raw.model,
      recorded: Object.fromEntries([...byEvent].map(([event, inputs]) => [event, inputs.length])),
      order,
      notRecorded: Object.fromEntries(silent.map((event) => [event, UNRECORDED_REASONS[event]])),
      transcripts: Object.fromEntries(transcripts.map(({ file, path }) => [file, scrubber.text(path)])),
      cut: Object.fromEntries(transcripts.map(({ file, fixture }) => [file, fixture.cut])),
      unwritten: raw.helpers.filter((helper) => helper.text === undefined).map((helper) => scrubber.text(helper.path)),
    }),
  };
  for (const { file, fixture } of transcripts) {
    files[file] = fixture.text;
  }
  for (const [event, inputs] of byEvent) {
    files[hookFile(event)] = pretty(inputs);
  }
  const findings = Object.entries(files).flatMap(([path, text]) => scanText(path, text, GENERIC_RULES));
  if (findings.length > 0) {
    throw new Error(`the scrubbed recording still holds private data:\n${findings.map(formatFinding).join('\n')}`);
  }
  return files;
}
