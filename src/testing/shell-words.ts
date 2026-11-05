import type { ShellDialect } from '../push-guard/tokenizer.ts';

/**
 * Lines whose words the real shell reads differently from how they look, each one run through the real shell (T2002):
 * PowerShell 5.1 through its parser, Git Bash by `-c`, cmd by `/d /s /c`. A guard must judge what the shell runs, so
 * every guard is tried with the same rows.
 */
export interface ShellWordsRow {
  readonly dialect: ShellDialect;
  /** The line as written. */
  readonly typed: string;
  /** A plain line that runs the same thing. */
  readonly real: string;
}

/** The units PowerShell 5.1 ends a word at without ending the statement, from all 65,536 run through its parser. */
export const POWERSHELL_BLANKS: readonly string[] = [...'\t\v\f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000'];

/** The units that end a PowerShell statement outside quotes, from the same run. */
export const POWERSHELL_LINE_ENDS: readonly string[] = ['\n', '\r'];

/** The units that open and close a PowerShell literal string, from the same run. */
export const POWERSHELL_SINGLE_QUOTES: readonly string[] = ["'", '\u2018', '\u2019', '\u201a', '\u201b'];

/** The units that open and close a PowerShell expandable string, from the same run. */
export const POWERSHELL_DOUBLE_QUOTES: readonly string[] = ['"', '\u201c', '\u201d', '\u201e'];

