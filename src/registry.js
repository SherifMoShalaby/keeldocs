// Provider registry for the v0.1 engine.
// NOTE (deliberate, tracked duplication): these entries mirror providers/*/provider.yaml.
// The engine gains a YAML registry loader when the pinned query runtime lands; until
// then this file is the single machine-read source and provider.yaml is the contract
// documentation. Keep them in lockstep - the harness compares ids/semvers at test time.

export const ENGINE_VERSION = "0.1.0-dev.0";

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
];
