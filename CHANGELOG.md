# Changelog

## Unreleased

**Eleven more of the same class, in two batches, and both were sitting in the
tree `0.4.2` shipped from.** The first is about which files the engine reads at
all rather than which documents: detection proved a path, and the extractor was
handed the repository root and re-guessed the layout at it. The second is about
a list of directory NAMES the engine kept to itself — `golden/` among six — which
had become the boundary of a user-facing guarantee without anyone deciding that
it should be one.

Measured on `fixtures/nested-layout-scenario` — a Rails app at
`apps/api/`, a Next.js App Router project at `apps/web/`, a compose file at
`deploy/` and a migration chain at `packages/db/` — with the published `0.4.2`
engine and this tree, on the same repository:

| what your repository contains | 0.4.2 | now |
|---|---|---|
| a Rails `config/routes.rb` below the root | `http-endpoints: ok`, zero facts, no gap | 18 endpoints, cited at `apps/api/config/routes.rb` |
| an App Router below the root | `client-routes: ok`, zero facts, no gap | 3 routes, cited under `apps/web/app/` |
| a compose file below the root | `services-topology: ok`, zero facts, no gap | 3 services, cited at `deploy/docker-compose.yml` |
| a migration chain below the root | `db-policies: ok`, zero facts, no gap | 2 policies + 1 rls, cited under `packages/db/migrations/` |
| all four at once | `CLEAN`, exit 0, summary `no facts` | `CLEAN`, exit 0, `23/25 surfaces documented (92%)` |
| a second compose candidate the engine did not read | `100%` documented, no gap | `100%`, and the skipped file named |

Exit codes do not move: a repository that was clean stays clean, and every
root-layout repository resolves to exactly the same file set it did before.
What changes is that four capabilities stop reporting `ok` over nothing.

And measured for the second batch with the same published `0.4.2` engine: ONE
anchored document whose recorded hash nothing can match, moved from directory to
directory and nothing else changed. Where it lands decides the verdict, and the
deciding directory names are ones the user never wrote down.

| where the anchored, drifting document is | 0.4.2 | now |
|---|---|---|
| `docs/reference.md`, under `dirs = ["docs"]` | `DRIFT_FOUND`, exit 1, named | unchanged |
| `docs/golden/reference.md`, same config | `CLEAN`, exit 0, `across 1 doc(s)` | `DRIFT_FOUND`, exit 1, named |
| `docs/.keeldocs/reference.md`, same config | `CLEAN`, exit 0 | `DRIFT_FOUND`, exit 1, named |
| `docs/node_modules/…`, same config | `CLEAN`, exit 0 | `CLEAN`, exit 0, and `docs/node_modules` named as not read |
| `golden/`, `dist/` or `coverage/`, outside every scan root | `CLEAN`, exit 0, nothing in `data.unscanned` | `UNREADABLE`, exit 1, each file named |
| `node_modules/…`, outside every scan root | `CLEAN`, exit 0 | `CLEAN`, exit 0, and `node_modules` named as not read |
| the same bytes under `dirs = ["docs/golden"]` | `DRIFT_FOUND`, exit 1 | unchanged |

That last row is the proof it was an artefact rather than a decision: naming
`docs/golden` as the scan root always read it, because the skip applied to the
recursion and never to the root itself.

**And two more, in a third batch, in the one setting a user writes to make the
engine look away.** `[providers] exclude-paths` is a single line of config
compiled twice: the repo walk tests its patterns against every entry it meets
INCLUDING directories, so `vendor` prunes the subtree, while the provenance
filter tests the same patterns against FILE paths, where `^vendor$` matches
nothing. So the two spellings of one intention parted company, and the more
destructive one was the silent one. Measured on `fixtures/exclude-shape-scenario`
— one env var read under `vendor/`, one outside it, the tree's only compose file
under `vendor/`, and an anchored, drifting `vendor/notes.md` — with the published
`0.4.2` engine and this tree:

