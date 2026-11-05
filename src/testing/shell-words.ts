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
  // Between words a backtick before a blank is only a gap, so the word after it starts with no blank.
  { dialect: 'powershell', typed: 'git commit -m x ` --no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git push origin ` main --force', real: 'git push origin main --force' },
  { dialect: 'powershell', typed: '` git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status;` git push origin main', real: 'git status; git push origin main' },
  { dialect: 'powershell', typed: 'npm install ` left-pad', real: 'npm install left-pad' },
  { dialect: 'powershell', typed: 'git push origin own,` main', real: 'git push origin own main' },
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

/**
 * An array around a NUL, measured on 5.1: the elements the cut dropped still count, so a gap among them splits the array the
 * line kept, and a value that opens with the NUL keeps the comma before it.
 */
export const CUT_ARRAY_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git commit -m x a,"--no-verify`0",c ,d', real: 'git commit -m x a --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x a,"--no-verify`0b",c, d', real: 'git commit -m x a --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x a,"--no-verify`0",c,#x\nd', real: 'git commit -m x a --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x a,"--no-verify`0",c,d ,e', real: 'git commit -m x a --no-verify' },
  { dialect: 'powershell', typed: `git commit -m x a,'b',"--no-verify\`0",c ,d`, real: 'git commit -m x a b --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x "--no-verify`0",c ,d', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git push origin,main,"--force`0",c ,d', real: 'git push origin main --force' },
  // A gap behind a later word, or a comment, splits nothing the line kept.
  { dialect: 'powershell', typed: 'git commit -m x a,"--no-verify`0" c ,d', real: `git commit -m x 'a,--no-verify'` },
  { dialect: 'powershell', typed: 'git commit -m x a,"--no-verify`0",c<#x#>,d', real: `git commit -m x 'a,--no-verify'` },
  { dialect: 'powershell', typed: 'git status a,"`0b",c,d', real: `git status 'a,'` },
  { dialect: 'powershell', typed: 'git status a,"`0b" c ,d', real: `git status 'a,'` },
  { dialect: 'powershell', typed: 'git status a,"`0b",c ,d', real: 'git status a' },
  { dialect: 'powershell', typed: 'git status "`0b",c,d', real: 'git status' },
  { dialect: 'powershell', typed: `git status '',"\`0b",c`, real: 'git status' },
  { dialect: 'powershell', typed: `git status a,"\`0",''`, real: `git status 'a,'` },
  { dialect: 'powershell', typed: `git status a,'b',"\`0",c`, real: `git status 'a,b,'` },
  { dialect: 'powershell', typed: 'git status -x:a,"`0b",c', real: `git status '-x:a,'` },
  { dialect: 'powershell', typed: 'git commit -m x --no-verify,"`0"', real: `git commit -m x '--no-verify,'` },
  // Behind the binder's marker a NUL cuts only its own value, so nothing is dropped and the array's gaps stand where they are.
  { dialect: 'powershell', typed: `git status '--%' a,"\`0b",d,e`, real: `git status 'a,,d,e'` },
  { dialect: 'powershell', typed: `git status '--%' "\`0b",d,e`, real: `git status ',d,e'` },
  { dialect: 'powershell', typed: `git status '--%' "\`0b" c`, real: 'git status c' },
  { dialect: 'powershell', typed: `git status '--%' a,"b\`0c",d ,e`, real: 'git status a b d e' },
  { dialect: 'powershell', typed: `git status '--%' a,"b\`0c",d,e`, real: `git status 'a,b,d,e'` },
  { dialect: 'powershell', typed: `git status '--%' a,"b\`0c" d ,e`, real: `git status 'a,b' d e` },
  // The next command counts its own words.
  { dialect: 'powershell', typed: 'git status a,"a`0b",c ,d; git status e,f g ,h', real: `git status a a; git status 'e,f' g h` },
  { dialect: 'powershell', typed: 'git status a,"a`0b" c ,d; git status e,f g,h', real: `git status 'a,a'; git status 'e,f' 'g,h'` },
];

