import {
  bind,
  PERMISSIONS_CONTRACT,
  STATUS_LINE_CONTRACT,
  TRANSCRIPT_CONTRACT,
  USAGE_CONTRACT,
  type PermissionsWorld,
  type StatusLineWorld,
  type TranscriptWorld,
  type UsageWorld,
} from '../../../conformance/index.ts';
import { isStringArray, recordField, stringField, type JsonRecord, type RateWindow } from '../../../plugin-api/index.ts';
import { describeContracts } from '../../../testing/contracts.ts';
import { promptLine, resultsLine } from '../../../testing/transcript-lines.ts';
import { declaration } from './declaration.ts';
import { hostPermissions } from './permissions.ts';
import { statusLine } from './status-line.ts';
import { transcriptReader } from './transcript.ts';
import { usageMeter } from './usage.ts';

const AT = '2026-01-05T10:00:00.000Z';

/** The lines Claude Code writes for what a transcript case names. */
const transcriptWorld: TranscriptWorld = {
  prompt: (text, thread) => promptLine(AT, text, thread === 'helper'),
  reply: ({ text, call }) =>
    JSON.stringify({
      isSidechain: false,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', id: call.id, name: call.name, input: {} }] },
      timestamp: AT,
    }),
  result: (call, text, failed) => resultsLine(AT, [{ id: call, text, isError: failed }]),
  title: (text) => JSON.stringify({ type: 'custom-title', customTitle: text, sessionId: 'session-1' }),
  unknown: () => JSON.stringify({ type: 'file-history-snapshot', messageId: 'message-1', snapshot: {} }),
  torn: () => promptLine(AT, 'a prompt the write never finished').slice(0, 40),
};

/** A window as Claude Code's status input holds it, its reset in epoch seconds. */
function statusWindow(window: RateWindow | undefined): { used_percentage: number; resets_at: number } | undefined {
  return window === undefined ? undefined : { used_percentage: window.usedPct, resets_at: window.resetsAt / 1000 };
}

/** The status input Claude Code hands its status line: `rate_limits` only when the plan tells a window. */
const usageWorld: UsageWorld = {
  status: ({ week, fiveHour }) =>
    JSON.stringify({
      session_id: 'session-1',
      model: { display_name: 'Model' },
      ...(week === undefined && fiveHour === undefined ? {} : { rate_limits: { five_hour: statusWindow(fiveHour), seven_day: statusWindow(week) } }),
    }),
};

/** Claude Code's status input for what a case tells, and its settings, the status line under `statusLine.command`. */
const statusLineWorld: StatusLineWorld = {
  status: ({ sessionId, cwd, model, effort }) =>
    JSON.stringify({
      session_id: sessionId,
      ...(cwd === undefined ? {} : { workspace: { current_dir: cwd } }),
      ...(model === undefined ? {} : { model: { display_name: model } }),
      ...(effort === undefined ? {} : { effort: { level: effort } }),
    }),
  settings: (command) => (command === undefined ? { theme: 'dark' } : { theme: 'dark', statusLine: { type: 'command', command } }),
  commandOf: (settings) => {
    const line = recordField(settings, 'statusLine');
    return line === undefined ? undefined : stringField(line, 'command');
  },
};

function listIn(record: JsonRecord | undefined, key: string): readonly string[] | undefined {
  const list = record?.[key];
  return isStringArray(list) ? list : undefined;
}

/** Claude Code's settings: the rules under `permissions`, the bypass as its default mode, the routes under `autoMode.environment`. */
const permissionsWorld: PermissionsWorld = {
  settings: ({ allow, deny, bypass }) => ({
    theme: 'dark',
    permissions: {
      ...(allow === undefined ? {} : { allow: [...allow] }),
      ...(deny === undefined ? {} : { deny: [...deny] }),
      ...(bypass === true ? { defaultMode: 'bypassPermissions' } : {}),
    },
  }),
  allowOf: (settings) => listIn(recordField(settings, 'permissions'), 'allow'),
  routes: (lines) => (lines === undefined ? { theme: 'dark' } : { theme: 'dark', autoMode: { environment: [...lines] } }),
  routesOf: (settings) => listIn(recordField(settings, 'autoMode'), 'environment'),
};

describeContracts({
  side: 'host',
  declaration,
  bound: [
    bind({ contract: TRANSCRIPT_CONTRACT, make: () => ({ port: transcriptReader, world: transcriptWorld }) }),
    bind({ contract: USAGE_CONTRACT, make: () => ({ port: usageMeter, world: usageWorld }) }),
    bind({ contract: STATUS_LINE_CONTRACT, make: () => ({ port: statusLine, world: statusLineWorld }) }),
    bind({ contract: PERMISSIONS_CONTRACT, make: () => ({ port: hostPermissions, world: permissionsWorld }) }),
  ],
});
