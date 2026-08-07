import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { docSkip, globToRegExp, isExcluded, repoFiles, resolveInputs, buildView } from "../src/scope.js";

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

// The extraction walk above and the DOCUMENT walk are two different questions,
// and for one release they were the same answer. Six names nobody wants a
// provider to spend a walk on became six names no anchored document could be
// found in, so `golden/reference.md` was as unreadable as `node_modules/`'s -
// and unlike a provider, a document has no manifest to name it back in.
// `docSkip` is the narrower question; this pins that they stay different, and
// that the walk reports what it passed over rather than dropping it.
test("the document walk asks a narrower question than the provider walk, and says what it skipped", (t) => {
  const root = tmpRepo(t, {
    "src/a.ts": "x", "node_modules/pkg/README.md": "x", "vendor/node_modules/p/README.md": "x",
    ".keeldocs/out/check.json": "{}", ".git/objects/o": "x",
    "golden/docs/ref.md": "x", "dist/docs/ref.md": "x", "coverage/docs/ref.md": "x",
  });
  // unchanged for providers: all six names, silently, exactly as before
  assert.deepEqual(repoFiles(root), ["src/a.ts"]);

  const skipped = [];
  assert.deepEqual(repoFiles(root, [], null, { skipDir: docSkip, skipped }),
    ["coverage/docs/ref.md", "dist/docs/ref.md", "golden/docs/ref.md", "src/a.ts"],
    "test data and build output are the user's own tree, and may hold documentation");
  assert.deepEqual(skipped.sort(), ["node_modules", "vendor/node_modules"],
    "a dependency tree is skipped at any depth - and named, because it is still in the repository");

  // `.git` and the root `.keeldocs` are not repository content: an export of the
  // same tree has no `.git`, and `.keeldocs` is created by the run itself, so
  // naming it would make the report depend on whether the tool had run before.
  assert.ok(!skipped.some((s) => s === ".git" || s === ".keeldocs"),
    "silence here is deliberate - see docSkip");
});


// ---------------------------------------------------------------------------
// D7: view construction memoises directory creation. The only thing that may
// change is how many syscalls it takes - never what ends up inside the view,
// because what is inside the view IS what the provider can read.

test("memoised directory creation builds the identical view", (t) => {
  const root = tmpRepo(t, {
    "a/b/c/one.ts": "1", "a/b/c/two.ts": "2", "a/b/three.ts": "3",
    "a/four.ts": "4", "five.ts": "5", "deep/x/y/z/six.ts": "6",
  });
  const view = join(root, ".view");
  const { files } = resolveInputs(root, ["**/*.ts"], repoFiles(root));
  buildView(root, view, { files, dirs: [], links: [] });
  // every declared file present, at its own path, with its own content
  for (const rel of files) {
    assert.equal(readFileSync(join(view, rel), "utf8"), readFileSync(join(root, rel), "utf8"),
      `${rel} missing or wrong in the view`);
  }
  // and nothing else: a memo that skipped a mkdir would show up as a gap here
  const inView = repoFiles(view).sort();
  assert.deepEqual(inView, [...files].sort(),
    "the view contains exactly the declared set - no more, no fewer");
});

test("a view is still built correctly when every file shares one parent", (t) => {
  const root = tmpRepo(t, { "src/a.ts": "a", "src/b.ts": "b", "src/c.ts": "c" });
  const view = join(root, ".view");
  const { files } = resolveInputs(root, ["src/*.ts"], repoFiles(root));
  buildView(root, view, { files, dirs: [], links: [] });
  assert.deepEqual(repoFiles(view).sort(), ["src/a.ts", "src/b.ts", "src/c.ts"],
    "the shared parent is created once and still holds all three");
});
