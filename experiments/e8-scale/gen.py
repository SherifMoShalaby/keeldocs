#!/usr/bin/env python3
"""E8 synthetic monorepo generator (risk R10: the scale wall).

Shape matters more than size: the gate is about a MONOREPO, so the tree is
N packages with real workspace manifests, cross-package imports, express route
registration, env reads and a migration chain - the surfaces every capability
actually extracts. A million lines of `// filler` would measure nothing.

Usage: gen.py <outdir> <packages> <files-per-package> <lines-per-file>
"""
import json, os, sys


def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def module(pkg, i, lines):
    body = [f"// {pkg} module {i}", "import { helper0 } from './m0';",
            f"import {{ shared }} from '@syn/pkg{max(0, i % 3)}';",
            "const TIMEOUT = Number(process.env.SYN_TIMEOUT ?? 30);", ""]
    n = 0
    while len(body) < lines:
        n += 1
        body += [f"export function op{n}(a: number, b: number): number {{",
                 f"  const scale = TIMEOUT * {n};",
                 "  return a * b + scale;", "}", ""]
    return "\n".join(body[:lines]) + "\n"


def routes(pkg, idx, lines):
    body = ["import express from 'express';", "const router = express.Router();",
            f"const KEY = process.env.SYN_KEY_{idx} ?? '';", ""]
    n = 0
    verbs = ["get", "post", "patch", "delete"]
    while len(body) < lines:
        n += 1
        v = verbs[n % 4]
        body += [f"router.{v}('/{pkg}/res{n}', (req, res) => res.json({{ ok: true, key: KEY }}));"]
    body += ["", "export default router;"]
    return "\n".join(body) + "\n"


def main(out, npkg, nfiles, nlines):
    w(os.path.join(out, "package.json"), json.dumps(
        {"name": "syn-monorepo", "private": True, "workspaces": ["packages/*"],
         "devDependencies": {"express": "^4.19.2"}}, indent=1) + "\n")
    w(os.path.join(out, ".env.example"), "".join(
        f"SYN_KEY_{i}=\n" for i in range(npkg)) + "SYN_TIMEOUT=\n")
    total = 0
    for p in range(npkg):
        base = os.path.join(out, "packages", f"pkg{p}")
        w(os.path.join(base, "package.json"),
          json.dumps({"name": f"@syn/pkg{p}", "version": "1.0.0"}, indent=1) + "\n")
        src = os.path.join(base, "src")
        w(os.path.join(src, "m0.ts"), "export const helper0 = 1;\nexport const shared = 2;\n")
        total += 2
        for f in range(nfiles):
            if f == 0:
                text = routes(f"pkg{p}", p, nlines)
            else:
                text = module(f"pkg{p}", f, nlines)
            w(os.path.join(src, f"m{f + 1}.ts"), text)
            total += text.count("\n")
    # one migration chain so db-schema and the PostgREST surface do real work
    mig = ["create table syn_events (id bigserial primary key, at timestamptz default now(), note text);"]
    for t in range(40):
        mig.append(f"create table syn_t{t} (id serial primary key, name text not null, "
                   f"ev bigint references syn_events(id));")
    w(os.path.join(out, "supabase", "migrations", "0001_init.sql"), "\n".join(mig) + "\n")
    print(json.dumps({"packages": npkg, "files": npkg * (nfiles + 1) + 2,
                      "loc": total, "dir": out}))


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]))
