import { KIT_NAME } from '../../core/home.ts';
import { reminderFor, sessionIdOf } from '../../inbox/inbox.ts';
import { protectedBranchesOf, pushGuardOutput } from '../../hooks/push-guard.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';

/**
 * Claude Code hooks. Each reads the hook's JSON from stdin and prints only what Claude Code
 * should act on, and never refuses: a refusal exits 2, which would block the tool call.
 */

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** PreToolUse on Bash and PowerShell: asks before a push to a protected branch, refuses a force-push of one. */
export async function pushGuard(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  // A config that cannot even be opened keeps the default branches: it never turns the guard off.
  const load = await openKit(runtime).then(
    (kit) => kit.load,
    () => undefined,
  );
  const output = pushGuardOutput(payload, {
    cwd: runtime.cwd,
    home: runtime.userHome,
    repo: runtime.git,
    protectedBranches: protectedBranchesOf(load),
  });
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}

/** UserPromptSubmit: one line of context when the session's inbox has unread lines. */
export async function inboxReminder(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const claudeSession = sessionIdOf(await runtime.readStdin());
  if (claudeSession === null) {
    return EXIT.ok;
  }
  const kit = await openKit(runtime);
  if (kit.load.status !== 'loaded') {
    return EXIT.ok;
  }
  const line = await reminderFor(inboxDepsOf(runtime, kit.paths), claudeSession, KIT_NAME);
  if (line !== undefined) {
    runtime.out.stdout(line);
  }
  return EXIT.ok;
}
