import type { BareCommand } from '../package-guard/programs.ts';
import { environmentReads, printedNames, printsValue } from './env.ts';
import type { SecretFinding } from './findings.ts';
import type { SecretNames } from './names.ts';
import { wordPath, type SecretPaths, type WordPlace } from './paths.ts';

/**
 * PowerShell's `[Console]` writes: `[Console]::WriteLine(x)`, `[Console]::Out.Write(x)`, `[Console]::Error.WriteLine(x)`.
 * They write to the console themselves, so they print what they are given in an assignment or a condition too, and a
 * redirection of the statement does not take their output.
 */
const CONSOLE_WRITE = /\[(?:system\.)?console\]::(?:(?:out|error)\.)?write(?:line)?\s*\(/gi;

/**
 * .NET's whole-file reads, which return a file's content (`[IO.File]::ReadAllText(".env")`). They take the path as
 * it is, with no wildcards, so it is read as a path, never as a glob.
 */
const FILE_READ = /^\[(?:system\.)?io\.file\]::read(?:alltext|alllines|allbytes|lines)(?:async)?$/;

/** The secret variables each `[Console]` write on a PowerShell line prints, its arguments read as the line spells them. */
export function consoleWriteFindings(command: string, secrets: SecretNames): SecretFinding[] {
  return [...command.matchAll(CONSOLE_WRITE)].flatMap((match) => {
    const args = groupFrom(command, match.index + match[0].length);
    return [
      ...printedNames(args, 'powershell')
        .filter((name) => secrets.secret(name))
        .map((name): SecretFinding => ({ kind: 'variable', name })),
      ...environmentReads(args, secrets),
    ];
  });
}

/**
 * The secret file a PowerShell statement prints by a .NET whole-file read at its start: `[IO.File]::ReadAllText(".env")`.
 * Only a path the line spells out is read; one held in a variable is only known when it runs.
 */
export function fileReadFindings(bare: BareCommand, place: WordPlace, paths: SecretPaths): SecretFinding[] {
  const [head, group] = bare.words;
  if (bare.dialect !== 'powershell' || head === undefined || group === undefined || !group.text.startsWith('(')) {
    return [];
  }
  if (!FILE_READ.test(head.text.toLowerCase()) || !printsValue(bare)) {
    return [];
  }
  const path = unquoted(firstArgument(groupFrom(group.text, 1)));
  return path !== '' && paths.listed(wordPath(path, place)) ? [{ kind: 'file', path }] : [];
}

/**
 * The text of the `( )` group whose `(` ends just before `start`, up to its closing `)`, skipping PowerShell quotes;
 * the rest of the text when it never closes, the safe side.
 */
export function groupFrom(text: string, start: number): string {
  let depth = 0;
  const end = scanUnquoted(text, start, (char) => {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    }
    return depth < 0;
  });
  return text.slice(start, end);
}

/** The first argument of a call's argument list, up to its first comma outside quotes and groups. */
function firstArgument(args: string): string {
  let depth = 0;
  const end = scanUnquoted(args, 0, (char) => {
    if ('([{'.includes(char)) {
      depth += 1;
    } else if (')]}'.includes(char)) {
      depth -= 1;
    }
    return char === ',' && depth === 0;
  });
  return args.slice(0, end).trim();
}

/**
 * Hands `stop` each character of `text` from `start` that stands outside a PowerShell quote (`'...'`, or `"..."`
 * with its backtick escapes), and returns the index of the first it stops at, or the text's length.
 */
function scanUnquoted(text: string, start: number, stop: (char: string) => boolean): number {
  let quote: string | undefined;
  for (let index = start; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quote !== undefined) {
      if (quote === '"' && char === '`') {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (stop(char)) {
      return index;
    }
  }
  return text.length;
}

/** A PowerShell string's text: `'a''b'` is `a'b`, `"a"` is `a`; any other argument as it is. */
function unquoted(arg: string): string {
  const single = /^'([\s\S]*)'$/.exec(arg);
  if (single !== null) {
    return (single[1] ?? '').replaceAll("''", "'");
  }
  const double = /^"([\s\S]*)"$/.exec(arg);
  return double === null ? arg : (double[1] ?? '');
}