| what your `keeldocs.toml` says | 0.4.2 | now |
|---|---|---|
| `exclude-paths = ["vendor/**"]` | `0/1 surfaces`, `scopedOut: 1`, the line named | unchanged |
| `exclude-paths = ["vendor"]`, same tree | `0/2` — `VENDOR_SECRET_KEY` still counted — `services-topology` gone, `meta` carrying neither field | identical to `["vendor/**"]` in every observable |
| the anchored `vendor/notes.md`, under either | unmentioned, exit 0 | named as excluded, exit 0 |
| `exclude-paths = ["**/*.md"]` | exit 0 `CLEAN`, `meta` empty, sweep silent repo-wide | exit 0 `CLEAN`, and the document it suppressed named |
| no exclusion at all (the control) | exit 1 `UNREADABLE`, `vendor/notes.md` named | unchanged |

Exit codes move in neither direction: an excluded tree is a blind spot the user
chose, and honouring a written scope is the point of having one. What changes is
that one spelling stops meaning two things, and that a scope which suppressed a
document says which one.

**And two more, in a fourth batch, in the file where a human overrules the
engine.** `.keeldocs/decisions.jsonl` is append-only and read line by line, and
`loadJournal` has always collected the lines it could not parse into a
`malformed` list. The only thing that ever read that list was `keeldocs noise` —
an opt-in counts report that nothing in CI invokes — so to `check`, a line it
could not parse was a line that had never been written. The asymmetry is what
makes it dangerous: dropping a line does not lose a decision, it silently
reinstates the decision that line revoked. Measured with the published `0.4.2`
engine and this tree, on one anchored section bound to a fact that no longer
exists, with a tombstone that a human later revoked:

| what `.keeldocs/decisions.jsonl` contains | 0.4.2 | now |
|---|---|---|
| the tombstone, intact | `CLEAN`, exit 0, `[stale 0, dead 0, tampered 0]` | unchanged |
| the tombstone plus an intact `revoke` of it | `DRIFT_FOUND`, exit 1, `dead 1` | unchanged |
| the same `revoke`, truncated mid-line | `CLEAN`, exit 0 — **byte-identical** to the first row, tombstone still standing | `UNREADABLE`, exit 1, `line 2: bad-json` |
| a `revoke` missing `type`, `target` or `at` | `CLEAN`, exit 0 | `UNREADABLE`, exit 1, `line 2: missing-fields` |
| what a plain `git merge` leaves behind | `CLEAN`, exit 0 | `UNREADABLE`, exit 1, lines 2, 4 and 6 named |
| the same journal, through `keeldocs noise` | `3 malformed line(s) skipped` | unchanged — `noise` was always right, and nothing asked it |

The third row is the whole defect in one line: a corrupted revocation and an
intact tombstone produced the same bytes on stdout, the same exit code and the
same report, so there was no observation a user or a CI job could have made that
distinguished "this finding was deliberately retired" from "the retirement was
countermanded and the countermand was eaten".

