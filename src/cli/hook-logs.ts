import { DEFAULT_LOCK } from '../config/defaults.ts';
import { AgedLogFile } from '../core/aged-log.ts';
import type { TeamPaths } from '../core/home.ts';
import type { CliRuntime } from './runtime.ts';
import { fileLockOf } from './file-locks.ts';

/**
 * The hooks' aged logs: what they showed each Claude Code session, so each inbox line or hint is shown once
 * (inbox-shown, bind-hints), and how the prompt refusal answered each prompt (prompt-answers).
 */
export const HOOK_LOGS = ['inbox-shown', 'bind-hints', 'prompt-answers'] as const;
export type HookLog = (typeof HOOK_LOGS)[number];

function filesOf(paths: TeamPaths, log: HookLog): { readonly live: string; readonly lock: string } {
  switch (log) {
    case 'inbox-shown':
      return { live: paths.inboxShown, lock: paths.inboxShownLock };
    case 'bind-hints':
      return { live: paths.bindHints, lock: paths.bindHintsLock };
    case 'prompt-answers':
      return { live: paths.promptAnswers, lock: paths.promptAnswersLock };
  }
}

/**
 * A hook's log, locked on every write and archived by age (core/aged-log.ts, T336). Its lock keeps the default
 * timings, not the team's `lock`: the session-start hook writes bind-hints when no config loads, and every writer
 * of one lock must agree on when a held lock is stale.
 */
export function hookLogOf(runtime: CliRuntime, paths: TeamPaths, log: HookLog): AgedLogFile {
  const { files, clock } = runtime;
  const { live, lock } = filesOf(paths, log);
  return new AgedLogFile({ files, clock, mutex: fileLockOf(runtime, lock, DEFAULT_LOCK) }, { live, archive: paths.archive, name: log });
}
