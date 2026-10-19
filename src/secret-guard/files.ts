import type { ProgramRun } from '../package-guard/programs.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import type { SecretFinding } from './findings.ts';
import { wordPath, type WordPlace } from './paths.ts';
import type { SecretRules } from './rules.ts';

/** Programs that print the content of the files they name, or of what they read on stdin. */
const PRINTERS: ReadonlySet<string> = new Set([
  'cat',
  'tac',
  'nl',
  'head',
  'tail',
  'less',
  'more',
  'most',
  'bat',
  'batcat',
  'grep',
  'egrep',
  'fgrep',
  'zgrep',
  'rg',
  'ag',
  'ack',
  'sed',
  'gsed',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'cut',
  'sort',
  'uniq',
  'paste',
  'join',
  'column',
  'fold',
  'fmt',
  'tr',
  'rev',
  'pr',
  'expand',
  'od',
  'xxd',
  'hexdump',
  'hd',
  'strings',
  'base64',
  'base32',
  'basenc',
  'jq',
  'yq',
  'gojq',
  'diff',
  'sdiff',
  'diff3',
  'comm',
  'iconv',
  'zcat',
  'dd',
  'type',
  'findstr',
  'get-content',
  'gc',
  'select-string',
  'sls',
  'import-csv',
  'ipcsv',
  'format-hex',
  'fhx',
]);

/** git subcommands that print what they name: a file at a revision (`HEAD:.env`) or its changes. */
const GIT_PRINTS = new Set(['show', 'diff', 'blame', 'annotate', 'grep', 'cat-file', 'difftool']);
/** git subcommands that print a file's changes only with a patch option. */
const GIT_LOGS = new Set(['log', 'whatchanged']);
const GIT_PATCH = /^(?:-p|-u|--patch(?:-with-stat|-with-raw)?|--word-diff(?:=.*)?|-L.*)$/;
/** git options before the subcommand that take the next word as their value. */
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);

/** A file every process's environment lives in, as a bash line names it. */
const ENVIRON = /^\/proc\/[^/]+\/environ$/;

/** True when the program prints the files it names, or its stdin. */
export function isPrinter(name: string): boolean {
  return PRINTERS.has(name);
}

/** The secret files the program prints: the words it reads as files, and the file a `<` feeds it. */
export function fileFindings(run: ProgramRun, rules: SecretRules): SecretFinding[] {
  const place: WordPlace = { dialect: run.dialect, dir: run.dir, home: rules.home };
  const named = run.name === 'git' ? gitNamed(run.args) : isPrinter(run.name) ? [...run.args.flatMap(fileWords), ...stdinFiles(run)] : [];
  return named.flatMap((text): SecretFinding[] => {
    const path = wordPath(text, place);
    if (ENVIRON.test(text)) {
      return [{ kind: 'environment' }];
    }
    return rules.paths.mayName(path, run.dialect !== 'bash') ? [{ kind: 'file', path: text }] : [];
  });
}

/** The texts a word may name a file by: the word, a `--file=x` option's value, `dd if=x`; never a bare option. */
function fileWords(word: ShellWord): string[] {
  const valued = /^(?:--?[\w-]+=|if=)(.+)$/.exec(word.text);
  if (valued !== null) {
    return [valued[1] ?? ''];
  }
  return word.text.startsWith('-') ? [] : [word.text];
}

/** The files the program reads on stdin through `<`. */
function stdinFiles(run: ProgramRun): string[] {
  return run.redirections.flatMap(({ operator, target }) => (/^0?<$/.test(operator) && target !== undefined ? [target.text] : []));
}

/**
 * What a git call prints by name: each path and `rev:path` of `show`, `diff`, `blame` and their kind, and those of
 * `log` with a patch option. A diff with no path, or a search, may print a tracked secret it never names: a gap.
 */
function gitNamed(args: readonly ShellWord[]): string[] {
  const texts = args.map((arg) => arg.text);
  let index = 0;
  while (index < texts.length && (texts[index] ?? '').startsWith('-')) {
    index += GIT_VALUED.has(texts[index] ?? '') ? 2 : 1;
  }
  const subcommand = texts[index];
  const rest = texts.slice(index + 1);
  const prints = subcommand !== undefined && (GIT_PRINTS.has(subcommand) || (GIT_LOGS.has(subcommand) && rest.some((text) => GIT_PATCH.test(text))));
  if (!prints) {
    return [];
  }
  return rest.filter((text) => !text.startsWith('-')).flatMap((text) => {
    const revision = /^(?![A-Za-z]:[\\/])[^:]*:(.+)$/.exec(text);
    return revision === null ? [text] : [revision[1] ?? ''];
  });
}
