import { resolveKitHome } from '../../core/home.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { CLAIM_TAKEN, isClaudeSessionId } from '../../mod/clear-hand.ts';
import { ClearAsks, clearAskDir } from '../../refresh/clear-asks.ts';
import { RefreshStore } from '../../refresh/store.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { parseJson } from './hook-input.ts';

function asksOf(runtime: CliRuntime): ClearAsks {
  return new ClearAsks(runtime.files, clearAskDir(resolveKitHome(runtime.env, runtime.userHome)));
}

/** `hook clear-dir`: prints the folder of the restart's asks, which the plugin's mod watches for its tab's. */
export async function clearDir(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  runtime.out.stdout(clearAskDir(resolveKitHome(runtime.env, runtime.userHome)));
  return EXIT.ok;
}

/** Why the tab may not run /clear for its ask; undefined once it has claimed it. */
async function claimProblem(runtime: CliRuntime, asks: ClearAsks, claudeSession: string): Promise<string | undefined> {
  const ask = await asks.ask(claudeSession);
  if (ask === undefined) {
    return 'no ask for this session';
  }
  const kit = await openKit(runtime, ask.team);
  const store = new RefreshStore(runtime.files, kit.paths);
  const request = await store.restart(ask.id);
  if (request?.phase !== 'pending' || request.at !== ask.at || request.claudeSession !== claudeSession) {
    return 'the restart is no longer pending';
  }
  if (!(await asks.claim(claudeSession))) {
    return 'the restart took its ask back';
  }
  // Claimed: the request goes now, so a prompt typed before the /clear runs is not told it was cancelled.
  await store.clearRestart(ask.id);
  return undefined;
}

/**
 * `hook clear-claim`, run by the plugin's mod with `{"session_id": ...}` on stdin once it sees its tab's
 * ask: claims the ask while the restart it is for is still pending, and prints `taken` (the mod then runs
 * /clear) or `declined: <why>`. Whichever of this claim and the restart's withdraw comes first wins.
 */
export async function clearClaim(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const claudeSession = sessionIdOf(parseJson(await runtime.readStdin()));
  const problem =
    claudeSession === null || !isClaudeSessionId(claudeSession) ? 'no Claude Code session id on stdin' : await claimProblem(runtime, asksOf(runtime), claudeSession);
  runtime.out.stdout(problem === undefined ? CLAIM_TAKEN : `declined: ${problem}`);
  return EXIT.ok;
}
