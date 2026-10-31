# GitHub sync

`teamrig gh sync` brings the issues of your GitHub repositories into the task list, one way only. Each open issue
written by the repository's people, or accepted by them ([Whose issues become tasks](#whose-issues-become-tasks)),
becomes a task (source `github`, ref `gh:<owner>/<name>#<number>`), and its title, description (the issue's body),
priority and open or closed state follow GitHub on every run. Nothing ever goes the other way: teamrig never creates, edits, comments on or closes
anything on GitHub, and a task added with `teamrig add` stays on your machine.

Setting it up takes three steps: list the repositories, give teamrig read access to their issues, then preview and
write. After that it runs on its own every 15 minutes while your sessions work.

## 1. List the repositories

Add a `github` block to the team config (`~/.teamrig/teams/<team>/config.json`):

```json
"github": {
  "repos": ["acme/web", "acme/api", "globex/site"],
  "sessions": { "acme/web": "web", "acme/api": "api", "globex/site": "web" },
  "owners": { "octocat": "api" },
  "closedDays": 14,
  "everyMinutes": 15
}
```

| Key | What it does |
| --- | --- |
| `repos` | The repositories to read, as `owner/name` (at most 20). Empty turns the sync off. |
| `sessions` | Optional. The session that owns each repository's issues, so each session sees the issues of its own repositories. One session can own several. |
| `owners` | Optional. A GitHub login to a session: an issue assigned to that login goes to that session, whatever its repository. |
| `closedDays` | How many days back closed issues are read, to finish their tasks. Default 14. |
| `everyMinutes` | How often it runs on its own, in minutes (0 to 1440). Default 15; 0 leaves it to `teamrig gh sync --yes`. |
| `acceptLabel` | Optional. The label that lets an issue by someone outside the repository become a task ([below](#whose-issues-become-tasks)). Default `teamrig`. |

Who owns a new issue's task: the session of its first assignee listed in `owners`; else its repository's session in
`sessions`; else the lead. After the import the owner is the team's: reassigning the task in teamrig sticks. So is
closing it: a task the team sets done or dropped while its issue is open stays closed until the issue changes on
GitHub after that (reopened, edited or commented on).

### Whose issues become tasks

Anyone can open an issue on a public repository, so teamrig takes only the issues of people you trust:

- **The repository's people.** An issue whose author GitHub ties to the repository as its owner, a member of its
  organisation or a collaborator becomes a task at the next sync.
- **Anyone else's, once accepted.** An issue by any other author (one with a merged pull request too) waits until
  someone other than its author adds the `acceptLabel` label, `teamrig` by default (any case). Only people with
  triage rights can label an issue; a label put on by a bot, a workflow or an issue template does not count.
- **An edit undoes the accept.** When the title or body changes at or after the label went on, whoever edited it,
  the issue is not accepted any more. Once you have read the new text, remove the label and add it again.

An issue that counts neither way writes nothing. A task the sync already added for one keeps its text: its priority
and open or closed state still follow GitHub, its title and description stay as they are.

## 2. Give teamrig read access

teamrig reads issues through the GitHub CLI, [`gh`](https://cli.github.com). For each owner (the `acme` in
`acme/web`) it uses:

- **a read-only token saved for that owner**, when there is one: recommended, and needed when your repositories
  belong to more than one owner;
- **else the `gh` login** (`gh auth login`), which works when that account can read the issues of every listed
  repository.

### Why one token per owner

A fine-grained GitHub token belongs to one *resource owner*: your personal account or one organisation. It can never
reach the repositories of another owner. So a team that reads `you/tool` and `your-org/app` creates two tokens, one
for each owner. teamrig finds each by its name, `teamrig-gh-<owner>`, so no config names them.

### Create a token

Do this once per owner:

1. On GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Token name**: anything, e.g. `teamrig read issues`. **Expiration**: 90 days is a fair balance.
3. **Resource owner**: the owner of the repositories, e.g. `acme`.
4. **Repository access**: **Only select repositories**, and pick the ones in `github.repos`.
5. **Permissions → Repository permissions → Issues: Read-only**. GitHub adds **Metadata: Read-only** by itself.
   Give it nothing else.
6. **Generate token** and copy it. GitHub shows it only once.

For an organisation, an organisation owner may have to approve the token before it works; until then GitHub refuses
it.

### Save it

Save the token in your system's credential store under `teamrig-gh-<owner>`, the owner in lowercase. Each command asks
for the token and shows nothing as you paste it. Run it in a terminal window of your own:

| System | Save | Remove |
| --- | --- | --- |
| Windows (Credential Manager) | `cmdkey /generic:teamrig-gh-acme /user:teamrig /pass` | `cmdkey /delete:teamrig-gh-acme` |
| macOS (keychain) | `security add-generic-password -U -s teamrig-gh-acme -a teamrig -w` | `security delete-generic-password -s teamrig-gh-acme` |
| Linux (Secret Service, `libsecret-tools`) | `secret-tool store --label=teamrig-gh-acme service teamrig-gh-acme` | `secret-tool clear service teamrig-gh-acme` |

On Linux without `secret-tool`, teamrig reads through the `gh` login.

## 3. Preview, then write

```sh
teamrig gh sync          # shows what it would do, writes nothing
teamrig gh sync --yes    # writes it
```

The preview is also the check that access works. It says once per owner how that owner's repositories are read:

```text
ACCESS acme: read with the token saved as teamrig-gh-acme
REPO acme/web: 2 to add, 0 to change, 5 unchanged
ADD new gh:acme/web#7 p1 web: "Fix the login redirect"
ADD new gh:acme/web#9 p2 web: "Add search to the docs"
LEFT OUT acme/web: 1 open issue(s) by people outside the repository wait for someone to add the "teamrig" label: #12
REPO acme/api: 0 to add, 0 to change, 3 unchanged
ACCESS globex: read with the gh login; no token saved as teamrig-gh-globex
REPO globex/site: 1 to add, 0 to change, 0 unchanged
ADD new gh:globex/site#4 p2 web: "Broken footer link"
PREVIEW nothing was written; teamrig gh sync --yes writes the above as github
```

A repository that cannot be read gets a `FAILED` line saying what to fix; its tasks stay as they are and the other
repositories are read on. A `LEFT OUT` line names, by number only, the open issues by people outside the repository
that no one accepted yet (at most 20, then how many more); their text is never printed. `teamrig gh sync --repo
acme/web` reads one repository only.

## Then it runs on its own

Once the repositories are listed, nobody needs to run it. When a session of the team ends a turn, its Stop hook
checks whether `everyMinutes` (15) have passed since the last sync; if so, it starts `teamrig gh sync --auto` hidden
in the background, once for the whole team, and the turn goes on as usual. Nothing keeps running between syncs, so
while every session is idle nothing is read; the next turn that ends catches up.

- Each session with new tasks gets one inbox line, for example
  `github: GitHub sync added 1 task(s) for you: T42 gh:acme/web#7 "Fix the login redirect"`.
- `teamrig list` shows such a task with its issue: `T42 open, p1, owner web, from gh:acme/web#7 | Fix the login redirect`.
- A repository that cannot be read is told to the lead's inbox once, with the `FAILED` reason, and again when every
  repository reads again; it is not repeated at every run.
- An outsider's issue left out for the first time is told to the lead's inbox once, by ref only, for example
  `github: GitHub sync left out 1 new open issue(s) by people outside the repository: gh:acme/web#12; add the
  "teamrig" label to one on GitHub to make it a task at the next sync`.

`"everyMinutes": 0` turns the automatic sync off, and `TEAMRIG_GITHUB=off` turns every sync off on one machine.
`teamrig gh sync --yes` still works at any time.

## Renewing a token

When a token expires, GitHub refuses it and the `FAILED` line says so. Regenerate it on GitHub (the token's page has
**Regenerate token**) and save it again with the same command: saving under the same name replaces the old one.
Changing a token's permissions or repositories on GitHub keeps the token text the same, so there is nothing to save
again.

## When something fails

| The `FAILED` line says | What it means | Fix |
| --- | --- | --- |
| `the token saved as teamrig-gh-acme may not read the issues of acme/web` | The token sees the repository but has no Issues permission. | On GitHub, edit the token: **Issues: Read-only**. |
| `acme/web is not visible to the token saved as teamrig-gh-acme` | The repository is not one the token was given, or the name is wrong. | Check `github.repos`; on GitHub, add the repository to the token. |
| `GitHub refused the token saved as teamrig-gh-acme (expired or revoked?)` | Expired, revoked or not yet approved by the organisation. | Regenerate it and save it again, or ask an organisation owner to approve it. |
| `... is not visible to the gh login` / `the gh login may not read the issues` | No token is saved for that owner, and the `gh` account cannot read it. | Save a token for the owner (step 2). |
| `gh is not logged in to GitHub` | No token for that owner and no `gh` login. | Save a token, or run `gh auth login`. |
| `gh, the GitHub CLI, is not installed` | `gh` is missing. | Install it from [cli.github.com](https://cli.github.com). |

`ACCESS acme: read with the gh login; could not read teamrig-gh-acme from ...` means the credential store itself
could not be read (a locked keyring, for one); teamrig reads through the `gh` login meanwhile.

## Safety

- **Read-only.** The token can read issues and metadata and nothing else, and teamrig runs only the two issue
  queries it ships, word for word, through `gh api graphql` (any other `gh` command or query is refused in code).
- **Never on disk in the clear.** The token lives in the system's credential store, encrypted under your login. It
  is never in the team config, a command line, a log or teamrig's output: teamrig hands it to `gh` as `GH_TOKEN` for
  that one run.
- **Same trust as the `gh` login.** Any program running as you can read your credential store, just as it can use
  your `gh` login. Keep each token to the repositories the team syncs.
- **Issue text is outside input.** Anyone who can open an issue writes its title and body, so an outsider's issue
  becomes a task only once accepted ([Whose issues become tasks](#whose-issues-become-tasks)); teamrig prints titles
  quoted, as data, never as instructions. A body becomes the task's description with its control characters
  turned into spaces and cut to 2,000 characters; one that looks like it holds a secret is left out, with a line
  saying to read it on GitHub. Sessions read descriptions as data, never as instructions.
- **Off switch.** `TEAMRIG_GITHUB=off` turns the sync off on one machine.