/**
 * A first unit newer than 5.1's Unicode opens no parameter there, so the quotes after it join one word and the text after
 * them is no option of its own. Measured on 5.1; pwsh takes the letter, so the two differ.
 */
export const PARAMETER_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git commit --no-verify -m -\ua7c2:"x"--verify', real: 'git commit --no-verify -m "-\ua7c2:x--verify"' },
  { dialect: 'powershell', typed: 'git push origin main --force -\ua7c2:"x"--dry-run', real: 'git push origin main --force "-\ua7c2:x--dry-run"' },
  { dialect: 'powershell', typed: 'npm install left-pad -\ua7c2:"x"--dry-run', real: 'npm install left-pad "-\ua7c2:x--dry-run"' },
];

/**
 * 5.1 hands a native program one line, which the program's C runtime splits again: a lone `"` swallows the next word, a
 * `\"` opens nothing and an empty value drops. Each row's words are what node and git got from 5.1, run for real.
 */
export const NATIVE_LINE_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: `git commit --no-verify 'a"' --verify`, real: `git commit --no-verify 'a --verify'` },
  { dialect: 'powershell', typed: `git commit --no-verify -m '' --verify`, real: 'git commit --no-verify -m --verify' },
  { dialect: 'powershell', typed: `git commit 'a\\" --no-verify'`, real: `git commit 'a\\"' --no-verify` },
  { dialect: 'powershell', typed: `git -c 'a=b\\" push origin main'`, real: `git -c 'a=b\\"' push origin main` },
  { dialect: 'powershell', typed: `git '' push origin main`, real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git commit --no-verify "a",--verify', real: `git commit --no-verify 'a,--verify'` },
  // Past a comma a `-name:` token ends at its colon, so its value is an argument of its own.
  { dialect: 'powershell', typed: 'git commit -m a,-n:--no-verify', real: `git commit -m 'a,-n:' --no-verify` },
  { dialect: 'powershell', typed: 'git push origin own,-n:--force', real: `git push origin 'own,-n:' --force` },
  { dialect: 'powershell', typed: 'npm install a,-n:left-pad', real: `npm install 'a,-n:' left-pad` },
  // Behind a value of `--%` the binder writes the rest bare, so one quoted word comes apart.
  { dialect: 'powershell', typed: `git commit '--%' 'a --no-verify b'`, real: 'git commit a --no-verify b' },
  { dialect: 'powershell', typed: `git commit -y:--% 'a --no-verify b'`, real: 'git commit -y: a --no-verify b' },
  { dialect: 'powershell', typed: `git commit -y: --% 'a --no-verify b'`, real: 'git commit -y: a --no-verify b' },
  { dialect: 'powershell', typed: `git commit '--%' "a\`0b c" --no-verify`, real: 'git commit a --no-verify' },
  { dialect: 'powershell', typed: `git push origin '--%' 'main --force'`, real: 'git push origin main --force' },
  { dialect: 'powershell', typed: `npm install '--%' 'a left-pad'`, real: 'npm install a left-pad' },
  // A `-name` token right behind a whole value of `--%` turns on the parser's marker: both leave the line.
  { dialect: 'powershell', typed: `git commit '--%' -y:--no-verify`, real: 'git commit --no-verify' },
  { dialect: 'powershell', typed: `git '--%' -y:push origin main`, real: 'git push origin main' },
  { dialect: 'powershell', typed: `git push origin '--%' -y:--force`, real: 'git push origin --force' },
  { dialect: 'powershell', typed: `npm '--%' -y:install left-pad`, real: 'npm install left-pad' },
];

/**
 * The text of a `--%` starts right behind it, so a closer there is the program's: an option's value takes the stray character
 * and the words behind it still reach the program. Each row's words are what node and git got from 5.1, run for real.
 */
