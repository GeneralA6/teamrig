import type { BareCommand, ProgramRun } from '../package-guard/programs.ts';
import type { ShellDialect, ShellWord } from '../push-guard/tokenizer.ts';
import { isPrinter } from './files.ts';
import type { SecretFinding } from './findings.ts';
import type { SecretNames } from './names.ts';

/** Programs that print their arguments, per dialect. */
const ECHOES: Readonly<Record<ShellDialect, ReadonlySet<string>>> = {
  bash: new Set(['echo', 'printf', 'print']),
  powershell: new Set([
    'write-output',
    'echo',
    'write',
    'write-host',
    'write-information',
    'write-warning',
    'write-error',
    'write-verbose',
    'write-debug',
    'out-host',
    'out-string',
    'out-default',
    'format-list',
    'fl',
    'format-table',
    'ft',
    'format-wide',
    'fw',
    'format-custom',
  ]),
  cmd: new Set(['echo']),
};

/** PowerShell commands that list or read the `env:` drive: `gci env:`, `Get-Content env:GITHUB_TOKEN`. */
const ENV_DRIVE_READERS: ReadonlySet<string> = new Set([
  'get-childitem',
  'gci',
  'ls',
  'dir',
  'get-item',
  'gi',
  'get-itemproperty',
  'gp',
  'get-itempropertyvalue',
  'gpv',
  'get-content',
  'gc',
  'cat',
  'type',
]);

/** `[Environment]::GetEnvironmentVariables()`, which returns every variable. */
const ENVIRONMENT_DUMP = /^\[(?:system\.)?environment\]::getenvironmentvariables$/;
/** `[Environment]::GetEnvironmentVariable('NAME')`, whose argument is read from the line by {@link environmentReads}. */
const ENVIRONMENT_READ = /^\[(?:system\.)?environment\]::getenvironmentvariable$/;

/**
 * A bash variable reference whose value the word prints: `$NAME`, `${NAME}`, `${NAME:-x}`, `${NAME:0:4}`; not its
 * length (`${#NAME}`), a test of whether it is set (`${NAME:+x}`) or an indirect `${!NAME}`.
 */
