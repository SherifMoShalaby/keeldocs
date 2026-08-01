# E14 — Java/Go extraction probes (the N2 probe-first gate)

**Question (doc 11 N2).** Before building providers, which tier fits each
framework — declarative `.scm` or code? The E1 lesson: guessing this wrong
cost express 95% recall; the tier is an empirical property of how the
framework REGISTERS routes, not a preference.

**Method.** Real-repo probes, 2026-07-31, ground truth by exhaustive grep +
manual classification of every hit.

## Spring MVC — spring-projects/spring-petclinic

Ground truth: 17 method-level `*Mapping` annotations + 1 class-level
`@RequestMapping` prefix (one further grep hit is a javadoc comment).
Registration is ANNOTATION-SHAPED — the nestjs case — but Java annotations
are member-attached (inside the method's `modifiers`), not sibling
decorators, so the tsq runtime gained an `association: member` mode
(enclosure walk instead of positional sibling run) rather than a per-
framework extractor.

**Result: 17/17 endpoints, 0 warnings, 0 false positives** — including the
class-prefix composition (`/owners/{ownerId}/pets/new`), the array form
(`@GetMapping({"/find", "/search"})` in the fixture; `{"/vets"}` in
petclinic), bare `@GetMapping` (prefix-only), and `value=`/`path=`
element-value pairs. **Verdict: declarative tier** — `providers/
http-endpoints/spring` is one provider.yaml + one endpoints.scm, no code.

## gin — eddycjy/go-gin-example

Ground truth: 18 grep hits for `.VERB(` — 15 real registrations; 3 are
vendored gin internals (correctly out of scope). Registration is
DYNAMIC — routes hang off group VARIABLES (`apiv1 := r.Group("/api/v1")`),
invisible to a single-tree query: the express shape that scored 5% recall
for declarative in E1. **Verdict: code tier** — `extract_gin.py` resolves
same-file group chains recursively (gin's idiom keeps registration local).

**Result: 15/15 endpoints, 0 warnings, 0 false positives**, with full
group-prefix composition. Honesty contract exercised by the fixture:
non-literal `Group(expr())` prefixes and routes on receivers a file never
defines emit named gaps, never guessed paths.

## Shipped alongside (the Python-parity floor for both languages)

workspace-layout identity: `go.mod` module path (last segment) and maven
project-level `artifactId`; config-surface reads: `os.Getenv`/
`os.LookupEnv` (Go) and `System.getenv` (Java), value-blind as always.

## Honest limits

Petclinic and go-gin-example are one repo each — the FP <10% GA bar (doc 07)
still requires 2 real repos per language measured in the field (E9-shaped,
owner-side). Not probed: method-level `@RequestMapping(method=...)` maps to
`ALL` rather than the attribute's verb; gin cross-FILE group passing emits a
gap (idiomatic repos keep registration in one file; measure prevalence
before building a mount graph); echo/chi/gorilla and JAX-RS/Micronaut are
separate probes when their turn comes. Symbol extraction (`ds` ids) for
Java/Go landed as the immediate follow-up (same day): go-symbols (package-dir
modules with dir-to-dir internal import edges; exported funcs/methods/types)
and java-symbols (declared-package modules; public/protected classes,
interfaces, enums, methods) — both with normalized sigs + nameless shapes so
S1b/S2 re-anchoring works for these languages too.

## Addendum — breadth batch 2 (2026-08-01)

Same probe-first method, four more stacks off the brief's constraint-1 list:
**Django** — probed on wagtail/bakerydemo: URLconfs are an `include()` graph
(the Express mount lesson again) → code tier; 8/8 repo-local endpoints on
the probe app with honest gaps for external urlconfs and regex routes;
method-agnostic platform → routes emit `ALL`. **Rails** — `routes.rb` is a
constrained DSL, not general Ruby: a deterministic block-stack parser covers
resources (RESTful expansion with only/except), verbs, namespace/scope
prefixes, and root, with unrecognized DSL as named gaps — no Ruby grammar
added for one file. **ASP.NET Core** — both idioms in one code provider:
attribute controllers (member-attached, the Spring shape, with
`[controller]` resolved to the true class name) and minimal APIs
(MapGet/MapGroup variable chains, the gin shape, where a leading slash
still nests under its group). **echo + chi** — absorbed into the go-router
family extractor: echo shares gin's shapes verbatim; chi added Capitalized
verbs (route-shaped-only, guarding against gin's own `c.Get("key")` —
the regression corpus stayed 15/15 with zero warnings) and `Route`
closure-scope nesting. **Flutter/Dart** — identity from `pubspec.yaml`
and `String.fromEnvironment`/`Platform.environment` env reads; GoRouter
route extraction waits on a maintained dart grammar. Field recall probes
for Django/Rails/ASP.NET beyond the fixtures ride E9, owner-side.