export const MARKER_TEXT_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git commit -m --%; --no-verify', real: `git commit -m ';' --no-verify` },
  { dialect: 'powershell', typed: 'git commit -m --%& --no-verify', real: `git commit -m '&' --no-verify` },
  { dialect: 'powershell', typed: 'git commit -m --%) --no-verify', real: `git commit -m ')' --no-verify` },
  { dialect: 'powershell', typed: 'git commit -m --%} --no-verify', real: `git commit -m '}' --no-verify` },
  { dialect: 'powershell', typed: 'git push --repo --%; --force origin main', real: `git push --repo ';' --force origin main` },
  { dialect: 'powershell', typed: 'git push --repo --%) --force origin main', real: `git push --repo ')' --force origin main` },
  { dialect: 'powershell', typed: 'npm install --%; left-pad', real: `npm install ';' left-pad` },
  { dialect: 'powershell', typed: 'npm install --%) left-pad', real: `npm install ')' left-pad` },
];

/**
 * The parser's `--%` never reaches the program, so an option ahead of it takes the word behind it as its value. Each row ran
 * for real on 5.1: `git -C --% repo push origin main --force` landed a non-fast-forward from `repo`.
 */
export const MARKER_VALUE_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git -c --% core.hooksPath=x commit -m y', real: 'git -c core.hooksPath=x commit -m y' },
  { dialect: 'powershell', typed: 'git -C --% other push origin main --force', real: 'git -C other push origin main --force' },
  { dialect: 'powershell', typed: 'git --git-dir --% x push origin main --force', real: 'git --git-dir x push origin main --force' },
  { dialect: 'powershell', typed: 'npm --prefix --% x install left-pad', real: 'npm --prefix x install left-pad' },
];

/**
 * An array opened by a quoted `--%` stays an argument, and a `-name` token right behind it leaves the rest of the command as
 * one value, which the binder writes in its own quotes: a `"` in that text closes them, so the words inside it reach the
 * program. Each row's words are what node and git got from 5.1, run for real.
 */
export const MARKER_ARRAY_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: `git commit '--%',a -y m" "--no-verify" "n o`, real: `git commit '--%,a' m --no-verify 'n o'` },
  { dialect: 'powershell', typed: `git commit -m '--%',a -y m" "--no-verify" "n o`, real: `git commit -m '--%,a' m --no-verify 'n o'` },
  { dialect: 'powershell', typed: `git commit -m x '--%',a -y m" "--no-verify" "n o`, real: `git commit -m x '--%,a' m --no-verify 'n o'` },
  { dialect: 'powershell', typed: `git commit "--%",a -y m" "--no-verify" "n o`, real: `git commit '--%,a' m --no-verify 'n o'` },
  { dialect: 'powershell', typed: `git commit '--%',a,b -y m" "--no-verify" "n o`, real: `git commit '--%,a,b' m --no-verify 'n o'` },
  { dialect: 'powershell', typed: `git commit '--%',a -y: m" "--no-verify" "n o`, real: `git commit '--%,a' m --no-verify 'n o'` },
  { dialect: 'powershell', typed: `git commit '--%',a -y:v m" "--no-verify" "n o`, real: `git commit '--%,a' 'v m' --no-verify 'n o'` },
  { dialect: 'powershell', typed: `git commit '--%',a <#c#> -y m" "--no-verify" "n o`, real: `git commit '--%,a' m --no-verify 'n o'` },
  { dialect: 'powershell', typed: `git push '--%',a -y origin" "--force" "main x`, real: `git push '--%,a' origin --force 'main x'` },
  { dialect: 'powershell', typed: `git push origin main '--%',a -y x" "--force" "y z`, real: `git push origin main '--%,a' x --force 'y z'` },
  { dialect: 'powershell', typed: `npm '--%',a -y m" "install" "left-pad z`, real: `npm '--%,a' m install 'left-pad z'` },
];

/**
 * A chain on a quoted `--%` that gives the value back is the binder's marker, with no token and no text the parser ever saw
 * as one: what follows is written bare, so a quoted word comes apart and an option inside it reaches the program as a word
 * of its own. The value is only known when the line runs. Each row's words are what node and git got from 5.1, run for real.
 */
