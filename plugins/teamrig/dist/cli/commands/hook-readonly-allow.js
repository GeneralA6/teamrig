import { join } from 'node:path';
import { isRecord } from "../../core/guards.js";
import { claudeConfigDir } from "../../core/home.js";
import { readonlyRulesOf, readonlyShellOutput } from "../../hooks/readonly-shell.js";
import { secretFindingsOf } from "../../hooks/secret-guard.js";
import { newestSnapshotExports } from "../../readonly-shell/snapshot.js";
import { secretRulesOf } from "../../secret-guard/rules.js";
import { noPositionals } from "../args.js";
import { openKit } from "../kit.js";
import { EXIT } from "../runtime.js";
import { parseJson, sessionTeam } from "./hook-input.js";
/** The team's read-only check, built whether `readonlyShell.enabled` is on or not: each hook decides when it applies. */
export async function readonlyCheckOf(runtime, config) {
    const snapshot = await newestSnapshotExports(runtime.files, join(claudeConfigDir(runtime.env, runtime.userHome), 'shell-snapshots'));
    const secrets = secretRulesOf(config.secretGuard, runtime.userHome, runtime.platform, config.register.secretPatterns);
    return {
        rules: readonlyRulesOf(config.readonlyShell, runtime.env, snapshot),
        printsSecret: (call) => secretFindingsOf(call, runtime.cwd, secrets).length > 0,
    };
}
/**
 * What the hook prints for this payload: an allow for a line that only reads when the session's team turned the hook
 * on, else ''. It reads the session's team, not the one of the folder the line `cd`s into, so a line never gains
 * another team's trusted prefixes.
 */
async function readonlyAllowOutputOf(runtime, payload) {
    const found = await sessionTeam(payload, runtime);
    const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
    if (kit?.load.status !== 'loaded' || !kit.load.config.readonlyShell.enabled) {
        return '';
    }
    const check = await readonlyCheckOf(runtime, kit.load.config);
    return readonlyShellOutput(payload, check.rules, check.printsSecret, runtime.platform);
}
/**
 * PreToolUse on Bash and PowerShell: with `readonlyShell.enabled`, lets a line whose every command provably only
 * reads (hooks/readonly-shell.ts) run without a permission prompt. Outside a team, with the hook off, for a line it
 * cannot prove reads or one that prints a secret (hooks/secret-guard.ts), for input that is not a hook payload or on any error, it prints nothing, so Claude Code's own
 * permission check decides: it fails closed.
 */
export async function readonlyAllow(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const output = isRecord(payload) ? await readonlyAllowOutputOf(runtime, payload).catch(() => '') : '';
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
