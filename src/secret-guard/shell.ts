import { runsOf, type ProgramsContext } from '../package-guard/programs.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { commandFindings } from './commands.ts';
import { Location } from '../push-guard/location.ts';
import { credentialReadFindings, NO_SEARCH_START, type SearchStart } from './credential-reads.ts';
import { bareFindings, envFindings, environmentReads, readsEnvironment } from './env.ts';
import { fileFindings } from './files.ts';
import { uniqueFindings, type SecretFinding } from './findings.ts';
import { inlineFindings } from './inline.ts';
import { quiet } from './output.ts';
import { remoteFindings } from './remote.ts';
import type { SecretRules } from './rules.ts';
import { consoleWriteFindings, fileReadFindings } from './static-calls.ts';

/** Where a line runs; `inWorkTree` asks git about the folder it starts in, and without it no repository search is let by. */
export interface ShellContext extends ProgramsContext {
  readonly inWorkTree?: (dir: string) => boolean;
}

/** Lines run in a container or on a remote host deeper than this are not read. */
const MAX_REMOTE_DEPTH = 4;

/**
 * The saved credentials a shell line reads out of the host's store, printed or not (credential-reads.ts), then the
 * secrets it would print into the conversation: each program and expression whose output reaches the
 * screen, read for the secret files it prints, the environment or secret variables it prints, a command whose output is
 * a secret, the inline code it runs, and the lines it runs somewhere else. `depth` counts the remote lines read on the
 * way here.
 */
export function shellFindings(command: string, context: ShellContext, rules: SecretRules, depth = 0): SecretFinding[] {
  const runs = runsOf(command, context);
  const inner = (line: string, dialect: ShellDialect): SecretFinding[] =>
    depth < MAX_REMOTE_DEPTH ? shellFindings(line, { cwd: undefined, home: context.home, dialect }, rules, depth + 1) : [];
  const printing = runs.programs.filter((run) => !quiet(run));
  const printingBare = runs.bare.filter((bare) => !quiet(bare));
  // Resolved as runsOf resolves where the line starts, so a run that moved nowhere has this same folder.
  const start: SearchStart = context.inWorkTree === undefined ? NO_SEARCH_START : { dir: new Location(context.cwd, context.home).dir, inWorkTree: context.inWorkTree };
  return uniqueFindings([
    ...credentialReadFindings(command, runs, start),
    ...printing.flatMap((run) => [
      ...fileFindings(run, rules),
      ...envFindings(run, rules.names),
      ...commandFindings(run, rules.commands),
      ...inlineFindings(run, rules),
      ...remoteFindings(run, inner),
    ]),
    ...printingBare.flatMap((bare) => [
      ...bareFindings(bare, rules.names),
      ...fileReadFindings(bare, { dialect: bare.dialect, dir: context.cwd, home: rules.home }, rules.paths),
    ]),
    ...(printingBare.some(readsEnvironment) ? environmentReads(command, rules.names) : []),
    ...(context.dialect === 'powershell' ? consoleWriteFindings(command, rules.names) : []),
  ]);
}
