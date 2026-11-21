import { promptSecretReason } from "../../hooks/prompt-secret.js";
import { HistoryPending } from "../../secret-guard/history-pending.js";
import { PromptSecrets } from "../../secret-guard/prompt-secrets.js";
import { hostHomeIfKnown } from "../host.js";
/**
 * UserPromptSubmit, before anything else reads the prompt (T1481): the block for a prompt that holds a secret, after
 * cleaning the secret out of Claude Code's prompt history and recording the prompt as pending; undefined for a prompt
 * with none, after cleaning again for each earlier blocked prompt still pending. A failed clean still blocks; a failed
 * sweep is retried at the next prompt. On a host that tells none of its folders the prompt is blocked all the same,
 * with no history to clean and no pending record.
 */
export async function promptSecretBlock(runtime, scope, hostSession, prompt) {
    const secrets = new PromptSecrets(scope.patterns);
    const pending = new HistoryPending(runtime.files, runtime.clock, secrets, scope.kitHome);
    const found = secrets.secretsIn(prompt ?? '');
    if (found.length === 0) {
        await pending.sweep().catch(() => undefined);
        return undefined;
    }
    const hostHome = hostHomeIfKnown(runtime);
    const outcome = hostHome === undefined
        ? { kind: 'unknown' }
        : await pending.blocked(hostSession, hostHome, found).then((clean) => (clean === undefined ? { kind: 'retry' } : { kind: 'cleaned', lines: clean.lines, pastes: clean.pastes }), () => ({ kind: 'failed' }));
    // The block also keeps the prompt out of the transcript.
    return { verdict: { kind: 'block', reason: promptSecretReason(found, outcome), hidePrompt: true } };
}
