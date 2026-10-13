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
