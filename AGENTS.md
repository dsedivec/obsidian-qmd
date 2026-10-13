# qmd-search

Search an Obsidian vault with QMD's hybrid search.

## Commands

| Command         | Does                                          |
| --------------- | --------------------------------------------- |
| `make setup`    | Install dependencies and Git hooks            |
| `make format`   | Run every formatter, linter, and type check   |
| `make test`     | Run the test suite                            |
| `make validate` | `format` then `test` — the definition of done |

There is no `make lint`. `make format` runs the linters and the type checker
too, in a single prek pass.

## Definition of done

A change is done when `make validate` exits clean and `git status` shows nothing
unexpected. Hooks can be bypassed and are absent until `make setup` has run, so
`make validate` is the real gate.

## Conventions

### Version control

Commit frequently, in atomic commits. Each commit should be one coherent change
that leaves the project working.

Write classic Git commit messages: an imperative subject under about 50
characters, a blank line, then a body wrapped at 72 columns explaining why the
change was made.

Do work on a feature branch. Never commit directly to `main`.

**Never push, and never interact with a Git remote or GitHub, unless explicitly
asked to.** This includes creating pull requests, pushing branches, and editing
issues.

Offer a Git worktree at the start of any non-trivial task, so that several
people and agents can work in this repository in parallel.

### Markdown

Prose wraps at 80 columns. Prettier enforces this; do not hand-wrap differently.

Write one sentence per idea rather than padding paragraphs to fill lines. Use
reference-style links when a URL would push a line well past the wrap width.

markdownlint reports what Prettier cannot fix, usually a long URL or a wide
table cell. Reword rather than disable the rule.

### TypeScript

Prettier owns formatting and ESLint owns linting. `tsc --noEmit` is the type
gate; `strict` is on and stays on.

TypeScript is pinned to the 6.0 line because typescript-eslint supports
`>=4.8.4 <6.1.0`. Bump TypeScript and typescript-eslint together, never
separately, and check the peer range before raising either.

Prefer named exports. A default export makes a module harder to rename and
harder to grep for.

Model data with types rather than checks. If a value can only be one of three
things, make it a union, so the compiler catches the fourth case.

Do not reach for `any`. When a type is genuinely unknown at a boundary, use
`unknown` and narrow it.

Tests assert behavior, not implementation. Name a test for the behavior it pins
down.

## Project-specific notes

<!-- Add project-specific guidance below. This section is yours; the sections
above come from the project-bootstrap template and are refreshed by
`copier update`. -->

Anything below contradicting a convention above wins: the sections above are
defaults this project may have deliberately departed from.

### What this is for, and what it is not

One thing: keep the vault indexed in QMD and show `qmd query` results in a
compact sidebar pane. Dale built it because the other plugins he tried added too
much or did not work. These were asked about and deliberately left out: AI chat,
search-as-you-type, keyword-only or vector-only modes, an exclude-folders
setting, status-bar items and ribbon icons, mobile, and Windows. Adding any of
them needs Dale's say-so.

### The look

Results are compact and Google-like, with the note title as the top line and the
link. The pane works at any width. Colours and sizes come only from Obsidian's
theme variables. The approved mockup is in `docs/superpowers/specs/`.

### Safety rules that must not regress

- Never write to a note.
- Never remove, rename or edit a QMD collection. Only create the vault's own
  when it is missing.
- Signal only a process the plugin spawned, adopted, or identified as its own
  from a saved record by the stricter check: the group has a live member, and
  one command line in it holds `qmd`, `mcp` and `--port` with the record's own
  port. Always act on the server's process group, not just its launcher.
- Never run `qmd pull`, or refresh models in any other way, automatically.
- Never start a process through a shell, or build a command as a string.
- Talk to QMD only with Node's `http` on `localhost`: not `fetch`, and not
  `127.0.0.1`.
- Text from notes or from QMD goes into the DOM as text, never as HTML.

### How the code is organised

Logic lives in small units that take their dependencies as constructor arguments
and are tested with fakes. Only `main.ts`, `settings.ts` and `view.ts` import
Obsidian at runtime, and they stay thin. A behaviour change goes into the tested
unit, test-first.

### Testing

Unit tests run in Vitest. Integration tests run the real `qmd`, always isolated
with `INDEX_PATH` and `QMD_CONFIG_DIR`, so that the default index is never
touched. In-app checks are made in a scratch vault through the Obsidian CLI.
Dale's Main vault is not a test bed: its notes are read-only, and nothing is
installed there without asking.

### Where the reasoning lives

It is in the spec and the plan, under `docs/superpowers/`. The spec's
"Experiment results" section records what was measured against the real QMD and
Obsidian.

### User-facing wording

Messages name the problem and the fix, plainly. The exact strings are pinned by
tests in `tests/errors.test.ts`, `tests/view-model.test.ts` and
`tests/cli-handler.test.ts`.

### Departures from the conventions above

- `main.ts` exports the plugin class as its default export, because Obsidian
  requires that, and the Vitest and ESLint config files need one too. Named
  exports everywhere else.
- The spec and the plan are records: Prettier wraps them, but markdownlint skips
  them and they are not reworded for it.
- Everything under `tests/fixtures/` stays byte-exact, so the hooks skip it.
- `make validate` leaves out the integration tests. Run `make integration` when
  a change touches how `qmd` is run or spoken to.