/** Each letter a PowerShell backtick changes and what it gives, bare and in quotes alike, from the same run. */
export const POWERSHELL_ESCAPES: readonly (readonly [string, string])[] = [
  ['0', '\0'],
  ['a', '\x07'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
];

export const ESCAPE_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git commit -m x `\r--no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git push origin `\rmain --force', real: 'git push origin main --force' },
  { dialect: 'powershell', typed: 'npm install `\rleft-pad', real: 'npm install left-pad' },
  { dialect: 'powershell', typed: 'Get-Content a`\r\ngit push origin main', real: 'Get-Content "a\r"; git push origin main' },
  { dialect: 'powershell', typed: 'Get-Content a`\r\ngit commit -m x --no-verify', real: 'Get-Content "a\r"; git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'Get-Content a`\r\nnpm install left-pad', real: 'Get-Content "a\r"; npm install left-pad' },
  { dialect: 'powershell', typed: 'Get-Content a`\r\nRemove-Item b', real: 'Get-Content "a\r"; Remove-Item b' },
  { dialect: 'powershell', typed: 'Invoke-Expression "git status`ngit push origin main"', real: 'git status; git push origin main' },
  { dialect: 'powershell', typed: 'Invoke-Expression "git`tpush origin main"', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'Invoke-Expression "git commit -m x`t--no-verify"', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'Invoke-Expression "git status`rnpm install left-pad"', real: 'git status; npm install left-pad' },
  { dialect: 'powershell', typed: 'powershell -Command "git status`ngit push origin main"', real: 'git status; git push origin main' },
];

/** A NUL cuts a native call's line, a pwsh code point writes its character, and cmd's caret ends or joins a line. */
export const NUL_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git commit -m x --no-verify`0 --verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x "--no-verify`0" --verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x --no-verify\0 --verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x --no-verify`u{0} --verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git push origin main`0 --dry-run', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git push origin main --force`0 --dry-run', real: 'git push origin main --force' },
  { dialect: 'powershell', typed: 'npm install left-pad`0 --dry-run', real: 'npm install left-pad' },
  { dialect: 'powershell', typed: 'Get-Content a`0; Remove-Item b', real: 'Get-Content a; Remove-Item b' },
  { dialect: 'powershell', typed: 'Get-Content a\0; Remove-Item b', real: 'Get-Content a; Remove-Item b' },
  // Measured: a NUL does not end a comment.
  { dialect: 'powershell', typed: 'Get-Content a # note\0Remove-Item b', real: 'Get-Content a' },
  // A cmdlet keeps the NUL, so `Invoke-Expression` reads the text after it.
  { dialect: 'powershell', typed: 'Invoke-Expression "a`0; git push origin main"', real: 'a; git push origin main' },
  { dialect: 'powershell', typed: 'git commit -m x --no`u{2d}verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'Invoke-Expression "git`u{20}push origin main"', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'Invoke-Expression "git status`u{a}git push origin main"', real: 'git status; git push origin main' },
  { dialect: 'cmd', typed: 'git commit -m x --no-verify^\n --verify', real: 'git commit -m x --no-verify' },
  { dialect: 'cmd', typed: 'git commit -m x --no-verify^', real: 'git commit -m x --no-verify' },
  { dialect: 'cmd', typed: 'git push origin main --force^', real: 'git push origin main --force' },
];

export const QUOTE_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git commit -m x \u201c--no-verify\u201d', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x \u2018--no-verify\u2019', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x "--no-verify\u201d', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: "git commit -m x '--no-verify\u2019", real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git push \u201c--force\u201d origin own', real: 'git push --force origin own' },
  { dialect: 'powershell', typed: 'git push origin \u201cmain\u201d', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git \u201cpush\u201d origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: '\u201cgit\u201d commit -m x --no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'npm install \u201cleft-pad\u201d', real: 'npm install left-pad' },
  { dialect: 'powershell', typed: 'npm \u2018install\u2019 left-pad', real: 'npm install left-pad' },
  { dialect: 'powershell', typed: 'git commit -m "x"--no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: "git commit -m 'x'--no-verify", real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x "--no-verify"y', real: 'git commit -m x --no-verify y' },
  { dialect: 'powershell', typed: 'git commit -m x $(echo y)--no-verify', real: 'git commit -m x $(echo y) --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x @(1)--no-verify', real: 'git commit -m x @(1) --no-verify' },
  { dialect: 'powershell', typed: "git commit -m @'\nx\n'@--no-verify", real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: "git status '--%' x; git push origin main", real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status "--%" x; git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: "x @'\n '@ \"\n'@\ngit push origin main\n# \"", real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status --% a\rgit push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status --% "a\rgit push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status --% a && git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status --% %a|git\u0085push\u0085origin\u0085main;#%', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git commit --no-verify --% x\u00a0--verify', real: 'git commit --no-verify --% "x\u00a0--verify"' },
];

/**
 * An assignment runs its right side, whatever its target is: a variable, or any expression with a member or an index.
 * The rows with a bracket or a quote hold an `=` that opens nothing.
 */
const ASSIGNMENT_OPENERS = [
  '$h.a = ', '$h.a=', '$w[0]=', '$w[0] = ', '$w[ 0 ]=', '$p,$q=', '$p,$q = ', '$h.a += ', '[int]$h.a = ', '$a = $h.b = ', '$w[$a[0]]=', '$w[$i=0]=', '${a=b} = ', '$h."a=b" = ',
  "'x'.y = ", '"x".y = ', '(1).y = ', '$(1).y = ', '@(1).y = ', '(1)[0] = ', '[Console]::Title = ', '[System.Console]::Title = ', '[int]::y = ', '@{a=1}.a = ', '{x}.y = ', '$env:X = ',
];

/** One program of each kind a guard reads, as the real line runs it. */
const GUARDED_PROGRAMS = ['git push origin main', 'git commit -m x --no-verify', 'npm install left-pad'];

/** A `@{ }` runs its values and its `( )` keys; `P` stands for the program. */
const HASH_SHAPES = ['$x = @{a = P}', '$x = @{a=P}', '$x = @{a = 1; b = P}', "$x = @{'a' = P}", '$x = @{(P) = 1}', '@{a = P}'];

export const EXPRESSION_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git commit -m a<#x --no-verify', real: 'git commit -m "a<#x" --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m a<#x#>b --no-verify', real: 'git commit -m "a<#x#>b" --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m a>#b --no-verify', real: 'git commit -m "a>#b" --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x (echo y)--no-verify', real: 'git commit -m x (echo y) --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m a(echo b) --no-verify', real: 'git commit -m a (echo b) --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m "x".Length--no-verify', real: 'git commit -m "x".Length --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m $v.Length--no-verify', real: 'git commit -m $v.Length --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m $v[0]--no-verify', real: 'git commit -m $v[0] --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m "x".ToUpper()--no-verify', real: 'git commit -m "x".ToUpper() --no-verify' },
  { dialect: 'powershell', typed: '$x = @{a = b |\n git push origin main}', real: 'b | git push origin main' },
  // A keyword's block ends its statement, so what follows is a command, not an argument.
  ...GUARDED_PROGRAMS.map((real) => ({ dialect: 'powershell' as const, typed: `do {} while (0) ${real}`, real })),
  ...ASSIGNMENT_OPENERS.flatMap((opener) => GUARDED_PROGRAMS.map((real) => ({ dialect: 'powershell' as const, typed: `${opener}${real}`, real }))),
  ...HASH_SHAPES.flatMap((shape) => GUARDED_PROGRAMS.map((real) => ({ dialect: 'powershell' as const, typed: shape.replace('P', () => real), real }))),
];

/**
 * A value among a program's arguments stands for one word whose text is only known when it runs. Its word keeps its
 * source, so `real` shows the line a guard must judge it by, not one with the same text.
 */
