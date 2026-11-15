import type { Roster } from '../config/roster.ts';
import { PlainLogFile } from '../core/log-file.ts';
import { soleAreaOf } from '../inbox/marks.ts';
import { JsonlMarkLog } from '../inbox/store.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The team session a Claude Code tab acts as when it claims one (T2984, security condition C1): the one area every
 * inbox mark of `claudeSession` names, on the roster, and the same session `named` (a `--session` flag or
 * `$TEAMRIG_SESSION`) looks up to. Undefined otherwise, so neither a typed name nor the environment moves a tab to
 * another session, and a tab that ever read another session's inbox acts as nobody.
 */
export async function tabSessionOf(files: CliRuntime['files'], marksPath: string, roster: Roster, claudeSession: string, named: string | undefined): Promise<string | undefined> {
  const { marks } = await new JsonlMarkLog(new PlainLogFile(files, marksPath)).read();
  const bound = soleAreaOf(marks, claudeSession);
  const found = named === undefined ? undefined : roster.lookup(named);
  return bound !== undefined && roster.ids.includes(bound) && found?.ok === true && found.id === bound ? bound : undefined;
}
