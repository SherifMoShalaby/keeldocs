# Security policy

keeldocs runs inside other people's repositories and inside their CI. That is
the whole reason this file exists, and it is why the honest parts of it matter
more than the reassuring ones.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting:**
<https://github.com/SherifMoShalaby/keeldocs/security/advisories/new> — or the
repository's **Security** tab → **Advisories** → **Report a vulnerability**. It
opens a private thread with a draft advisory and, if a fix needs collaboration,
a private fork.

If that page returns a 404, private reporting has not been switched on. It is
off by default. A repository admin enables it at **Settings → Advanced
Security** (the tab was called *Code security and analysis* in the older UI) →
**Private vulnerability reporting** → **Enable**. The same path applies to
forks, which do not inherit the setting.

**Fallback, so this is never a dead end:** open an ordinary issue that contains
no technical detail — "I have a security report and need a private channel" is
enough — and you will get an advisory invitation. Please do not put the details
there. A public issue describing a working attack against a tool that holds a
token in other people's CI *is* the disclosure, not a report of it.

What makes a report actionable here: the version (`keeldocs --version`), how it
was invoked (CLI, the composite Action, the rollup Action, an agent skill),
whether the repository being checked was trusted input, and a minimal
reproduction. A fixture repository is the ideal form, because that is how
everything else in this project is tested and it is what a fix will be gated on.

## What to expect, honestly

This is a one-maintainer project. There is no on-call rotation, no paid triage,
no bug bounty, and no PGP key. Promising a 24-hour acknowledgement would be a
lie, and a security policy that opens with a lie is worse than no policy. What
is actually sustainable:

- **Acknowledgement within 7 days.** You will be told a human has read it.
- **First substantive assessment within 21 days** — whether it reproduces, what
  the blast radius is, and whether a fix is in reach.
- **No fix date is promised in advance**, with the one exception below.

Reports can land during travel or a busy fortnight, and multi-day silence is
normal rather than a signal that something went wrong. If 14 days pass with no
acknowledgement at all, escalate by opening a public issue stating only that a
security report is awaiting acknowledgement — no details, no reproduction.

**The exception.** Credible evidence that a *published artifact* is compromised
— a tarball on npm that does not match this repository, a release that carries
no provenance attestation, a lifecycle script in a dependency — is worked
immediately, ahead of everything else, and gets a same-day acknowledgement if it
is seen at all that day.

## Supported versions

| Version | Supported |
|---|---|
| `0.3.x` — current `latest` on npm | Yes. Security fixes ship here. |
| Everything below `0.3` | No. There are no backports. |

Before 1.0 there are no maintenance branches and no LTS line: the upgrade path
for a security fix is the newest release. Maintaining parallel fix lines is not
something one person can do without one of them quietly rotting, and a stale
"supported" branch is a worse promise than an honest refusal. This changes when
the anchor spec freezes at 1.0 and a written migration policy exists.

## Scope

keeldocs is designed to be pointed at code nobody has read yet — that is the
first-run product. **A hostile input repository is a supported threat model, not
an excuse.** The following are security issues here, each tied to a risk in
`docs/design/08-risks-experiments.md`:

**Secrets reaching generated artifacts or stderr (R8).** keeldocs reads `.env`
files, migrations, driver errors and git history, then writes markdown into your
repository. A leak is a breach, not a bug: value-blindness is structural, and a
redaction barrier runs on every write. Both are gated — the harness asserts that
a seeded secret becomes `[REDACTED]` in the document, that the envelope says so
loudly rather than silently, and that the redacted document is still born clean.
Any bypass is in scope and is treated as high severity.

**Injection surviving into an executed action (R11).** The artifacts keeldocs
writes are read back by coding agents, which is precisely the trust the tool
manufactures. The E10 red-team is a permanent CI gate: unsigned, untrusted and
tampered provider installs are all refused by name, and marker forgery is
neutralized. Anything that gets an agent to *act* on attacker-controlled text
that arrived through a keeldocs artifact is in scope.

**Escape from the provider execution model.** Providers are subprocesses with
network denied, the repository read-only, and a readable set equal to their
declared input globs minus a security exclusion set. On Linux with user and
mount namespaces that is enforced; on hosts without them keeldocs reports the
degraded tier rather than pretending, because a manifest that is a statement of
intent and a manifest that is a boundary are different things and saying so is
the difference between a control and theatre. A provider reading outside its
declared globs *on a host that reported the enforcing tier* is in scope.

**Anything that makes `check` lie.** The `check` path is a pure function of the
tree: no network call, no LLM call, no clock read. An input that makes it report
CLEAN over documentation that does not match the code, or that makes its output
depend on something outside the tree, attacks the only claim this project makes.

**The permissions the Actions request in your CI** — see below.

Out of scope, and better filed as ordinary issues: drift false positives,
extraction gaps, `unresolvable` output, diagram rendering, and anything that
requires the attacker to already hold write access to the repository being
checked or to the machine running the tool.

## What running keeldocs actually grants

`keeldocs check` reads the repository tree, runs the Python extractor
subprocesses, and writes an envelope and a SARIF file into the workspace. It
makes no network calls; that is an invariant of the design, not a setting.

The composite Action's documented CI block requests `contents: read`,
`security-events: write` and `pull-requests: write`. Only the first is required:
the two write scopes exist for the SARIF upload and the sticky PR comment, and
setting `sarif: false` and `comment: false` reduces the Action to `contents:
read`. Both of those steps are `continue-on-error` and never fail your build for
a missing scope.

