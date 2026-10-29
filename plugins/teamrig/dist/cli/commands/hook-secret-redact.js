import { secretGuardOf, secretPatternsOf } from "../../hooks/secret-guard.js";
import { rotatorOf, secretRedactOutput } from "../../hooks/secret-redact.js";
import { EnvAssignments } from "../../secret-guard/env-assignments.js";
import { ToolOutputRedactor } from "../../secret-guard/redactor.js";
import { secretRulesOf } from "../../secret-guard/rules.js";
import { noPositionals } from "../args.js";
import { EXIT } from "../runtime.js";
import { guardLoadOf } from "./hook-guard-load.js";
import { parseJson } from "./hook-input.js";
/**
 * PostToolUse on Bash, PowerShell, Read and Grep (T1369 R7): replaces each secret the tool's result holds before the
 * model and the transcript see it, by the write-time shapes, the team's own patterns and the value of a secret variable.
 * A helper's calls are redacted too. A broken config keeps the defaults; outside a team's projects, or with
 * `secretGuard.redact` off, it prints nothing.
 */
export async function secretRedact(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const guard = await guardLoadOf(payload, runtime);
    if (guard === undefined) {
        return EXIT.ok;
    }
    const config = secretGuardOf(guard.load);
    if (!config.redact) {
        return EXIT.ok;
    }
    const rules = secretRulesOf(config, runtime.userHome, runtime.platform, secretPatternsOf(guard.load));
    const output = secretRedactOutput(payload, new ToolOutputRedactor([rules.shapes, new EnvAssignments(rules.names)]), rotatorOf(guard.load));
    if (output !== undefined) {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
