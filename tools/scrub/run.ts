import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_USAGE } from '../lib/exit.ts';
import type { Git } from '../lib/git.ts';
import { parseDenylist } from './denylist.ts';
import { GENERIC_RULES, type ScrubRule } from './rules.ts';
import { formatFinding, scanText, type Finding } from './scan.ts';
import {
  commitMessageInputs,
  isBinary,
  messageFileInput,
  stagedInputs,
  treeInputs,
  type ReadFile,
  type ScanInput,
} from './sources.ts';

export interface ScrubOptions {
  readonly staged: boolean;
  readonly tree: boolean;
  /** A commit message file (the commit-msg hook's argument). */
  readonly messageFile: string | undefined;
  /** Scan the messages of the commits in this revision range. */
  readonly range: string | undefined;
  /** Explicit denylist path; otherwise git config `teamrig.scrubDenylist`, if set. */
  readonly denylistPath: string | undefined;
}

export interface ScrubDeps {
  readonly git: Git;
  readonly readFile: ReadFile;
  readonly out: (line: string) => void;
}

export const DENYLIST_CONFIG_KEY = 'teamrig.scrubDenylist';

export async function runScrub(options: ScrubOptions, deps: ScrubDeps): Promise<number> {
  if (!options.staged && !options.tree && options.messageFile === undefined && options.range === undefined) {
    deps.out('scrub: nothing to scan; pass --staged, --tree, --message <file> or --range <revisions>');
    return EXIT_USAGE;
  }
  const denylist = await loadDenylist(options.denylistPath, deps);
  if (typeof denylist === 'string') {
    deps.out(`scrub: ${denylist}`);
    return EXIT_USAGE;
  }
  const rules: readonly ScrubRule[] = [...GENERIC_RULES, ...denylist];
  const inputs = await collectInputs(options, deps);
  const findings: Finding[] = [];
  let binaries = 0;
  for (const input of inputs) {
    if (isBinary(input.content)) {
      binaries += 1;
      continue;
    }
    findings.push(...scanText(input.source, input.content.toString(), rules));
  }
  for (const finding of findings) {
    deps.out(formatFinding(finding));
  }
  const scope =
    `${inputs.length - binaries} input(s), ${binaries} binary skipped, ` +
    `${GENERIC_RULES.length} generic + ${denylist.length} private rule(s)`;
  deps.out(findings.length === 0 ? `scrub: clean (${scope})` : `scrub: ${findings.length} finding(s) (${scope})`);
  return findings.length === 0 ? EXIT_CLEAN : EXIT_FINDINGS;
}

/** Returns the denylist rules, or an error message. A configured list that is missing or empty fails closed. */
async function loadDenylist(explicitPath: string | undefined, deps: ScrubDeps): Promise<ScrubRule[] | string> {
  const path = explicitPath ?? (await deps.git.text(['config', '--default', '', '--get', DENYLIST_CONFIG_KEY])).trim();
  if (path === '') {
    return [];
  }
  let text: string;
  try {
    text = (await deps.readFile(path)).toString('utf8');
  } catch (error) {
    return `cannot read the private denylist (${errorMessage(error)}); refusing to scan without it`;
  }
  try {
    const rules = parseDenylist(text);
    return rules.length > 0 ? rules : 'the private denylist has no rules; refusing to scan without it';
  } catch (error) {
    return errorMessage(error);
  }
}

async function collectInputs(options: ScrubOptions, deps: ScrubDeps): Promise<ScanInput[]> {
  const inputs: ScanInput[] = [];
  if (options.staged) {
    inputs.push(...(await stagedInputs(deps.git)));
  }
  if (options.tree) {
    inputs.push(...(await treeInputs(deps.git, deps.readFile)));
  }
  if (options.messageFile !== undefined) {
    const text = (await deps.readFile(options.messageFile)).toString('utf8');
    inputs.push(messageFileInput(options.messageFile, text));
  }
  if (options.range !== undefined) {
    inputs.push(...(await commitMessageInputs(deps.git, options.range)));
  }
  return inputs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
