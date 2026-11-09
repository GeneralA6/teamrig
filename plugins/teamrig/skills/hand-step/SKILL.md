---
name: hand-step
description: Use before handing the human a step to run by hand that changes anything or touches a secret (a config or guard line, a grant, a key, an install).
---

# Hand the owner a step to run

Core rule 11: a step the human runs by hand that changes anything or touches a secret (a paste, a settings, config
or guard line, a grant, a key, an install) reaches the human only as a file the security reviewer
[roles.securityReviewer] audited, its sha256 pinned on the task, run by one line. Never as code or a paste typed
into chat or into a card: `set` refuses a card asking the owner that types one, and an edit after the audit needs a
new audit ([tasks.md](../teamrig-guide/tasks.md#task-statuses)).

## Steps

1. Get the facts yourself first, read-only: read the settings, config or guard file; resolve the exact version of a
   package and check it against advisories (the `security` skill); count the rows a data change touches. The file
   then changes only what you saw.
2. Write the file in the task's folder (`teamrig files T<n>`): a `.ps1` (PowerShell), a `.sh` (bash) or a `.md`
   (steps the human follows by hand); any other kind is refused. ASCII only. Its header says who wrote it, the date,
   what it changes and why the human runs it. It runs whole, every step in order, never pasted step by step.
3. Its first step is read-only and ends on one verdict line: `MATCH` only for the exact state its comment names,
   else `NO MATCH`, or `already there` when nothing is left to do, so a second run changes nothing.
4. The change runs only when that first step printed `MATCH`, in the same run, and a last step proves the result
   with one verdict line (the file's own validator, a count, a read back). Each step's comment says what to expect
   and what to send back on a failure.
5. A secret never passes through chat, the card or the file: the human types it at a hidden prompt
   (`Read-Host -AsSecureString`, `read -rs`), and the file prints at most a fingerprint of it.
6. Ask the auditor for it as a task: `teamrig add --owner <reviewer> --priority <your task's> --title "Audit
   <path> for T<n>" --description "<what the file changes>"`. The reviewer reads every line (the first step changes
   nothing; the change is exactly what the task says and touches only its target; the gate holds; a live grant or
   key has its persistence step; nothing prints a secret; full paths; it parses) and pins it: `teamrig audit T<n>
   --file <path> --note "<what it checked>"`, with `--team <your team>` when the reviewer sits on a team above. You
   get an inbox line naming the pin. Never audit your own task's file: the reviewer's own goes to its leader, and a
   team with no reviewer has any other session audit it.
7. Set the task waiting on the owner's decision or approval with the card and `--run <path>`. Its text says in
   plain words what the file changes and its numbers, so the ask stands alone, with no code and no ask to paste. The
   card prints the run line (`& '<path>'`, `bash '<path>'` or `follow the steps in <path>`), its short sha256 and its
   auditor.
8. Once the human ran it, check the outcome with a read of your own and record it as the task's evidence.

## Branches

- **Settings, config or guard line**: edit that one file at an exact anchor, write UTF-8 without a BOM, and print
  `added`, `already there` or `anchor not found`; run the file's validator after (`teamrig config validate` for the
  team config). A loosened guard line names the exact file, never a glob.
- **Install or upgrade**: install only the exact version step 1 checked (`<package>@x.y.z`, never a range) and print
  the version that resolved.
- **Grant, login or key applied live**: the same file writes it where it is re-created from (the provisioning
  script, the secrets source), and a last step proves both agree.
- **Clicks in a provider console**: numbered plain-word steps in the `.md` file, audited and pinned the same way; a
  command goes in a script file, a value as in step 5.

## Traps

- Never run the file, or any of its steps, yourself: not even the first when the file changes anything or uses a
  secret.
- The human's plain shell may have no `teamrig` on its PATH: the file does the change and its own check only, and
  you run any `teamrig` step after. A file that must call it names its full path.
- PowerShell: a here-string's closing `'@` starts at column 0. Keep `} else {` and `} elseif (...) {` on one line:
  pasted by mistake, `}` and `else {` on two lines run as two commands, and the change silently never runs.
- A number a later step needs comes from the same run; one from an earlier run is stale.
- An edit after the audit, a small fix too, is a new audit: the card prints `do not run` in place of the run line,
  and `check` flags `RUN-CHANGED`, until the reviewer pins it again.