export const MARKER_CHAIN_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: `git commit '--%'.Trim() "--no-verify -mx"`, real: 'git commit --no-verify -mx' },
  { dialect: 'powershell', typed: `git commit -m x '--%'.Trim() "--no-verify -my"`, real: 'git commit -m x --no-verify -my' },
  { dialect: 'powershell', typed: `git commit '--%'.ToString() "--no-verify -mx"`, real: 'git commit --no-verify -mx' },
  { dialect: 'powershell', typed: `git commit "--%".Trim() "--no-verify -mx"`, real: 'git commit --no-verify -mx' },
  { dialect: 'powershell', typed: 'git commit "-`-%".Trim() "--no-verify -mx"', real: 'git commit --no-verify -mx' },
  { dialect: 'powershell', typed: `git push '--%'.Trim() "origin main --force"`, real: 'git push origin main --force' },
  { dialect: 'powershell', typed: `npm '--%'.Trim() "install left-pad"`, real: 'npm install left-pad' },
  // A NUL further on takes the line down the readings' other branch, and cuts only its own value.
  { dialect: 'powershell', typed: `git commit '--%'.Trim() "--no-verify -mx" "\`0"`, real: 'git commit --no-verify -mx' },
];

/**
 * Behind a digit word or `*`, PowerShell's `<` redirects nothing: it is word text, so neither the next word nor a `#` behind
 * it goes. Each row's words are what node got from 5.1, run for real.
 */
export const REDIRECTION_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git commit 1<#x --no-verify', real: `git commit '1<#x' --no-verify` },
  { dialect: 'powershell', typed: 'git commit 1< --no-verify', real: `git commit '1<' --no-verify` },
  { dialect: 'powershell', typed: 'git commit *< --no-verify', real: `git commit '*<' --no-verify` },
  { dialect: 'powershell', typed: 'git push origin main 1<#x --force', real: `git push origin main '1<#x' --force` },
  { dialect: 'powershell', typed: 'git push origin main 1< --force', real: `git push origin main '1<' --force` },
  { dialect: 'powershell', typed: 'npm install *<#x left-pad', real: `npm install '*<#x' left-pad` },
  { dialect: 'powershell', typed: 'npm install 1< left-pad', real: `npm install '1<' left-pad` },
];

/** A `.` right ahead of a plain quote is a word of its own, and at a head it starts what follows: run for real on 5.1. */
export const LONE_DOT_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: '."git" push origin main --force', real: '. git push origin main --force' },
  { dialect: 'powershell', typed: `.'git' push origin main --force`, real: '. git push origin main --force' },
  { dialect: 'powershell', typed: '."git" commit --no-verify -m x', real: '. git commit --no-verify -m x' },
  { dialect: 'powershell', typed: '."npm" install left-pad', real: '. npm install left-pad' },
  { dialect: 'powershell', typed: 'Write-Output x | ."git" push origin main --force', real: 'Write-Output x | . git push origin main --force' },
  { dialect: 'powershell', typed: '$r = ."git" push origin main --force', real: '$r = . git push origin main --force' },
];

