# compose-scenario fixture

A two-package npm workspace fronted by docker-compose: `api` and `worker` are
owned services (they have `build:`); postgres and redis are external
dependencies (image-only). Exercises the workspace-auto + compose providers,
the system-map recipe, and the owned-vs-external coverage rule.
