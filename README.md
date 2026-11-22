# mend — one patch tool for every AI edit format

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/heruruben-hub/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/heruruben-hub/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Entry for the make.fun bounty [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) (hidden-spec-cli-01-run-20261122).

**mend** is a command-line tool that applies the edits AI models write to a tree of files. It reads a patch in any of
the four formats models actually produce — unified diffs, SEARCH/REPLACE blocks, V4A patches (`*** Begin Patch` …
`*** End Patch`) and JSON edit objects — works out which format it is holding, finds the named lines even when their
line numbers are wrong or their whitespace and indentation have drifted (three matching tiers: exact, trailing
whitespace ignored, leading whitespace ignored too, with re-indentation at the loosest tier), and then writes every
change or none of them. It prints one row per changed file (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and a
final `ok: n files` line; a patch that cannot be applied in full writes nothing and reports each failed edit.

The full contract is in [`SPEC.md`](SPEC.md).

## How to run it

Requires Node 22 or newer; standard library only, nothing to install.

```
node main.ts [options] [PATCH]
```

- `PATCH` is the patch file to apply; omit it or pass `-` to read the patch from standard input.
- `--check` reports what would change without writing anything.
- `--strict` matches patch lines exactly (tier 0 only).
- `--format=unified|search-replace|v4a|json` forces a format instead of detecting it.

Exit code is 0 when every edit applied, 1 when one or more edits failed (nothing is written), and 2 for usage,
missing-patch, format and parse errors.

## Files

- `main.ts` — the tool itself.
- `runner.ts` — the kit's trial runner (unchanged); in a graded trial `main.ts` hands over to it.
- `check.ts` — runs the kit's public practice set against `main.ts`:

  ```
  node check.ts <path-to-practice.json>
  ```

- `SPEC.md` — the specification mend implements.
- `LICENSE` — MIT.

Built with an AI agent for make.fun — https://make.fun/?ref=kh6903y0&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122
