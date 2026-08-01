import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { globToRegExp, isExcluded, repoFiles, resolveInputs, buildView } from "../src/scope.js";

function tmpRepo(t, files) {
  const root = mkdtempSync(join(tmpdir(), "kd-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const m = (glob, path) => globToRegExp(glob).test(path);

test("the manifest glob subset matches exactly what provider.yaml uses", () => {
  assert.ok(m("**/*.py", "a/b/c.py") && m("**/*.py", "c.py"), "** spans zero or more dirs");
  assert.ok(!m("**/*.py", "a/b/c.pyc"));
  assert.ok(m("src/**/*.tsx", "src/a/b.tsx") && !m("src/**/*.tsx", "lib/a.tsx"));
  assert.ok(m("*.js", "index.js") && !m("*.js", "src/index.js"), "* never crosses a separator");
  assert.ok(m("**/*.{ts,js}", "a/b.ts") && m("**/*.{ts,js}", "a/b.js") && !m("**/*.{ts,js}", "a/b.go"));
  assert.ok(m("prisma/migrations/*/migration.sql", "prisma/migrations/0001_x/migration.sql"));
  assert.ok(!m("prisma/migrations/*/migration.sql", "prisma/migrations/a/b/migration.sql"));
  assert.ok(m("supabase/functions/*/index.*", "supabase/functions/send/index.ts"));
  assert.ok(m("docker-compose*.{yml,yaml}", "docker-compose.prod.yml"));
  assert.ok(m(".git/", ".git/objects/ab/cd") && !m(".git/", "src/.gitkeep"),
    "a trailing slash means the directory, recursively");
  assert.ok(m("a.b.c", "a.b.c") && !m("a.b.c", "axbxc"), "dots are literal, not any-char");
});

test("the security exclusion set subtracts secrets, and rescues the example forms", () => {
  for (const secret of [".env", ".env.local", "app/.env.production", ".npmrc", ".netrc",
                        "certs/server.pem", "deploy/id_rsa", "a/private.key", "home/.ssh/config",
                        "infra/.aws/credentials", "keys/store.jks"]) {
    assert.ok(isExcluded(secret), `${secret} must never reach a provider`);
  }
  for (const safe of [".env.example", ".env.sample", ".env.schema", ".env.template",
                      "src/keys.ts", "docs/pem.md", "src/monkey.py"]) {
    assert.ok(!isExcluded(safe), `${safe} is not a secret and must stay readable`);
  }
});

test("declaring the world still does not buy secrets", (t) => {
  const root = tmpRepo(t, {
    "src/app.ts": "x", ".env": "DB_PASSWORD=hunter2", ".env.example": "DB_PASSWORD=",
    "certs/tls.pem": "-----BEGIN", "README.md": "hi",
  });
  const all = repoFiles(root);
  const { files } = resolveInputs(root, ["**/*"], all);
  assert.ok(files.includes("src/app.ts") && files.includes("README.md"));
  assert.ok(files.includes(".env.example"), "the example form is how a provider learns a var exists");
  assert.ok(!files.includes(".env"), "the value-bearing file is subtracted however broadly it was declared");
  assert.ok(!files.includes("certs/tls.pem"));
});

test("a narrow manifest yields a narrow view, and `${facts:…}` is not a path", (t) => {
  const root = tmpRepo(t, {
    "supabase/migrations/0001.sql": "create table t();",
    "src/secret-logic.ts": "x", "package.json": "{}",
  });
  const all = repoFiles(root);
  const { files, dirs } = resolveInputs(root, ["supabase/migrations/*.sql", "${facts:db-schema}"], all);
  assert.deepEqual(files, ["supabase/migrations/0001.sql"],
    "a migration provider gets migrations - not the application source next to them");
  assert.deepEqual(dirs, [], "a facts token is delivered by the engine, never matched as a glob");
});

test("a directory grant becomes a mount point, files become hardlinks", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "code", ".git/HEAD": "ref: refs/heads/main" });
  const all = repoFiles(root);
  const { files, dirs } = resolveInputs(root, ["src/**/*.ts", ".git/"], all);
  assert.deepEqual(files, ["src/a.ts"]);
  assert.deepEqual(dirs, [".git"], "a whole-directory grant is not walked into a hardlink farm");

  const view = join(root, ".keeldocs", "cache", "scope", "p");
  const { mounts } = buildView(root, view, { files, dirs });
  assert.equal(readFileSync(join(view, "src/a.ts"), "utf8"), "code");
  assert.equal(statSync(join(view, "src/a.ts")).ino, statSync(join(root, "src/a.ts")).ino,
    "the view is a second NAME for the same inode - it costs directory entries, not bytes");
  assert.ok(statSync(join(view, ".git")).isDirectory(), "the mount point must exist before the view goes read-only");
  assert.equal(mounts.length, 1);
  assert.ok(mounts[0][0].endsWith("/.git") && mounts[0][1].endsWith("/scope/p/.git"));
});

test("repoFiles skips engine-owned and vendored trees", (t) => {
  const root = tmpRepo(t, {
    "src/a.ts": "x", "node_modules/pkg/i.js": "x",
    ".keeldocs/cache/facts/db-schema.jsonl": "{}", "golden/out.json": "{}",
  });
  assert.deepEqual(repoFiles(root), ["src/a.ts"]);
});
