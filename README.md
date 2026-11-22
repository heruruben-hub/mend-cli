# mend — every AI patch format, one tool

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/heruruben-hub/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/heruruben-hub/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

My entry for the make.fun bounty [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) (hidden-spec-cli-01-run-20261122).

AI models describe code changes in whichever format they feel like, and **mend** takes all of them. Hand it a
unified diff, a SEARCH/REPLACE block, a V4A patch (`*** Begin Patch` … `*** End Patch`) or a JSON list of edit
objects, and it works out the format for itself, applies the edits to the file tree in the current directory, and
reports what changed. Finding the target lines does not depend on the patch's line numbers being right: matching
runs through three tiers of increasing looseness — exact, then ignoring trailing whitespace, then ignoring
indentation as well, re-indenting the replacement lines to match the file at that loosest tier. Application is
all-or-nothing: if any edit in the patch fails, no file is touched, and each failure is reported with its reason.

For every file whose state changed, mend prints one row — `A` for added, `D` for deleted, `M` for modified, and
`R <old> -> <new>` when an edit moved a file — followed by a summary line, `ok: n files`.

The behaviour contract mend implements lives in [`SPEC.md`](SPEC.md).

## Running it

You need Node 22 or later. There is nothing to install; mend uses only the standard library.

```
node main.ts [options] [PATCH]
```

`PATCH` names the file holding the patch; leave it out (or pass `-`) and the patch is read from standard input.
The working directory is the root of the tree being patched.

Options:

- `--check` — print the same report a real run would, but write nothing.
- `--strict` — turn off the looser matching tiers; patch lines must match exactly.
- `--format=unified`, `--format=search-replace`, `--format=v4a` or `--format=json` — read the patch in that
  format instead of detecting it.

The exit code tells you how it went: 0 when the whole patch applied, 1 when at least one edit failed (with
nothing written), and 2 for a usage error, an unreadable patch file, an undetectable format, or a patch that
does not parse.

## What's in the repo

- `main.ts` — mend itself.
- `runner.ts` — the trial runner supplied by the kit, unmodified; when a graded trial runs `main.ts`, control
  passes to it.
- `check.ts` — runs the kit's public practice set against `main.ts`:

  ```
  node check.ts <path-to-practice.json>
  ```

- `SPEC.md` — the specification.
- `LICENSE` — MIT.

Built with an AI agent for make.fun — https://make.fun/?ref=kh6903y0&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122
