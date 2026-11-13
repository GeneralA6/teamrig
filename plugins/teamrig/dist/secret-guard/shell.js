import { runsOf } from "../package-guard/programs.js";
import { commandFindings } from "./commands.js";
import { credentialReadFindings } from "./credential-reads.js";
import { bareFindings, envFindings, environmentReads, readsEnvironment } from "./env.js";
import { fileFindings } from "./files.js";
import { uniqueFindings } from "./findings.js";
import { inlineFindings } from "./inline.js";
import { quiet } from "./output.js";
import { remoteFindings } from "./remote.js";
/** Lines run in a container or on a remote host deeper than this are not read. */
const MAX_REMOTE_DEPTH = 4;
/**
 * The saved credentials a shell line reads out of the host's store, printed or not (credential-reads.ts), then the
 * secrets it would print into the conversation: each program and expression whose output reaches the
 * screen, read for the secret files it prints, the environment or secret variables it prints, a command whose output is
 * a secret, the inline code it runs, and the lines it runs somewhere else. `depth` counts the remote lines read on the
 * way here.
 */
export function shellFindings(command, context, rules, depth = 0) {
    const runs = runsOf(command, context);
    const inner = (line, dialect) => depth < MAX_REMOTE_DEPTH ? shellFindings(line, { cwd: undefined, home: context.home, dialect }, rules, depth + 1) : [];
    const printing = runs.programs.filter((run) => !quiet(run));
    const printingBare = runs.bare.filter((bare) => !quiet(bare));
    return uniqueFindings([
        ...credentialReadFindings(command, runs.programs),
        ...printing.flatMap((run) => [
            ...fileFindings(run, rules),
            ...envFindings(run, rules.names),
            ...commandFindings(run, rules.commands),
            ...inlineFindings(run, rules),
            ...remoteFindings(run, inner),
        ]),
        ...printingBare.flatMap((bare) => bareFindings(bare, rules.names)),
        ...(printingBare.some(readsEnvironment) ? environmentReads(command, rules.names) : []),
    ]);
}
