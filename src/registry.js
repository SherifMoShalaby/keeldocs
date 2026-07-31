// Provider registry for the v0.1 engine.
// NOTE (deliberate, tracked duplication): these entries mirror providers/*/provider.yaml.
// The engine gains a YAML registry loader when the pinned query runtime lands; until
// then this file is the single machine-read source and provider.yaml is the contract
// documentation. Keep them in lockstep - the harness compares ids/semvers at test time.

export const ENGINE_VERSION = "0.1.0-rc.1";

export const REGISTRY = [
  {
    id: "nestjs", semver: "0.1.0", capability: "http-endpoints", tier: "declarative",
    detect: { deps: ["@nestjs/core"] },
    entry: "providers/http-endpoints/nestjs/prototype/extract_nestjs.py",
    argMode: "root",
  },
  {
    id: "express", semver: "0.1.0", capability: "http-endpoints", tier: "code",
    detect: { deps: ["express"] },
    entry: "providers/http-endpoints/express/prototype/extract_express.py",
    argMode: "root",
  },
  {
    id: "prisma", semver: "0.1.0", capability: "db-schema", tier: "code",
    detect: { deps: ["prisma", "@prisma/client"], files: ["schema.prisma"] },
    entry: "providers/db-schema/prisma/prototype/extract_prisma.py",
    argMode: "schemaFile",
  },
  {
    id: "env-readers", semver: "0.1.0", capability: "config-surface", tier: "code",
    detect: { always: true }, // the env surface exists in any repo; zero vars = zero facts
    entry: "providers/config-surface/env-readers/extract_env.py",
    argMode: "root",
  },
  {
    // Full-parse of workspace manifests (yaml/json libs, not regex) - PARSED
    // despite the declarative tier, hence the explicit confidence override.
    id: "workspace-auto", semver: "0.1.0", capability: "workspace-layout", tier: "declarative",
    confidence: "PARSED",
    detect: { always: true }, // every repo has a layout; single-package = one fact
    entry: "providers/workspace-layout/auto/extract_workspace.py",
    argMode: "root",
  },
  {
    id: "compose", semver: "0.1.0", capability: "services-topology", tier: "declarative",
    confidence: "PARSED",
    detect: { files: ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] },
    entry: "providers/services-topology/compose/extract_compose.py",
    argMode: "root",
  },
  {
    // MUST run after workspace-auto: symbol IDs take their package segment from
    // workspace-layout facts (ADR-007; the registry array is the v0.1 DAG order).
    id: "ts-imports", semver: "0.1.0", capability: "module-graph", tier: "code",
    detect: { always: true }, // TS/ESM surface may exist in any repo; zero files = zero facts
    entry: "providers/module-graph/ts-imports/extract_symbols.py",
    argMode: "root",
  },
  {
    id: "git-log", semver: "0.1.0", capability: "decision-history", tier: "code",
    detect: { always: true }, // answers honestly (zero files + warning) off a git toplevel
    entry: "providers/decision-history/git-log/extract_gitlog.py",
    argMode: "root",
  },
];
