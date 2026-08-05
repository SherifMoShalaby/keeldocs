# E16 — Does the Claude Code plugin/marketplace path work at all?

Run 2026-08-05 against `keeldocs@0.3.0` in the tree, Claude Code 2.1.220 on
macOS 15 (Darwin 25.5.0).

## The question

`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` have shipped
since v0.1 and nothing had ever exercised them. They were written from the
documented shape and then left alone, which is the condition this project keeps
finding in its own tree: a manifest that describes an integration nobody has run.
The distribution bet (brief constraint 2) rests partly on this path, so "we wrote
the files" is not an answer.

## What was run

Claude Code ships a validator that does not install anything:

```
$ claude plugin validate .
Validating marketplace manifest: .../.claude-plugin/marketplace.json
⚠ Found 1 warning:
  ❯ description: No marketplace description provided.
✔ Validation passed with warnings
rc=0

$ claude plugin validate . --strict
✘ Validation failed (--strict treats warnings as errors)
rc=1
```

The missing marketplace `description` was the only defect. It is one line, and it
was invisible to the lenient form — a repo that only ever ran `validate` without
`--strict` would have called this green. Added; both forms now exit 0.

**The validator does reach `plugin.json` through the `source: "./"` entry**, which
was worth establishing rather than assuming, because the output only names the
marketplace file. Proven by mutation:

```
$ # plugin.json name -> "Not Kebab Case", author -> a string
$ claude plugin validate .
  ❯ plugins[0] plugin.json → name: Plugin name cannot contain spaces.
  ❯ plugins[0] plugin.json → author: Invalid input: expected object, received string
rc=1
```

Two exit codes in this file were nearly recorded wrong. `claude plugin validate .
--strict | head` reports `head`'s status, not the validator's, and the first read
of it said `rc=0` on a run that had printed "Validation failed". CLAUDE.md's rule
about checking the exit code rather than a pipeline's is not a style note.

## Verdict

**The path is structurally sound.** `source: "./"` is valid and means the
marketplace repository root. Skills are auto-discovered from `skills/<name>/SKILL.md`
with no manifest entry, which is exactly the layout that ships. Every frontmatter
key in all six skills — including `user-invocable: false` on `keeldocs-core` and
`disable-model-invocation: true` on four others — is recognised. Installation from
a git marketplace requires no npm publication, so this path is independent of the
registry entirely.

**One cosmetic finding, deliberately not fixed.** For a plugin skill the
frontmatter `name` replaces the directory name in the command, and the plugin
namespace is already `keeldocs`, so `skills/check/` with `name: keeldocs-check`
reads as `/keeldocs:keeldocs-check` rather than `/keeldocs:check`. Renaming would
fix the stutter and break the standalone-skills path that E7 actually measured.
One file serves two installation paths; the stutter is what that costs, and a
cosmetic gain is not worth invalidating a measured result.

## What this does NOT establish

An actual install was not performed. `/plugin marketplace add` and `/plugin
install` are interactive, and this session cannot drive that dialog. So what is
established is that the manifests are valid, complete, mutually consistent, and
that every component the plugin would expose is discoverable and well-formed —
not that a user has installed it and invoked a skill. That last step is one
command for the owner:

```
/plugin marketplace add SherifMoShalaby/keeldocs
/plugin install keeldocs@keeldocs-marketplace
```

Until someone runs those two lines and invokes a skill, the honest claim is
"validates clean", not "works".

## Gate

`claude plugin validate --strict` is authoritative but needs the `claude` binary,
which no CI runner has, so it cannot be the gate. The harness asserts the
invariants portably instead: kebab-case names, `author` as an object, a non-empty
marketplace description (the thing `--strict` demanded), every entry's `source`
resolving to a directory that really holds a `plugin.json`, no path traversal, and
every skill frontmatter using only recognised keys. Proven able to fail on three
mutations — the missing description, an `allowed_tools` typo for `allowed-tools`,
and `author` as a string.