export const VALUE_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git commit (echo -m) x --no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m {x} --no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x{y} --no-verify', real: 'git commit -m x y --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m @{a=1} --no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git push (echo origin) main', real: 'git push origin main' },
  // The branch is unknown here, as for `$( )`: the guard asks, where a plain `main` would be refused.
  { dialect: 'powershell', typed: 'git push origin (echo main) --force', real: 'git push origin $(echo main) --force' },
  { dialect: 'powershell', typed: 'npm install (echo left-pad)', real: 'npm install left-pad' },
];

export const BLANK_AND_LINE_END_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'Get-Content a\rRemove-Item b', real: 'Get-Content a; Remove-Item b' },
  { dialect: 'powershell', typed: 'Get-Content a\rgit commit -m x --no-verify', real: 'Get-Content a; git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'Get-Content a\rgit push origin main', real: 'Get-Content a; git push origin main' },
  { dialect: 'powershell', typed: 'Get-Content a\rnpm install left-pad', real: 'Get-Content a; npm install left-pad' },
  { dialect: 'powershell', typed: 'Get-Content a # note\rRemove-Item b', real: 'Get-Content a; Remove-Item b' },
  { dialect: 'powershell', typed: 'git status # note\rgit push origin main', real: 'git status; git push origin main' },
  { dialect: 'powershell', typed: 'git status # note\rgit commit -m x --no-verify', real: 'git status; git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git status # note\rnpm install left-pad', real: 'git status; npm install left-pad' },
  { dialect: 'powershell', typed: 'git commit -m x\u0085--no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git push\u0085origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'npm\u0085install left-pad', real: 'npm install left-pad' },
  { dialect: 'powershell', typed: 'git commit --no-verify x\ufeff--verify', real: 'git commit --no-verify "x\ufeff--verify"' },
  { dialect: 'powershell', typed: "Start-Process git -ArgumentList 'commit --no-verify x\u00a0--verify'", real: 'git commit --no-verify "x\u00a0--verify"' },
  { dialect: 'powershell', typed: "Start-Process git -ArgumentList 'commit --no-verify x\u0085--verify'", real: 'git commit --no-verify "x\u0085--verify"' },
  { dialect: 'bash', typed: 'B=main; git pu\rsh origin $B', real: 'B=main; git push origin $B' },
  { dialect: 'bash', typed: 'B=ma\rin; git push origin $B', real: 'B=main; git push origin $B' },
  { dialect: 'bash', typed: 'B=main\r\ngit push origin $B', real: 'B=main; git push origin $B' },
  { dialect: 'bash', typed: 'F=--no-ver\rify; git commit -m x $F', real: 'F=--no-verify; git commit -m x $F' },
  { dialect: 'bash', typed: 'git commit --no-verify x\u00a0--verify', real: "git commit --no-verify 'x\u00a0--verify'" },
  { dialect: 'bash', typed: 'git commit --no-verify x\u2003--verify', real: "git commit --no-verify 'x\u2003--verify'" },
  { dialect: 'bash', typed: 'git commit --no-verify x\u3000--verify', real: "git commit --no-verify 'x\u3000--verify'" },
  { dialect: 'bash', typed: 'git commit --no-verify x\u000b--verify', real: "git commit --no-verify 'x\u000b--verify'" },
  { dialect: 'bash', typed: 'git commit --no-verify x\u000c--verify', real: "git commit --no-verify 'x\u000c--verify'" },
  { dialect: 'bash', typed: 'git commit --no-verify x\ufeff--verify', real: "git commit --no-verify 'x\ufeff--verify'" },
  { dialect: 'bash', typed: 'git commit --no-verify x\r--verify', real: 'git commit --no-verify x--verify' },
  { dialect: 'bash', typed: 'git commit -m x --no\r-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'bash', typed: 'git commit -m x --no-verify\r', real: 'git commit -m x --no-verify' },
  { dialect: 'bash', typed: 'git pu\rsh origin main', real: 'git push origin main' },
  { dialect: 'bash', typed: 'npm inst\rall left-pad', real: 'npm install left-pad' },
  { dialect: 'cmd', typed: 'git commit --no-verify x\u00a0--verify', real: 'git commit --no-verify "x\u00a0--verify"' },
  { dialect: 'cmd', typed: 'git commit -m x --no\r-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'cmd', typed: 'git pu\rsh origin main', real: 'git push origin main' },
  { dialect: 'cmd', typed: 'npm inst\rall left-pad', real: 'npm install left-pad' },
  { dialect: 'cmd', typed: 'git commit -m x "--no-verify\n"', real: 'git commit -m x --no-verify' },
];
