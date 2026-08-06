# Changelog

## Unreleased

### Fixed

- **A recorded hash the engine cannot compare no longer reports `CLEAN`.** This is
  a seventh case of the class the six rows in `0.4.0` below describe, and it was
  still in the tree. A gen region or prose slot whose `hash=` names a hash
  algorithm this engine does not implement was assigned its own drift state,
  `rebaseline`, which was not counted as drift, not named in the summary, not
  listed among the findings the envelope reports, and had no branch in the
  proposal builder. Measured on one repository, one byte apart: with
  `hash=h1:…` the section reported `stale` and `check` exited 1; changing that
  `1` to a `2` made the same document over the same drifted code report
  `CLEAN` and exit 0, and `keeldocs sync` answered `NOTHING_TO_SYNC` — so there
  was no way back either. The marker grammar accepts `h<digits>:`, so this needed
  no future algorithm to reach: a merge that resolved a marker line badly gets
  there today.

  Such a section is now `unverified`, the state `0.4.0` introduced for a
  generated region carrying no hash at all. It is still **not** drift — an
  algorithm change is not your code changing, and `check` still reports zero
  drift findings — but it exits 1 with `UNREADABLE`, names the section by
  document, line and reason, and `sync` regenerates it, re-baselining the marker
  onto the current algorithm in one pass. Findings now carry a `reason` of
  `no-recorded-hash` or `unreadable-hash-algorithm` so the receipt says which
  case it was, and unverified sections are listed in the envelope under
  `data.unverified` rather than only counted — "1 section is not being checked"
  without saying which one is a finding nobody can act on.

## 0.4.0 — 2026-08-05

**Read this before upgrading if you run `keeldocs check` in CI.** This release can
turn a green build red without your code having changed. That is not a regression.
Every case below is one where `0.3.0` reported `CLEAN` while checking nothing at
all, and the new answer is the true one. The ordinary case — a repository whose
documents `keeldocs init` generated — is byte-for-byte unchanged, verified by
running both engines against the same untouched tree.

Measured, on the same repository, `0.3.0` versus `0.4.0`:

| what your repository contains | 0.3.0 | 0.4.0 | was 0.3.0 right? |
|---|---|---|---|
| documents keeldocs generated | `CLEAN` | `CLEAN` | yes — nothing changes |
| a `pkg:` scope naming a package your workspace does not contain | `CLEAN` | `DRIFT_FOUND` | no |
| a generated region whose `hash=` was deleted | `CLEAN` | `UNREADABLE` | no |
| a marker containing `>` in a value | `CLEAN` | `UNREADABLE` | no |
| a vendored dependency checked out in place | `CLEAN` | `DRIFT_FOUND` | no |
| an anchor with an unrecognised `name=` in a value | `DRIFT_FOUND` | `UNREADABLE` | it was already failing |

If your build goes red, the finding tells you which section and why. `keeldocs sync`
repairs the two that are repairable (a missing hash, a stale table); the other two
are binding mistakes only you can decide about.

### Why each of those was wrong before

A section bound to nothing hashed the empty set to a constant — the same value in
every repository, one that no change to anyone's code could ever move — so it
matched forever. A document claiming to inventory a package you do not have was
certified as accurate documentation.

A generated region carrying neither `hash=` nor `content=` still looked managed and
was compared against nothing. Deleting two attributes retired a section from drift
detection permanently and silently.

The HTML-comment envelope ends at the first `>`, so a marker containing one was not
refused — it was invisible. The spec promised malformed anchors are quarantined as
inert data, and silence is not that.

Extraction walked into nested checkouts, so a vendored dependency's environment
variables were documented as your application's own, with true receipts pointing at
somebody else's code.

### New

- **`keeldocs doctor`** — preflight. Checks Node, git, Python and every provider's
  declared requirements, then prints the exact install command for your machine,
  with the PEP 668 and Windows flags already resolved. Exit `0` ready, `1` blocked,
  `3` degraded — which is the first time exit code 3 has meant anything.
- **`keeldocs noise`** — counts and rates from your decisions journal, and nothing
  else: no paths, no document titles, no fact ids, no repository name. For sharing
  a noise measurement without sharing your repository. Nothing is sent anywhere;
  no other command invokes it.
- **`[providers] exclude-paths`** in `keeldocs.toml` — scope extraction by path.
  For `fixtures/`, `examples/`, `vendor/`, `testdata/`: real code that is not your
  application. `disable` removes a whole provider, which was the wrong shape when
  you still want your own environment variables documented. A fact read from both
  an excluded and an included path survives with the excluded read site dropped,
  and `check` reports how many facts the scope removed.
- **Anchor specification frozen at 1.0.** `spec/anchor-spec.md` §11 is the
  compatibility policy, §12 enumerates every behaviour a conforming reader may rely
  on, and a harness gate holds the parser to it. A new `needs=` key declares which
  grammar generation a marker requires, so a future key is reported as "written by
  a newer keeldocs" instead of as a typo. Generation-1 engines parse it and never
  emit it, so every document written by any 0.x keeldocs is already conforming.

### Fixed

- `emits:` is enforced at extraction. It reached the consent manifest `provider add`
  shows you and stopped there — you agreed to a list nothing held the provider to.
  A provider emitting an undeclared fact type now fails closed.
- A record missing a field its fact type needs is a named gap, not a silently
  smaller answer. `JSON.stringify` drops undefined keys, so such a fact used to
  reach the fact file and the document missing part of itself.
- Gap reasons are preserved. Three distinct refusals from the Django provider — a
  non-literal route, a regex route, a urlconf outside the repository — all reached
  the report as the single word `unknown`.
- Capability dispatch is a table. Its last `else` was the database-schema
  normalizer, so an unknown capability was silently normalized as a schema.
- `sync` no longer writes a duplicate `content=` when repairing a region that had
  neither hash, which quarantined the marker it was repairing.
- Static database-schema providers can report gaps at all; the normalizer discarded
  them, so `drizzle` had declared `extraction-gap` since v0.2 while being
  structurally unable to produce one.
- Stub provider manifests are validated. `rails-sql` carried a `detect` key the
  loader does not accept for two releases and nothing said so.
- `ENGINE_VERSION` is read from `package.json`. `0.2.0-rc.4` shipped stamping
  `0.2.0-dev.0` into every receipt — the drift detector misreporting its own version
  in the evidence it asks you to trust.
- Anchors inside fenced code blocks are examples, not structure.

### Also

`recipes/` no longer ships in the package; it was read by zero code and its ERD
template named sections the renderer does not emit. The specifications live in
`docs/design/recipes/` and a gate binds them to the renderer.

**No speed figure is claimed.** Correctness at a million lines and the memory
budget are established; the latency measurement is not yet trustworthy.

## 0.3.0 and earlier

Not recorded here — this file starts at 0.4.0. `git log v0.3.0` is the history.
