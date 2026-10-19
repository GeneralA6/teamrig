import { runsOf, type ProgramsContext } from '../package-guard/programs.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { bareFindings, ENVIRONMENT_READ, envFindings, environmentReads } from './env.ts';
import { fileFindings } from './files.ts';
import { uniqueFindings, type SecretFinding } from './findings.ts';
import { inlineFindings } from './inline.ts';
import { quiet } from './output.ts';
import { remoteFindings } from './remote.ts';
import type { SecretRules } from './rules.ts';

/** Lines run in a container or on a remote host deeper than this are not read. */
const MAX_REMOTE_DEPTH = 4;

/**
 * The secrets a shell line would print into the conversation: each program and expression whose output reaches the
 * screen, read for the secret files it prints, the environment or secret variables it prints, the inline code it runs,
 * and the lines it runs somewhere else. `depth` counts the remote lines read on the way here.
 */
export function shellFindings(command: string, context: ProgramsContext, rules: SecretRules, depth = 0): SecretFinding[] {
  const runs = runsOf(command, context);
  const inner = (line: string, dialect: ShellDialect): SecretFinding[] =>
    depth < MAX_REMOTE_DEPTH ? shellFindings(line, { cwd: undefined, home: context.home, dialect }, rules, depth + 1) : [];
  const printing = runs.programs.filter((run) => !quiet(run));
  return uniqueFindings([
    ...printing.flatMap((run) => [...fileFindings(run, rules), ...envFindings(run, rules.names), ...inlineFindings(run, rules), ...remoteFindings(run, inner)]),
    ...runs.bare.filter((bare) => !quiet(bare)).flatMap((bare) => bareFindings(bare, rules.names)),
    ...(printing.some((run) => ENVIRONMENT_READ.test(run.name)) ? environmentReads(command, rules.names) : []),
  ]);
}