/** A `-name` with a `.` or `[` right behind it is cut there, and what follows is a word of its own: run for real on 5.1. */
export const CUT_PARAMETER_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'powershell -c."git push origin main --force"', real: 'powershell -c . "git push origin main --force"' },
  { dialect: 'powershell', typed: 'powershell -Command."git push origin main --force"', real: 'powershell -Command . "git push origin main --force"' },
  { dialect: 'powershell', typed: 'pwsh -c."git push origin main --force"', real: 'pwsh -c . "git push origin main --force"' },
  { dialect: 'powershell', typed: `powershell -c.'git push origin main --force'`, real: `powershell -c . 'git push origin main --force'` },
  { dialect: 'powershell', typed: 'powershell -c."git commit --no-verify -m x"', real: 'powershell -c . "git commit --no-verify -m x"' },
  { dialect: 'powershell', typed: 'git push -u.x main', real: 'git push -u .x main' },
  { dialect: 'powershell', typed: 'git push -x:-u.y main', real: 'git push -x:-u .y main' },
  { dialect: 'powershell', typed: 'git push -x: -u.y main', real: 'git push -x: -u .y main' },
  // In a value's place a `-name:` token ends at its colon, so what follows is an argument of its own.
  { dialect: 'powershell', typed: 'git commit -y:-z:--no-verify', real: 'git commit -y:-z: --no-verify' },
  { dialect: 'powershell', typed: 'git commit -y: -z:--no-verify', real: 'git commit -y: -z: --no-verify' },
  { dialect: 'powershell', typed: 'git push origin own -y:-z:--force', real: 'git push origin own -y:-z: --force' },
  { dialect: 'powershell', typed: 'git -y:-z:push origin main', real: 'git -y:-z: push origin main' },
  { dialect: 'powershell', typed: 'git -y: -z:push origin main', real: 'git -y: -z: push origin main' },
  { dialect: 'powershell', typed: 'npm install -y:-z:left-pad', real: 'npm install -y:-z: left-pad' },
  { dialect: 'powershell', typed: 'npm -y:-z:install left-pad', real: 'npm -y:-z: install left-pad' },
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
  // An array's element is no marker, so the `;` still ends the statement.
  { dialect: 'powershell', typed: 'git status a,--% b;git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status a, --% b;git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status a,\n--% b;git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status a,--% b;git commit -m x --no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git status a,--% b;npm install left-pad', real: 'npm install left-pad' },
  // Nor is a `-name:` token's value past a gap, and a comment or a backtick makes that gap as a blank does.
  { dialect: 'powershell', typed: 'git status -y: --% a;git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status -y:  --% a;git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: "git status -y: --'%' a;git push origin main", real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status -y:<#c#> --% a;git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status -y:<#c#>--% a;git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status -y: <#c#>--% a;git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status -y:` --% a;git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status -y:`\n--% a;git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status -y: -z: -w: --% a;git push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git status -y: --% a;git commit -m x --no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git status -y: --% a;npm install left-pad', real: 'npm install left-pad' },
  { dialect: 'powershell', typed: 'git commit -m x -y:<#c#>--no-verify', real: 'git commit -m x -y: --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x -y:` --no-verify', real: 'git commit -m x -y: --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x -y:`\n--no-verify', real: 'git commit -m x -y: --no-verify' },
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
 * source, so `real` shows the line a guard must judge it by, not one with the same text. A word holding a `"` sits here
 * too: 5.1's line reads the quote, so no line spells that word alike in every reading.
 */
export const VALUE_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'git commit --% -m a\\" --no-verify', real: "git commit '--%' -m 'a\"' --no-verify" },
  { dialect: 'powershell', typed: 'git commit (echo -m) x --no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m {x} --no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m x{y} --no-verify', real: 'git commit -m x y --no-verify' },
  { dialect: 'powershell', typed: 'git commit -m @{a=1} --no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git push (echo origin) main', real: 'git push origin main' },
  // The branch is unknown here, as for `$( )`: the guard asks, where a plain `main` would be refused.
  { dialect: 'powershell', typed: 'git push origin (echo main) --force', real: 'git push origin $(echo main) --force' },
  { dialect: 'powershell', typed: 'npm install (echo left-pad)', real: 'npm install left-pad' },
  // A `--%` expands a `%NAME%`: measured with W set to `x main`, so a value can name a branch the line never shows.
  { dialect: 'powershell', typed: 'git push origin --% %%W%', real: `git push origin '%x' main` },
  // A lone dot starts a head only known when it runs, as with a blank behind the dot: the guard asks.
  { dialect: 'powershell', typed: '.$g push origin main --force', real: '. $g push origin main --force' },
  // A chain on a quoted `--%` gives a value only known when it runs, here a null, and the parser still goes by the text ahead
  // of it: the token leaves the rest as one value, and the `"`s in that value split it.
  { dialect: 'powershell', typed: `git commit '--%'.y -y m" "--no-verify" "n o`, real: `git commit m --no-verify 'n o'` },
  { dialect: 'powershell', typed: `git commit -m x '--%'.y -y m" "--no-verify" "n o`, real: `git commit -m x m --no-verify 'n o'` },
  { dialect: 'powershell', typed: `git push '--%'.y -y origin" "--force" "main x`, real: `git push origin --force 'main x'` },
  { dialect: 'powershell', typed: `npm '--%'.y -y m" "install" "left-pad z`, real: `npm m install 'left-pad z'` },
];