const BASH_REFERENCE = /\$(?:\{([#!]?)(\w+)([^}]*)\}|([A-Za-z_]\w*))/g;
/** A PowerShell `$env:NAME` or `${env:NAME}` whose value prints, not its `.Length`. */
const POWERSHELL_REFERENCE = /\$(?:\{env:(\w+)\}|env:(\w+))(?!\.Length\b)/gi;
/** A cmd `%NAME%`, or a part of it, `%NAME:~0,4%`. */
const CMD_REFERENCE = /%(\w+)(?::[^%]*)?%/g;

/** The variables whose value a text prints, in the dialect's spelling. */
export function printedNames(text: string, dialect: ShellDialect): string[] {
  switch (dialect) {
    case 'bash':
      return [...text.matchAll(BASH_REFERENCE)].flatMap(([, marker, braced, operator, plain]) => {
        if (plain !== undefined) {
          return [plain];
        }
        return marker === '' && !/^:?\+/.test(operator ?? '') ? [braced ?? ''] : [];
      });
    case 'powershell':
      return [...text.matchAll(POWERSHELL_REFERENCE)].map(([, braced, plain]) => braced ?? plain ?? '');
    case 'cmd':
      return [...text.matchAll(CMD_REFERENCE)].map(([, name]) => name ?? '');
  }
}

/** The secret variables the word prints: bash's parsed parts when the tokenizer kept them, else its text. */
function wordNames(word: ShellWord, dialect: ShellDialect): string[] {
  if (dialect === 'bash' && word.parts !== undefined) {
    return word.parts.flatMap((part) => (part.kind === 'variable' ? [part.name] : []));
  }
  return printedNames(word.text, dialect);
}

/** True when the program prints its arguments: `echo`, `printf`, `Write-Output`. */
export function echoes(run: ProgramRun): boolean {
  return ECHOES[run.dialect].has(run.name);
}

function variables(names: readonly string[], secrets: SecretNames): SecretFinding[] {
  return names.filter((name) => secrets.secret(name)).map((name) => ({ kind: 'variable', name }));
}

/** What a program prints from the environment: all of it (`printenv`, `export -p`, `gci env:`) or a secret variable. */
export function envFindings(run: ProgramRun, secrets: SecretNames): SecretFinding[] {
  const texts = run.args.map((arg) => arg.text);
  const options = texts.filter((text) => /^[-+]/.test(text));
  const operands = texts.filter((text) => !/^[-+]/.test(text));
  if (run.dialect === 'bash') {
    switch (run.name) {
      case 'printenv':
        return operands.length === 0 ? [{ kind: 'environment' }] : variables(operands, secrets);
      case 'set':
        return texts.length === 0 ? [{ kind: 'environment' }] : [];
      case 'export':
        return texts.every((text) => text === '-p') ? [{ kind: 'environment' }] : [];
      case 'declare':
      case 'typeset':
        return declareFindings(options, operands, secrets);
    }
  }
  if (run.dialect === 'powershell' && ENV_DRIVE_READERS.has(run.name)) {
    return texts.flatMap((text) => envDrive(text, secrets));
  }
  const echoed = echoes(run) ? run.args.flatMap((arg) => wordNames(arg, run.dialect)) : [];
  const fed = run.stdin !== undefined && run.stdin.dynamic && isPrinter(run.name) ? wordNames(run.stdin, run.dialect) : [];
  return variables([...echoed, ...fed], secrets);
}

/** `declare` and `typeset` print every variable with no name and no function option, and a named one with -p. */
function declareFindings(options: readonly string[], operands: readonly string[], secrets: SecretNames): SecretFinding[] {
  const letters = options.join('');
  if (operands.length === 0) {
    return /[fF]/.test(letters) ? [] : [{ kind: 'environment' }];
  }
  return letters.includes('p') ? variables(operands.filter((operand) => !operand.includes('=')), secrets) : [];
}

/** What a word naming the `env:` drive reads: the whole drive, a wildcard over it, or one variable. */
function envDrive(text: string, secrets: SecretNames): SecretFinding[] {
  const drive = /^env:[\\/]?(.*)$/i.exec(text);
  if (drive === null) {
    return [];
  }
  const name = drive[1] ?? '';
  return name === '' || /[*?[]/.test(name) ? [{ kind: 'environment' }] : variables([name], secrets);
}

/** A PowerShell comparison, which prints a boolean, not the values it compares: `$env:TOKEN -eq ''`. */
const COMPARISON = /^-[ci]?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|is|isnot)$/i;
/** PowerShell keywords whose `( )` is a condition or a loop, never printed. */
const CONDITIONS: ReadonlySet<string> = new Set(['if', 'elseif', 'while', 'until', 'switch', 'foreach', 'for']);

/** Words a bare `env` takes that make it print nothing: an emptied environment. */
const ENV_EMPTIED = new Set(['-i', '--ignore-environment', '-']);

/**
 * True when a command that starts no program prints its value: a PowerShell expression that is no assignment,
 * comparison or condition, or a bash `env`, which lists the variables it is given with the rest.
 */
export function printsValue(bare: BareCommand): boolean {
  const texts = bare.words.map((word) => word.text);
  const head = (texts[0] ?? '').toLowerCase();
  if (bare.dialect === 'powershell') {
    const assignment = /^(?:[-+*/%]|\?\?)?=$/.test(texts[1] ?? '') || /^\$[\w:{}?]+\s*(?:[-+*/%]|\?\?)?=/.test(head);
    return !assignment && !CONDITIONS.has(head) && !texts.some((text) => COMPARISON.test(text));
  }
  return bare.dialect === 'bash' && head === 'env' && !texts.some((text) => ENV_EMPTIED.has(text));
}

/** True for a PowerShell `[Type]::Member( )`: what it prints is what the call returns, not the arguments it takes. */
function isStaticCall(bare: BareCommand): boolean {
  const [head, group] = bare.words;
  return bare.dialect === 'powershell' && head !== undefined && group !== undefined && /^\[.*\]::/.test(head.text) && group.text.startsWith('(');
}

/** True when a command that starts no program prints what a substitution or a group hands it. */
export function printsHeld(bare: BareCommand): boolean {
  return printsValue(bare) && !isStaticCall(bare);
}

/**
 * What a command that starts no program prints from the environment: a bare `env`, cmd's `set` (with a prefix too,
 * which lists every variable it starts), or a PowerShell expression that prints every variable or a secret one. A
 * `[Type]::Member` at a statement's start is such an expression, never a program.
 */
export function bareFindings(bare: BareCommand, secrets: SecretNames): SecretFinding[] {
  const texts = bare.words.map((word) => word.text);
  const head = (texts[0] ?? '').toLowerCase();
  if (bare.dialect === 'bash' && head === 'env') {
    return printsValue(bare) ? [{ kind: 'environment' }] : [];
  }
  if (bare.dialect === 'cmd' && head === 'set') {
    const operand = texts[1];
    return operand === undefined || (!operand.startsWith('/') && !operand.includes('=')) ? [{ kind: 'environment' }] : [];
  }
  if (bare.dialect === 'powershell' && printsValue(bare)) {
    const printing = isStaticCall(bare) ? texts.slice(2) : texts;
    return ENVIRONMENT_DUMP.test(head) ? [{ kind: 'environment' }] : variables(printing.flatMap((text) => printedNames(text, 'powershell')), secrets);
  }
  return [];
}

/** True when a PowerShell expression prints what `[Environment]::GetEnvironmentVariable('NAME')` returns. */
export function readsEnvironment(bare: BareCommand): boolean {
  return bare.dialect === 'powershell' && printsValue(bare) && ENVIRONMENT_READ.test((bare.words[0]?.text ?? '').toLowerCase());
}

/** The variables `[Environment]::GetEnvironmentVariable('NAME')` reads on the line, outside an assignment. */
export function environmentReads(command: string, secrets: SecretNames): SecretFinding[] {
  const calls = command.matchAll(/(\$[\w:{}]+\s*=\s*)?\[(?:System\.)?Environment\]::GetEnvironmentVariable\s*\(\s*(['"])(\w+)\2/gi);
  return variables(
    [...calls].flatMap(([, assigned, , name]) => (assigned === undefined ? [name ?? ''] : [])),
    secrets,
  );
}
