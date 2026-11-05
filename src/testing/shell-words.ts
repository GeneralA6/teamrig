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

export const EXPRESSION_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git commit -m a<#x --no-verify', real: 'git commit -m "a<#x" --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m a>#b --no-verify', real: 'git commit -m "a>#b" --no-verify' },
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
