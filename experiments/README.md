# Validation experiments (E1-E4)

Mini-run prototypes and results from 2026-07-30 that validated the design's load-bearing
assumptions before this scaffold existed (full report: VALIDATION-REPORT.md). E1's extractors
graduated into providers/*/prototype/ and power the fixture harness; two bugs the fixtures
caught post-E1 (variable-assigned require in Express; string-aware comment stripping in
Prisma) are fixed in the provider copies - the copies here are the originals, kept as run
records. E2/E3's replay pipeline and E4's lie-detector become engine components; full-corpus
reruns (30 repos/framework, per-commit granularity) are build-time CI per docs/design/08.
