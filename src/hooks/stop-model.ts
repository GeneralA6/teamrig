import type { LaunchConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { modelCheckLine } from './model-check.ts';
import { fallbackLine, readLastFallback } from './model-fallback.ts';
import type { ModelNoticeStore } from './model-notices.ts';

/** What the Stop hook knows of a team session at the end of a turn. */
export interface StopModelInput {
  /** The team session's id, which names its notice file. */
  readonly id: string;
  /** Its name, as the notices show it. */
  readonly name: string;
  /** Its `launch` entry, with the lead's defaults filled in. */
  readonly launch: LaunchConfig;
  /** The Claude Code session id: each notice shows once per Claude Code session. */
  readonly claude: string;
  /** The payload's effort level; undefined when it gives none. */
  readonly effort: string | undefined;
  /** The payload's transcript path; undefined when it gives none. */
  readonly transcript: string | undefined;
}

interface Notice {
  readonly key: string;
  readonly line: string;
}

function effortNotice(input: StopModelInput): Notice | undefined {
  const line = modelCheckLine(input.name, input.launch, { model: undefined, effort: input.effort });
  return line === undefined ? undefined : { key: `effort:${input.effort ?? ''}`, line };
}

async function fallbackNotice(files: Files, input: StopModelInput): Promise<Notice | undefined> {
  const fallback = input.transcript === undefined ? undefined : await readLastFallback(files, input.transcript);
  return fallback === undefined ? undefined : { key: `fallback:${fallback.id}`, line: fallbackLine(input.name, fallback, input.launch.model) };
}

function isNotice(notice: Notice | undefined): notice is Notice {
  return notice !== undefined;
}

/**
 * The lines the Stop hook shows the user about the session's model: that it runs at another effort
 * than its `launch` entry (SessionStart has no effort level it can trust), and that Claude Code
 * switched its model after a safeguard stop. Each shows once per Claude Code session, recorded before
 * it is returned, so a store that cannot be written shows nothing rather than the same line at every stop.
 */
export async function stopModelNotices(files: Files, store: ModelNoticeStore, input: StopModelInput): Promise<readonly string[]> {
  const found = [effortNotice(input), await fallbackNotice(files, input)].filter(isNotice);
  if (found.length === 0) {
    return [];
  }
  const told = await store.told(input.id, input.claude);
  const fresh = found.filter((notice) => !told.includes(notice.key));
  if (fresh.length > 0) {
    await store.remember(
      input.id,
      input.claude,
      fresh.map((notice) => notice.key),
    );
  }
  return fresh.map((notice) => notice.line);
}
