import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mayAssign } from './names.ts';
import type { ReadonlyRules } from './rules.ts';

const RULES: ReadonlyRules = { prefixes: [], exported: new Set(['npm_config_prefix', 'ProgramFiles', 'windir']), exportsAll: false };

/** Asserts the line may set each name (`expected` true) or none, naming the name on failure. */
function expectAll(names: readonly string[], expected: boolean, rules: ReadonlyRules = RULES): void {
  for (const name of names) {
    assert.equal(mayAssign(name, rules), expected, name);
  }
}

describe('mayAssign', () => {
  it("lets the line set its own names in either case, a family's start inside a longer word included", () => {
    expectAll(['pod', 'x', 'out_dir', 'S', 'POD', 'LPOD', 'OUT_DIR', 'TEMPLATE', 'PSQL_HOST', 'MAILER', 'GITHUB_REPO'], true);
  });

  it("refuses bash's and MSYS's own names, which the shell reads or sets unexported", () => {
    expectAll(['PATH', 'IFS', 'CDPATH', 'GLOBIGNORE', 'HOME', 'PWD', 'SHLVL', '_', 'BASH_ENV', 'BASHOPTS', 'SHELLOPTS', 'HISTFILE', 'PS4', 'LC_ALL', 'LANG', 'PROMPT_COMMAND', 'COMP_WORDS', 'auto_resume', 'histchars'], false);
    expectAll(['MSYSTEM', 'MSYS', 'MSYS2_PATH_TYPE', 'MSYS_NO_PATHCONV', 'MINGW_PREFIX', 'CYGWIN', 'ORIGINAL_PATH', 'WINDIR', 'SYSTEMROOT', 'COMSPEC'], false);
  });

  it('refuses the temporary folders, which Claude Code sets for the shell', () => {
    expectAll(['TEMP', 'TMP', 'TMPDIR', 'TEMPDIR', 'ORIGINAL_TEMP'], false);
  });

  it('refuses the families git and kubectl read', () => {
    expectAll(['GIT_DIR', 'GIT_PAGER', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF'], false);
    expectAll(['KUBECONFIG', 'KUBECTL_EXTERNAL_DIFF', 'KUBECACHEDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'XDG_CONFIG_HOME', 'SSH_ASKPASS'], false);
  });

  it('refuses the pagers and editors a program starts', () => {
    expectAll(['LESS', 'LESSOPEN', 'LESSCLOSE', 'PAGER', 'MANPAGER', 'EDITOR', 'VISUAL', 'BROWSER'], false);
  });

  it('refuses what node, npm and the loader read under a trusted prefix', () => {
    expectAll(['NODE_OPTIONS', 'NODE_PATH', 'NPM_CONFIG_PREFIX', 'NPX_CACHE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'], false);
  });

  it('refuses the options and colours grep, ls, awk and the core utilities read', () => {
    expectAll(['GREP_COLORS', 'GREP_OPTIONS', 'LS_COLORS', 'AWKPATH', 'POSIXLY_CORRECT', '_POSIX2_VERSION', 'TIME_STYLE', 'BLOCK_SIZE'], false);
  });

  it("refuses Claude Code's own names, which its snapshot's functions read", () => {
    expectAll(['CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDECODE'], false);
  });

  it("refuses a name the hook's environment or the snapshot exports, an upper-case one in any spelling", () => {
    expectAll(['npm_config_prefix', 'ProgramFiles', 'PROGRAMFILES', 'windir'], false);
    expectAll(['programfiles', 'Npm_Config_Prefix'], true);
  });

  it('refuses every name under the snapshot\'s set -a', () => {
    expectAll(['pod', 'POD', 'x'], false, { ...RULES, exportsAll: true });
  });
});
