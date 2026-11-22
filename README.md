# mend

One patch tool for every AI edit format. `mend` reads an edit a model wrote
— a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON tool calls —
finds the lines the edit names even when their whitespace or indentation
drifted, and changes every file or none.

## Running it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file; with no patch, or `-`, the patch is read from
standard input. The working directory is the root of the tree being edited.

Options:

- `--format=NAME` — `auto` (the default), `unified`, `search-replace`,
  `v4a`, or `json`.
- `--check` — report what would change without writing anything.
- `--strict` — match lines exactly (tier 0 only).
- `--` — ends the options; everything after it is a positional argument.

On success it prints one line per changed file (`A`, `D`, `M`, or
`R old -> new` for a move) and `ok: N files`. On a failed edit it prints
one `error: <code> <path>` line per failure and `failed: k of n edits`,
and writes nothing. A patch it cannot read is `error: parse <N>`.

Node 22 and its standard library only; nothing is installed.

## Checking it

The kit's practice set (100 checks with the expected outcomes) runs with:

```sh
node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

See `SPEC.md` in the kit for the full contract this tool implements.
