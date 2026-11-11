import { join } from 'node:path';
import { isRecord, stringField } from "../../core/guards.js";
import { claudeConfigDir, resolveKitHome } from "../../core/home.js";
import { findClaude } from "../../open/claude.js";
import { UpdateCheck } from "../../update/check.js";
import { applyUpdate, hookGit } from "../../update/runner.js";
import { noPositionals } from "../args.js";
import { EXIT } from "../runtime.js";
import { parseJson } from "./hook-input.js";
function answer(runtime, value) {
    runtime.out.stdout(JSON.stringify(value));
    return EXIT.ok;
}
/** Claude Code's plugins folder, and the kit home's updates folder. */
export function updatePathsOf(runtime) {
    return {
        pluginsFolder: join(claudeConfigDir(runtime.env, runtime.userHome), 'plugins'),
        updatesFolder: join(resolveKitHome(runtime.env, runtime.userHome), 'updates'),
    };
}
function checkOf(runtime) {
    return new UpdateCheck({ files: runtime.files, git: hookGit(runtime.hooks, runtime.env), paths: updatePathsOf(runtime), now: () => runtime.clock.now() });
}
/** The `plugin` a request on stdin names; undefined when stdin is not JSON or names none. */
function pluginRequested(stdin) {
    const payload = parseJson(stdin);
    return isRecord(payload) ? stringField(payload, 'plugin') : undefined;
}
/**
 * `hook update-check`, run by the mod's UpdateHand in every interactive tab (T2466): the newer teamrig and
 * teamrig-pane versions published than the ones installed. The network is asked at most every CHECK_EVERY_MS across
 * the machine; every other run reads the kept answer.
 */
export async function updateCheck(args, runtime) {
    noPositionals(args);
    return answer(runtime, { kind: 'notices', notices: await checkOf(runtime).notices() });
}
/** `hook update-dismiss`, stdin `{"plugin", "version"}`: hides that plugin's update band until a newer version is out. */
export async function updateDismiss(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const plugin = isRecord(payload) ? stringField(payload, 'plugin') : undefined;
    const version = isRecord(payload) ? stringField(payload, 'version') : undefined;
    if (plugin === undefined || version === undefined) {
        return answer(runtime, { kind: 'failed', why: 'stdin names no plugin and version' });
    }
    await checkOf(runtime).dismiss(plugin, version);
    return answer(runtime, { kind: 'dismissed' });
}
/**
 * `hook update-apply`, stdin `{"plugin"}`: updates that plugin through Claude Code's own `plugin` commands, when the
 * kept check tells of a newer version for it; a plugin it does not tell of is refused, so the mod can update nothing
 * but a tracked install. The tab runs the new version once it reloads its plugins.
 */
export async function updateApply(args, runtime) {
    noPositionals(args);
    const plugin = pluginRequested(await runtime.readStdin());
    const notice = (await checkOf(runtime).notices()).find((each) => each.plugin === plugin);
    if (notice === undefined) {
        return answer(runtime, { kind: 'failed', why: `no newer ${plugin ?? 'plugin'} is published` });
    }
    const claude = await findClaude({ env: runtime.env, platform: runtime.platform, probe: runtime.probe, files: runtime.files, node: runtime.self.node });
    if (claude.kind === 'missing') {
        return answer(runtime, { kind: 'failed', why: 'Claude Code is not on PATH' });
    }
    const outcome = await applyUpdate({ hooks: runtime.hooks, env: runtime.env, claude: claude.program, cwd: runtime.userHome }, notice.plugin, notice.marketplace);
    if (!outcome.ok) {
        const said = outcome.said === '' ? '' : `: ${outcome.said.slice(0, 300)}`;
        return answer(runtime, { kind: 'failed', why: `${outcome.step} failed${said}` });
    }
    return answer(runtime, { kind: 'applied', plugin: notice.plugin, version: notice.newest });
}