**The rollup Action is a different blast radius and you should know that before
you schedule it.** It needs `contents: write` and `pull-requests: write`,
because its job is to push a branch and open the weekly sync PR. Generated
content is never auto-merged — that is on the permanent kill list, not a default
— but the token it holds can write to your repository. Read `rollup/action.yml`
before you wire it up.

## Supply-chain posture

R9 in the risk register is a Shai-Hulud-class worm travelling through a
documentation tool that has repository access in CI. It is named as the risk
that kills this project. Here is what is actually in place, stated so a reporter
knows what is already covered and what is not.

**Guaranteed, and verifiable by you:**

- **Publishing is npm Trusted Publishing over OIDC, and no publish token
  exists.** There is no `NPM_TOKEN` in this repository, in an environment, or in
  an org secret; none has been created, and none will be. `release.yml` runs
  only on a `v*` tag, holds `contents: read` and `id-token: write`, and publishes
  with `npm publish --provenance`. A stolen credential cannot publish keeldocs,
  because there is no credential to steal — an attacker would have to push a tag
  through this repository's own controls.
- **A SLSA v1 provenance attestation on every release**, first verified on
  2026-08-03, naming the workflow file, the repository and the tag ref that
  produced the tarball. Check it yourself with `npm audit signatures`, or read
  the provenance on the npm page. **If a published keeldocs version carries no
  provenance attestation naming `.github/workflows/release.yml`, do not install
  it — report it.**
- **Zero install scripts, zero runtime dependencies, one optional dependency.**
  `package.json` declares no `dependencies` at all. `@electric-sql/pglite` is
  the single `optionalDependency`, exact-version pinned, used by the
  migration-replay path and installed from the lockfile by `npm ci`.
- **Those budgets are gated, not merely stated.** The harness fails — and
  therefore the release fails, because `release.yml` runs the full suite before
  publishing — if runtime plus optional dependencies exceed five, if
  `package.json` declares a `preinstall`, `install` or `postinstall` script, or
  if *any* entry in `package-lock.json` is flagged `hasInstallScript`. The
  lockfile walk is the part that carries weight: this class of worm arrives
  through a lifecycle script in a dependency of a dependency, which a
  direct-dependency count cannot see. Until 2026-08-03 these budgets were
  written in the risk register and enforced by nothing at all, in the harness or
  in either workflow. That gap was the real exposure, and closing it is why the
  distinction between "we intend to keep dependencies near zero" and "the build
  fails if we do not" is drawn here explicitly.

**Not guaranteed, and stated rather than left to be discovered:**

- **No external security review has been performed.** One is scheduled against
  the v1.0 gates rather than earlier, on the reasoning that a review's value
  scales with the size of the user base it protects. Everything above is the
  work of the people who wrote the code.
- **The Python extractor runtime is version-pinned but not hash-pinned.**
  `providers/requirements.txt` is **hash-pinned**, and every install site
  uses `pip install --require-hashes`: `ci.yml` (twice), `release.yml`,
  `action.yml` and `rollup/action.yml`. All 173 published sha256 digests for
  the eight pinned versions are listed, so all three CI operating systems
  resolve to a covered wheel, and the dependency closure is exactly those
  eight - none declares a runtime dependency. `scripts/harness.py` asserts
  both properties on every push, so a pin cannot silently lose its hashes
  and an install site cannot silently drop the flag.

  This closes what was previously the largest ungated part of the dependency
  surface. Exact versions alone are not a supply-chain control: pip executes
  package build and install code, and `pip install -r` runs on every
  consumer's CI runner via `action.yml` and in `release.yml`, which holds
  `id-token: write` for the provenance attestation. "Zero install scripts"
  was only ever true of the npm half.
- **The lockfile walk is only as deep as the lockfile.** Today
  `package-lock.json` holds two entries — the root and pglite — so the check is
  currently strong because the posture is narrow, not because the walk is
  exhaustive. It becomes load-bearing the moment a dependency is added, which is
  exactly when it is wanted.
- **Workflow actions are pinned by tag, not by commit SHA.** Tags move. This is
  a known gap in workflows that hold `id-token: write`.
- **The provider sandbox degrades by host**, as described under Scope. keeldocs
  reports the tier it is actually enforcing; it does not claim the Linux tier
  elsewhere.
- **npm and GitHub are trusted.** Provenance proves which workflow built a
  tarball. It does not defend against a compromise of the registry that serves
  it, or of the CI platform that produced it.

## If keeldocs is compromised

The affected versions get deprecated on npm with a message naming the advisory,
and unpublished where npm's policy permits. An advisory is published through
GitHub, with a CVE requested through it. The package's trusted-publisher
configuration is revoked at npmjs.com, so no further release can be produced
until it is deliberately re-established. **There is no publish token to rotate —
that is the point of not having one.**

The provenance attestations are the audit trail: every legitimate tarball names
the tag and the workflow that built it, so "was this build ours" is a question
with an answer rather than a judgement call.

If you consume keeldocs in CI, the two things that help most are pinning an
exact version and running `npm audit signatures`.

## Disclosure

Coordinated disclosure. The default is 90 days from acknowledgement to public
advisory, or the day the fix ships, whichever comes first. If a fix is not ready
at 90 days you are free to disclose, and this project will not ask you to extend
quietly — if more time is genuinely needed, the reason will be stated publicly
rather than negotiated in private. Evidence of active exploitation moves the
advisory forward immediately, with mitigations, fix or no fix.

Reporters are credited in the advisory by default; say the word and you will not
be. There is no bounty, and there will not be one before there is funding to pay
it with.