/**
 * A block comment joins a value to its chain, so the value is one word only known when it runs, and a null member takes it
 * off the line. `real` is the same line with no comment. Run for real on 5.1 in a throwaway repo, the first and the three
 * assignments each landed a non-fast-forward; the other values dropped their word in the same way from node's arguments.
 */
export const COMMENT_CHAIN_ROWS: readonly ShellWordsRow[] = [
  `git 'x'<#c#>.y push origin main --force`,
  `(1)<#c#>.a = git push origin main --force`,
  `{1}<#c#>.a = git push origin main --force`,
  `'x'<#c#>.a = git push origin main --force`,
  `$('x')<#c#>.a = git push origin main --force`,
  `git "x"<#c#>.y push origin main --force`,
  `git 'x'<#c#><#c#>.y push origin main --force`,
  `git 'x'<#c#>::y push origin main --force`,
  `git 'x'<#c#>[0] push origin main --force`,
  `git 'x'.y<#c#>.z push origin main --force`,
  `git (1)<#c#>.y push origin main --force`,
  `git {1}<#c#>.y push origin main --force`,
  `git $('x')<#c#>.y push origin main --force`,
  `git @('x')<#c#>.y push origin main --force`,
  `git @{a=1}<#c#>.y push origin main --force`,
  `git $v.y<#c#>.z push origin main --force`,
  `git -y:'x'<#c#>.z push origin main --force`,
].map((typed) => ({ dialect: 'powershell', typed, real: typed.replaceAll('<#c#>', '') }));

export const BLANK_AND_LINE_END_ROWS: readonly ShellWordsRow[] = [
  { dialect: 'powershell', typed: 'Get-Content a\rRemove-Item b', real: 'Get-Content a; Remove-Item b' },
  { dialect: 'powershell', typed: 'Get-Content a\rgit commit -m x --no-verify', real: 'Get-Content a; git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'Get-Content a\rgit push origin main', real: 'Get-Content a; git push origin main' },
  { dialect: 'powershell', typed: 'Get-Content a\rnpm install left-pad', real: 'Get-Content a; npm install left-pad' },
  { dialect: 'powershell', typed: 'Get-Content a # note\rRemove-Item b', real: 'Get-Content a; Remove-Item b' },
  { dialect: 'powershell', typed: 'git status # note\rgit push origin main', real: 'git status; git push origin main' },
  { dialect: 'powershell', typed: 'git status # note\rgit commit -m x --no-verify', real: 'git status; git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'git status # note\rnpm install left-pad', real: 'git status; npm install left-pad' },
  // A comma reads on to its next element, so the line under it is no statement of its own.
  { dialect: 'powershell', typed: 'git push origin,\nmain', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git push origin,#y\nmain', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git push origin,`\n\nmain', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git commit -m x,\n--no-verify', real: 'git commit -m x --no-verify' },
  { dialect: 'powershell', typed: 'npm install a,\nleft-pad', real: 'npm install a left-pad' },
  // Behind a `--%` the comma is text, and the text ends at the line end, so the next line is a statement.
  { dialect: 'powershell', typed: 'git status --%,\ngit push origin main', real: 'git push origin main' },
  { dialect: 'powershell', typed: 'git commit --no-verify --%,--verify', real: 'git commit --no-verify --% ,--verify' },
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
