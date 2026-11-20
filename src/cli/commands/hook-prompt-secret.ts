import { claudeConfigDir } from '../../core/home.ts';
import { promptSecretReason, type HistoryOutcome } from '../../hooks/prompt-secret.ts';
import type { HookReply } from '../../ports/host/index.ts';
import { HistoryPending } from '../../secret-guard/history-pending.ts';
import { PromptSecrets } from '../../secret-guard/prompt-secrets.ts';
import type { CliRuntime } from '../runtime.ts';

/** Where a session's prompts are checked: the kit home holding the pending cleans, and the team's own secret patterns. */
export interface PromptSecretScope {
  readonly kitHome: string;
  readonly patterns: readonly string[];
}

/**
 * UserPromptSubmit, before anything else reads the prompt (T1481): the block for a prompt that holds a secret, after
 * cleaning the secret out of Claude Code's prompt history and recording the prompt as pending; undefined for a prompt
 * with none, after cleaning again for each earlier blocked prompt still pending. A failed clean still blocks; a failed
 * sweep is retried at the next prompt.
 */
export async function promptSecretBlock(runtime: CliRuntime, scope: PromptSecretScope, hostSession: string, prompt: string | undefined): Promise<HookReply | undefined> {
  const secrets = new PromptSecrets(scope.patterns);
  const pending = new HistoryPending(runtime.files, runtime.clock, secrets, scope.kitHome);
  const found = secrets.secretsIn(prompt ?? '');
  if (found.length === 0) {
    await pending.sweep().catch(() => undefined);
    return undefined;
  }
  const outcome: HistoryOutcome = await pending.blocked(hostSession, claudeConfigDir(runtime.env, runtime.userHome), found).then(
    (clean): HistoryOutcome => (clean === undefined ? { kind: 'retry' } : { kind: 'cleaned', lines: clean.lines, pastes: clean.pastes }),
    (): HistoryOutcome => ({ kind: 'failed' }),
  );
  // The block also keeps the prompt out of the transcript.
  return { verdict: { kind: 'block', reason: promptSecretReason(found, outcome), hidePrompt: true } };
}
