# Contributing

## Sign-off (DCO)
Every commit must carry a `Signed-off-by:` line that matches the commit author, certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). Add it with:

```sh
git commit -s
```

The `commit-msg` hook (installed by `npm run setup`) and CI both reject a commit without it.

## Branches and releases
- Work lands on `dev` through pull requests or direct pushes by the maintainer's agents.
- `main` and release tags are moved only by the maintainer, after review. Installs track `main`.

## Scrub checks
Two checks keep private data out of the history:
1. **Generic** (in this repo, run by the hooks and CI): absolute home paths, e-mail addresses,
   IP addresses, internal host names and common secret formats.
2. **Private denylist** (optional, never committed): a file of your own terms, wired in with
   `git config --local teamrig.scrubDenylist <path>`. Once configured, the hooks fail closed if
   the file is missing.

Write test data that looks like a secret by building it at runtime (for example
`'ghp' + '_' + 'x'.repeat(36)`), so the source never holds the literal.
