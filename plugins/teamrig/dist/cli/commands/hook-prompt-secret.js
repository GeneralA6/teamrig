import { isRecord, stringField } from "../../core/guards.js";
import { claudeConfigDir } from "../../core/home.js";
import { promptBlockOutput, promptSecretReason } from "../../hooks/prompt-secret.js";
import { HistoryPending } from "../../secret-guard/history-pending.js";
import { PromptSecrets } from "../../secret-guard/prompt-secrets.js";
/**
 * UserPromptSubmit, before anything else reads the prompt (T1481): the block for a prompt that holds a secret, after
 * cleaning the secret out of Claude Code's prompt history and recording the prompt as pending; undefined for a prompt
 * with none, after cleaning again for each earlier blocked prompt still pending. A failed clean still blocks; a failed
 * sweep is retried at the next prompt.
 */
export async function promptSecretBlock(runtime, scope, claudeSession, payload) {
    const prompt = isRecord(payload) ? (stringField(payload, 'prompt') ?? '') : '';
    const secrets = new PromptSecrets(scope.patterns);
    const pending = new HistoryPending(runtime.files, runtime.clock, secrets, scope.kitHome);
    const found = secrets.secretsIn(prompt);
    if (found.length === 0) {
        await pending.sweep().catch(() => undefined);
        return undefined;
    }
    const outcome = await pending.blocked(claudeSession, claudeConfigDir(runtime.env, runtime.userHome), found).then((clean) => (clean === undefined ? { kind: 'retry' } : { kind: 'cleaned', lines: clean.lines, pastes: clean.pastes }), () => ({ kind: 'failed' }));
    return promptBlockOutput(promptSecretReason(found, outcome));
}