The fifth row is how a repository reaches that state without anyone corrupting
anything by hand, and it is the second defect. Spec §6 does not offer
`merge=union` as advice — it is the premise the reader's contract rests on
("`merge=union` via `.gitattributes` written by `init` — therefore entries are
self-contained, idempotent, order-independent"), and nothing in the reader
resolves a conflict because the spec says a conflict cannot arise. But
`grep -rn gitattributes src/ bin/` returned nothing: `init` wrote no
`.gitattributes` at all, and no `.gitignore` either, though §7 assumes both. So
the conflict did arise, on a strictly append-only file, and what it leaves is
three lines that are not JSON.

| `keeldocs init --yes` on a fresh repository | 0.4.2 | now |
|---|---|---|
| `.gitattributes` | not written | `.keeldocs/decisions.jsonl merge=union` |
| `.gitignore` | not written | `.keeldocs/cache/` and `.keeldocs/out/` |
| alice tombstones A, bob tombstones B, then `git merge` | `CONFLICT (content)`, exit 1, `UU .keeldocs/decisions.jsonl` | exit 0, both decisions present, no marker in the file |

Neither file is ever overwritten, and neither is written by a dry run. `init`
appends the missing rule lines and nothing else, so an existing `.gitattributes`
carrying `* -text` keeps it, an already-present ignore line is not duplicated, a
file that did not end in a newline gets one before the append rather than having
its last rule corrupted, and a second `init` is byte-idempotent on both files.

### Fixed

- **A decisions-journal line the reader could not parse was dropped in silence,
  and a corrupted revocation re-suppressed a finding a human had explicitly
  un-suppressed.** `loadJournal` already returned `{ entries, malformed }`;
  `check` read only `entries`. It now names every unreadable line by number and
  reason and exits 1 `UNREADABLE`, which outranks `DRIFT_FOUND` for the reason
  every other member of that code does: the effective decision set was computed
  from a journal the engine could not fully read, so the drift count for the run
  is a number it should decline to headline. Named, never counted — "3 lines are
  unreadable" is not something a human can act on, and the repair is per line.
  Both reasons `loadJournal` records reach the same verdict: a line that is not
  JSON, and a line that is JSON but lacks `type`, `target` or `at`. Suppression
  is untouched — a standing tombstone still exits 0 `CLEAN`, and an intact
  `revoke` of it still exits 1 with `dead 1`.

- **`init` wrote neither the `.gitattributes` rule spec §6 promises nor the
  `.gitignore` lines §7 assumes.** §6 states the journal is union-merged "via
  `.gitattributes` written by `init`", and that this is *why* entries may be
  order-independent; `grep -rn gitattributes src/ bin/` found no such writer, so
  the premise was never established in any repository keeldocs initialised.
  `init --yes` now appends `.keeldocs/decisions.jsonl merge=union` to
  `.gitattributes` and `.keeldocs/cache/` and `.keeldocs/out/` to `.gitignore`.
  Both patterns are anchored rather than `**/`-prefixed, because the reader and
  the report writer only ever address the repository-root `.keeldocs`, and a
  `**/` form would claim a scope the engine does not have. Consistent with
  init's rule that an existing file is human-owned: these are appended to, never
  replaced — existing rules survive byte for byte, a rule already present is not
  duplicated, a missing trailing newline is supplied before the append, a
  dry-run writes nothing, and a re-run changes no byte.

- **Detection proved a path and then threw it away.** For `argMode: root` —
  every provider that is not the prisma-style single-file case — the engine
  passed the repository root and nothing else, so `rails` re-joined
  `config/routes.rb` at the root, `next-routes` re-tested `app` and `src/app` at
  the root, `compose` re-walked its four filenames at the root, and
  `sql-policies` used four root-anchored migration directories. In a monorepo
  none of those exist, so each provider ran, found nothing, and returned an
  empty result that the engine could not tell apart from a repository with no
  API, no screens, no services and no row-level security. This is the same
  double duty `0.4.1` fixed for `schemaFile`, one step out: there, detection
  chose the wrong one of several files; here it chose correctly and was not
  asked.

  A new `argMode: detectedFile` hands the extractor the path detection proved,
  alongside the root. It is declared per provider rather than applied to every
  root-mode provider, and that distinction is load-bearing: `aspnet`, `django`,
  `spring`, `gin` and the rest detect on a marker file and then walk the whole
  tree, so naming their unchosen `detect.files` matches would manufacture gaps
  for files that were read. An unknown `argMode` used to fall through to the
  default; it is now a manifest error, because a typo there spells exactly the
  silence above.

  **Exactly which providers changed, because the last release shipped a claim
  like this one that was true of a subset.** Three manifests declare
  `argMode: detectedFile` and no others do: `rails`, `next-routes` and
  `compose`. `sql-policies` is *not* one of them — it detects with
  `always: true`, so there is no single proven path to hand it, and its half of
  this is a different change: its four migration directories are now matched as
  path segments anywhere in the tree rather than joined to the root, and its
  `inputs` gained the matching `**/` prefixes. `tbls-live` changed for the
  normalizer reason below, not this one. Five provider directories in total; no
  other provider's behaviour moves.

- **Every candidate the engine did not read is named.** `detect.files` is a
  basename match over the whole tree, so a repository with both
  `docker-compose.yml` and `compose.yaml` at the root has one of them read and
  the other passed over. It is now a `candidate-ignored` extraction gap naming
  the path, counted beside the coverage figure — the argument `schema-ignored`
  and `chain-ignored` already make. Which candidate wins is the engine's walk
  order, and nothing here claims it matches Docker's own precedence.

- **An extraction convenience was doing duty as the boundary of a guarantee.**
  `src/scope.js` keeps six directory names the provider walk does not enter —
  `node_modules`, `.git`, `dist`, `.keeldocs`, `golden`, `coverage` — which is
  harmless there, because a manifest that names one still reaches it. Two other
  places had helped themselves to that list. `docPathsOf` carried a hand-copied
  subset of it while recursing INSIDE a directory the user had written into
  `[docs] dirs`, and the `0.4.2` unscanned sweep inherited the whole of it. So
  `golden/`, `dist/` and `coverage/` — a repository's own test data and build
  output, which a repository may document into — were as unreadable as somebody
  else's `node_modules`, and unlike a provider, a document has no manifest to
  name it back in.

  Two rules now, and they are about the directory rather than about convenience.
  Inside a scan root the user wrote down, nothing is skipped except the three
  below: if you name `docs`, all of `docs` is read. Outside every scan root, the
  sweep asks the same narrower question instead of borrowing the extraction one.

  The three that stay unread are `node_modules` at any depth, `.git` at any
  depth, and `.keeldocs` at the repository root — and only the first is silent no
  longer. A dependency tree is still part of the repository on disk, so every run
  that passes over one names it, by path, in `data.skipped`, in the full report
  and in the human output. It is deliberately not a finding and moves no exit
  code: making it one would exit 1 on every repository that has run
  `npm install`, and a gate that fires on everything is the first one switched
  off. Sweeping it instead was the other option and is worse — the day the
  published tarball carries an anchored document, every repository with keeldocs
  in its dependencies would answer for a document it did not write. The skip is
  still a default and not a ban: `dirs = ["docs/node_modules"]` reads it.

  `.git` and the root `.keeldocs` are passed over without a word, and that is the
  one silence here that was argued for rather than inherited. Neither is
  repository content: an export of the identical tree carries no `.git`, and
  `.keeldocs` is the directory this command CREATES, so naming it would make the
  report say something different on the second run than on the first — the
  run-state leak the cold/warm byte-identical contract exists to forbid. A
  `.keeldocs` anywhere but the root is an ordinary directory and is read.

  **Exactly what did not change, because a claim of "the skip is gone" would be
  false in two directions.** The provider walk is untouched: all six names, all
  silent, byte-for-byte the extraction it always was, and every extractor golden
  unmoved. And `docs/dist/` and `docs/coverage/` were being scanned all along —
  the hand-copied subset had drifted from the set it was copied from, so two of
  the six were already read inside a scan root and four were not, which is
  precisely the kind of difference nobody can see from a config file. This
  repository's own `keeldocs.toml` now carries the exclusion that used to be a
  directory name: without its `fixtures/**` line the sweep reports twelve
  anchored fixture documents, seven of them under a `golden/` directory, which is
  the name that had made them invisible. (Two corrections to this sentence, both
  from re-running the sweep rather than re-reading it: it said eleven documents,
  and `exclude-shape-scenario` — added below — is the twelfth; and it said six
  goldens, where the sweep's own output lists seven, every one of which predates
  the first measurement.)

- **`exclude-paths` was one setting with two meanings, and the louder one was
  silent.** An exclusion names a path, and a path names its subtree — that
  sentence had two implementations. `exclude-paths = ["vendor"]` reached three of
  the four consumers: the directory left provider detection, left `inputs`
  resolution and left the anchored-doc sweep, so a capability went `ok` → `absent`
  and a drifting document stopped being reported. It did not reach the fourth.
  The facts read out of `vendor/` stayed in the coverage denominator, because
  `^vendor$` does not match `vendor/lib.js` — so the setting did all of its damage
  and none of its job, and `meta.scopedOut` / `meta.excludePaths` were emitted
  only when the count was non-zero, which is to say absent in precisely that case.

  One matcher now answers for every consumer: a path is out of scope when it
  matches, or when any of its ancestor directories does. Two spellings that mean
  the same thing produce the same fact set, the same capability statuses and the
  same view — checked through `resolveInputs`, so the claim holds on hosts that
  build no sandbox view as well as on the ones that do. What deliberately does
  **not** widen: `fixtures/**` still leaves the `fixtures` entry itself unmatched
  and prunes its contents one at a time, exactly as before, and a bare
  `demo.js` is still the file at the repository root and never a basename
  anywhere in the tree — the harness has pinned that second one since the scope
  shipped, and it still passes.

- **A scope that suppressed an anchored document said nothing about it.**
  `exclude-paths` exists to keep `fixtures/` out of the FACTS, and `0.4.2` gave
  it a second job by scoping the unscanned-document sweep with it. Nothing
  connects the two: `exclude-paths = ["**/*.md"]` excludes no code whatsoever —
  `scopedOut` stays 0, every env var is still counted, every provider still
  runs — and it switched the sweep off across the whole repository, putting the
  exact `git mv docs handbook` regression `0.4.2` was cut for back with an empty
  `meta` beside it.

  The scope still wins, because the user wrote it. Every anchored document it
  suppressed is now named in `data.excludedDocs`, in the full report and on the
  human channel. It is the `skipped` precedent and not the `unscanned` one: it
  moves no exit code and enters no count, because a repository that scoped out
  its examples does not have a problem — but a blind spot the report does not
  name is indistinguishable from an empty one. `meta.excludePaths` and
  `meta.scopedOut` are now emitted for a *configured* scope rather than a
  non-zero count, so `scopedOut: 0` beside a line the user wrote says the thing
  worth saying: it is not removing what they think it is.

  On this repository the disclosure is twelve documents, eleven of which were
  already invisible before this change and one of which is the new fixture.
  `check` on keeldocs itself stays `CLEAN` at exit 0.

- **Three normalizers still discarded every warning a provider sent.**
  `config-surface`, `db-policies` and live `db-schema` hardcoded an empty gap
  list, so a provider in one of those capabilities could report a blind spot
  perfectly and the engine would drop the sentence. This is the last of the
  class that had `drizzle` declaring `extraction-gap` for three releases while
  being structurally unable to emit one, and `workspace-layout` collapsing a
  three-member workspace to one package in silence.

  One consequence ships with it: the live provider deliberately does not model
  views, and it dropped them without a word, so a `--live` run over a catalog
  that is mostly views reported a complete-looking answer over a fraction of it.
  Each unmodelled catalog entry is now named. It is still not modelled — the
  scope decision is unchanged, only its silence.

### Also

- Two new fixtures, and they are a pair. `nested-layout-scenario` holds all four
  inputs below the root; `root-layout-scenario` holds the same four files, byte
  for byte, at the root. Every rails, next, compose and sql-policies fixture in
  this tree was root-layout, so all of their goldens passed against a shape none
  of them contained — the same reason the three refused breadth providers stay
  refused. The root twin is the control: it pins what this exact content yields
  (18 endpoints, 3 routes, 2 owned services, 2 policies and 1 rls), so a nested
  gate cannot pass by the nested fixture quietly emptying out.

- A third fixture, `exclude-shape-scenario`, and its whole design is the control.
  Everything excludable lives under one directory: the env var `VENDOR_SECRET_KEY`
  read from `vendor/lib.js` and nowhere else, the tree's only compose file at
  `vendor/docker-compose.yml`, and an anchored, drifting `vendor/notes.md`. So
  the run with no exclusion at all has to report a fact, an applicable provider
  and an unread document — which is what stops the two scope spellings from
  agreeing over an empty directory. Its one service is deliberately `image:`
  rather than `build:`, so it is not a coverage surface and the coverage numbers
  in that fixture move for env vars only.

## 0.4.2 — 2026-08-07

**A tenth and eleventh member of the same class, and this pair retires the whole
repository rather than one section.** Every case in `0.4.0` and `0.4.1` was a
marker or a file the engine skipped inside documentation it was reading. These
two are about which documentation it reads at all.

Measured, `0.4.1` versus this tree:

| what your repository contains | 0.4.1 | now |
|---|---|---|
| anchored `.md` files outside every `[docs] dirs` scan root | `CLEAN`, exit 0 | `UNREADABLE`, exit 1, each file named |
| a `[docs] dirs` entry naming a directory that does not exist | `CLEAN`, exit 0 | `CONFIG`, exit 2 |

### Fixed

- **`git mv docs handbook` silently retired a whole repository from drift
  detection.** `[docs] dirs` defaults to `["docs"]` and nothing outside the
  configured roots is ever read — correct, and completely silent. Measured on
  this project: after the rename, five committed markers were still tracked, every
  anchor still real, and `check` still reported `CLEAN` and exited 0 while
  checking none of them. One `mv`, one PR, no warning; the documents go on being
  wrong and the tool that exists to say so says nothing.

  `check` now sweeps the rest of the tree and reports any document that is
  anchored and unread, under `UNREADABLE` — because such sections are not clean,
  they are not checked, and the drift count for the run was computed without
  them. Each file is named in `data.unscanned` and in the summary, with the
  directory to add to `[docs] dirs`, since a count nobody can act on is not a
  finding.

  It fires on real structure only — parsed anchors and regions, never a
  quarantined marker — and it reuses the anchor parser, so fenced illustrations
  stay silent. Both are load-bearing: this repository's own `CLAUDE.md`,
  `AGENTS.md` and `skills/keeldocs-core/SKILL.md` each mention
  `<!-- keeldocs:gen -->` in an inline code span, and a sweep that flagged those
  would go red on its own dogfood for three sentences of prose. The sweep honours
  `[providers] exclude-paths` and refuses to enter nested checkouts, so a vendored
  repository's documents stay somebody else's. No git and no clock: it is the same
  pure function of the tree the rest of `check` is.

- **A scan root that does not exist was a quieter run, not an error.** `dirs =
  ["docz"]` loaded, scanned nothing, and — because `README.md` is always scanned —
  reported `CLEAN` with a summary reading `across 1 doc(s)`, which looks like an
  answer. It is now a `CONFIG` error at exit 2, the same treatment `[providers]
  disable` already gave an unknown provider id, and for the same reason: it names
  something that cannot be read. Only a root the config file *names* is enforced —
  the `["docs"]` default stays optional, so a greenfield repository with no
  `docs/`, no `keeldocs.toml` and no anchors still runs and still exits 0.

- **A workspace whose members keeldocs could not resolve reported as a
  single-package repository.** `workspace-layout` counts a declared member only
  when it carries a `package.json` — which is what pnpm itself requires, so the
  drop is right and inventing a package for the others would be a guess. Dropping
  them *silently* is what was wrong. Measured on a pnpm workspace declaring three
  members across two patterns, of which one is a Python package and one a Go
  module: one package reported, and because the system-map renderer writes no
  Packages section for a single-package repo, no generated document mentioned the
  workspace at all. Two shapes were quieter still — a tab character where the YAML
  wants spaces, and a valid manifest carrying no `packages:` key — each of which
  reported `manager: single`, one package, and no error of any kind.

  The provider now names every declared member it declined to resolve, every
  manifest it could not parse and every manifest that declares no members; the
  normalizer that hardcoded `gaps: []`, and so could not have carried them
  anyway, passes them through. These are extraction gaps and not drift: the exit
  code does not move, the fact set is unchanged, and nothing is guessed on your
  behalf. What changes is that the gap count now appears beside coverage in
  `check`'s summary and each gap is named, with its directory or manifest, in the
  full report and in the `init` report.

  All of that holds for **npm and yarn as well as pnpm**, which is worth stating
  because for a few hours it did not. The first version of this fix handled the
  unparseable and memberless cases in the pnpm branch alone, while this entry
  claimed every manifest — and npm/yarn is most repositories. The npm/yarn branch
  kept a single `except` around the read, the parse and the expansion together,
  and an unusable `workspaces` value fell through to the single-package fallback
  silently. That shape was the worse of the two: an unparseable `package.json`
  also defeats the name lookup, so the repository was reported under its
  *directory* name rather than its declared one, an invented identity with no gap
  beside it. No gate could have caught the split, because every multi-package
  fixture here was pnpm; the gate now runs all three shapes on both managers, and
  its control asserts that a `package.json` with no `workspaces` key stays silent
  — otherwise the other assertions would pass against a provider that merely
  always complains.

## 0.4.1 — 2026-08-06

**Three more of the case `0.4.0` was cut for, and all three were in the tree
`0.4.0` shipped from.** Each is `check` reporting `CLEAN`, or a coverage figure of
`100%`, over documentation that was not being checked. Publishing a release whose
opening claim is "six shapes reported clean while checking nothing" and then
finding a seventh, an eighth and a ninth in the same tree is the argument for
this file existing, not against it.

Measured, `0.4.0` versus `0.4.1`:

| what your repository contains | 0.4.0 | 0.4.1 |
|---|---|---|
| a marker whose `hash=` names an algorithm the engine does not implement | `CLEAN`, exit 0 | `UNREADABLE`, exit 1 |
| a second `schema.prisma` the engine did not choose | `100%` documented, no gap | `100%`, and the skipped file named |
| a database policy containing `\|\|` | table torn apart, then certified | rendered and checked |

Upgrading is a straight patch: nothing that was correct in `0.4.0` changes, and
`sync` repairs the first case in one pass.

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

- **A monorepo's second `schema.prisma` was never read, and nothing said so.**
  For a provider whose `argMode` is `schemaFile`, detection does not merely decide
  whether the provider applies — it decides which single file gets parsed, by
  basename match anywhere in the tree. A repository with two real schemas
  documented the models in one of them and stopped. The others were absent from
  the ERD, absent from the fact set, and absent from the gap list, while `check`
  reported `100%` of surfaces documented. A coverage ratio whose denominator
  quietly dropped an entire service is wrong in both of its terms, and `100%` is
  the most convincing possible way to be wrong. Which schema won was lexicographic
  accident.

  The engine chose the file, so the engine now names the ones it did not choose: a
  `schema-ignored` gap per skipped path, and `check` counts extraction gaps beside
  the coverage figure. This does not read both schemas — it stops the tool from
  implying it read everything. The same argument `meta.scopedOut` already exists
  for: coverage is a ratio and both of its terms have to be legible. A path scope
  is a blind spot you chose; this one you did not, and it was strictly less
  visible.

- **`||` is ordinary SQL, and it tore the generated table apart.** A database
  policy using Postgres string concatenation rendered eleven cells under a
  seven-column header, because none of the eleven row emitters escaped the cell
  separator. Worse than cosmetic: the mangled body is content-hashed like any
  other, so `check` certified the wreckage as accurate for as long as it stood.

### Also

- **The upgrade signal that was supposed to explain an upgrade did not move.**
  `providerSetHash` — the toolchain fingerprint — takes one distinct value across
  `v0.2.0`, `v0.3.0`, `v0.4.0` and `HEAD`, a range in which a provider's `emits`
  changed, `emits` became enforced, path scoping landed, and 206 lines of pinned
  extractor grammars moved. A content-derived fingerprint takes three, and the
  result that matters is not that it moves more but that it discriminates: silent
  across `0.2.0 → 0.3.0`, which touched no extraction-relevant file, and firing
  across `0.3.0 → 0.4.0`, which moved the grammar pins.
  `scripts/dev/toolchain-fingerprint.py` recomputes it. Where such a value should
  be *recorded* is unresolved and deliberately not guessed here: the anchor
  grammar is frozen at generation 1 and the journal contract says it holds no
  hashes, so both existing stores are closed.

- **Three breadth providers stay refused, with written thresholds.** rails-sql,
  expo-router and django-orm were built and rejected. The reason is sharper than
  the defects: every one of the three goldens is invariant under the mutation that
  would matter, so fixing the defect produces a byte-identical golden and the test
  cannot fail either way. Each refusal now names the fixture contents that would
  change the answer.

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
