import { isRecord, stringField } from '../../core/guards.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { wakePromptOf } from '../../refresh/decide.ts';
import { RefreshStore } from '../../refresh/store.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit, rosterOf } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { parseJson, sessionTeam, teamSessionOf } from './hook-input.ts';

/** How long the wake waits for the SessionStart hook beside it to bind the tab and take the refresh. */
export const WAKE_WAIT_MS = 10_000;
/** How often it looks in that time. */
export const WAKE_POLL_MS = 500;

/**
 * SessionStart after a /clear, run in the background (`asyncRewake`): wakes the session that /clear just
 * started from its refresh, which would otherwise sit idle until the user typed, with its handover's
 * next steps never taken. Claude Code runs it beside `hook session-start`, which binds the tab and marks
 * the refresh taken, so it looks again until that is done or WAKE_WAIT_MS has passed. Any other start,
 * or a /clear with no refresh taken, exits 0 and wakes nothing.
 */
export async function refreshWake(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const claudeSession = sessionIdOf(payload);
  if (!isRecord(payload) || stringField(payload, 'source') !== 'clear' || claudeSession === null) {
    return EXIT.ok;
  }
  const found = await sessionTeam(payload, runtime);
  if (found.kind !== 'team') {
    return EXIT.ok;
  }
  const kit = await openKit(runtime, found.team);
  if (kit.load.status !== 'loaded' || !kit.load.config.refresh.enabled) {
    return EXIT.ok;
  }
  const roster = await rosterOf(runtime, kit, kit.load.config);
  const store = new RefreshStore(runtime.files, kit.paths);
  const until = runtime.clock.now() + WAKE_WAIT_MS;
  for (;;) {
    const id = await teamSessionOf(runtime, kit, roster, claudeSession);
    const prompt = id === undefined ? undefined : wakePromptOf(await store.state(id), store.handoverPath(id), new Date(runtime.clock.now()).toISOString());
    if (prompt !== undefined) {
      runtime.out.stderr(prompt);
      return EXIT.wake;
    }
    if (runtime.clock.now() >= until) {
      return EXIT.ok;
    }
    await runtime.sleep(WAKE_POLL_MS);
  }
}
