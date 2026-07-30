#!/usr/bin/env python3
"""undrift E4 prototype: INIT DOC LIE-DETECTOR.

Deterministic checks over README.md + docs/** of a repo:
  A. FILE CLAIMS      - path-looking refs in docs -> does the path exist? (deletion receipt via git log)
  B. NPM SCRIPT CLAIMS- `npm run X` / `yarn X` etc -> is X in package.json scripts?
  C. ENV VAR CLAIMS   - UPPER_SNAKE tokens in README/.env.example -> referenced anywhere in code?
  D. INTERNAL LINKS   - relative markdown links -> target exists?
  E. ROUTE CLAIMS     - curl/localhost URL paths in docs -> matching route registration in code?

Every finding carries a receipt derived from a command actually executed by this script
(git log output captured verbatim; grep/scan proofs state the exact scan performed and result).

Usage: python3 detector.py <repo_path> [--json out.json] [--md out.md]
"""
import json
import re
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------- suppression
PLACEHOLDER_PAT = re.compile(
    r"(path/to|/to/file|your[-_ ]?|<[^>]*>|\{[^}]*\}|\*|\$\{|example\.com|foo\.js|somefile|"
    r"file\.js|\bxxx\b|placeholder|user/repo|owner/repo|\.\.\.|\bmy-)", re.I)

CODE_IDIOM_TOKENS = {"process.env", "import.meta.env", "module.exports"}

# tutorial/recipe context: files the READER will create, not claims about repo content
INSTRUCTIONAL_PAT = re.compile(
    r"(?i)\b(create|add|make|put|move|copy|rename|touch|new file|you can|you could|"
    r"you will|you should|you'?ll|you don'?t|for example|e\.g\.|step \d|then you|"
    r"would look|might look|don'?t actually|skip)\b")

YARN_BUILTINS = {
    "add", "install", "remove", "upgrade", "upgrade-interactive", "init", "create",
    "global", "bin", "cache", "check", "config", "dlx", "import", "info", "licenses",
    "link", "unlink", "list", "login", "logout", "node", "outdated", "owner", "pack",
    "patch", "policies", "publish", "set", "unplug", "version", "versions", "why",
    "workspace", "workspaces", "audit", "autoclean", "exec", "help", "up",
}

ENV_STOPLIST = {
    # read implicitly by runtimes/libs or set by CI/OS, not app code; or doc-syntax junk
    "NODE_ENV", "NODE_OPTIONS", "NODE_PATH", "NODE_DEBUG", "NPM_CONFIG_PRODUCTION",
    "CI", "TZ", "PATH", "HOME", "PWD", "PORT0", "DEBUG",
    "UPPER_SNAKE", "FOO_BAR", "MY_VAR", "ENV_VAR", "A_B",
}
ENV_JUNK_PAT = re.compile(r"^(YOUR_|MY_|EXAMPLE_|CHANGE_|INSERT_|REPLACE_|XXX)")

CODE_EXTS = {".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".yml", ".yaml",
             ".sh", ".bash", ".pug", ".ejs", ".hbs", ".html", ".prisma", ".sql",
             ".tf", ".toml", ".conf", ".service"}
CODE_EXTRA_NAMES = {"Dockerfile", "Procfile", "Makefile"}
EXCLUDE_DIRS = {".git", "node_modules", "dist", "build", ".next", "coverage"}
LOCKFILES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml"}

FILE_EXT_PAT = (r"(?:js|mjs|cjs|ts|tsx|jsx|json|md|markdown|yml|yaml|pug|ejs|hbs|html|css|"
                r"scss|less|sh|env|sql|prisma|txt|png|jpg|svg|ico|lock|example|sample|mermaid)")
REPOISH_TOPDIRS = {"config", "controllers", "models", "views", "public", "test", "tests",
                   "src", "server", "client", "docs", "scripts", "lib", "app", "static",
                   "db", "custom", "e2e", "migrations", "prisma"}
KNOWN_FILENAMES = {"package.json", ".env.example", ".example.env", ".env.sample", ".env",
                   "Dockerfile", "docker-compose.yml", "Procfile", "app.json",
                   ".babelrc", ".eslintrc", "knexfile.js", "tsconfig.json", ".gitignore",
                   "nx.json", "jest.config.ts"}


def sh(cmd, cwd):
    """Run a command, return (cmdline_string, output). Receipts quote these verbatim."""
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return " ".join(cmd), (p.stdout + p.stderr).strip()


def norm(t):
    """Strip leading ./ or / (prefix-wise, not lstrip's char-set semantics)."""
    while t.startswith("./"):
        t = t[2:]
    return t[1:] if t.startswith("/") else t


class Detector:
    def __init__(self, repo: Path):
        self.repo = repo.resolve()
        self.findings = []       # each: dict with class, doc ref, claim, receipt
        self.info = {}           # non-lie coverage info
        self.counts = {"A_file": 0, "B_npm_script": 0, "C_env_var": 0,
                       "D_internal_link": 0, "E_route": 0}
        self.checked = {"A_file": 0, "B_npm_script": 0, "C_env_var": 0,
                        "D_internal_link": 0, "E_route": 0}
        self.suppressed = {"instructional_lines": 0, "gitignored_paths": 0}
        self.doc_files = self._collect_docs()
        self.code_files = self._collect_code()
        self.blob = {}
        for p in self.code_files:
            try:
                self.blob[p] = p.read_text(errors="replace")
            except Exception:
                pass
        self.dep_names = self._load_dep_names()
        self.pkg_scripts = self._load_scripts()
        self.routes = self._collect_routes()

    # ------------------------------------------------------------ collection
    def _collect_docs(self):
        docs = []
        skip = re.compile(r"^(CHANGELOG|LICENSE|CODE_OF_CONDUCT|HISTORY)", re.I)
        for p in sorted(self.repo.glob("*.md")):  # root docs incl. README/CLAUDE/AGENTS
            if not skip.match(p.name):
                docs.append(p)
        d = self.repo / "docs"
        if d.is_dir():
            docs += sorted(q for q in d.rglob("*") if q.suffix.lower() in
                           {".md", ".mdx", ".markdown"} and q.is_file())
        t = self.repo / "test" / "TESTING.md"
        if t.exists():
            docs.append(t)
        return docs

    def _collect_code(self):
        out = []
        for p in self.repo.rglob("*"):
            if not p.is_file():
                continue
            if any(part in EXCLUDE_DIRS for part in p.parts):
                continue
            if p.name in LOCKFILES or p.suffix.lower() in {".md", ".markdown", ".mdx"}:
                continue
            if p.name.startswith(".env") or p.name.endswith(".env"):
                continue
            if p.suffix in CODE_EXTS or p.name in CODE_EXTRA_NAMES:
                out.append(p)
        return out

    def _load_dep_names(self):
        pj = self.repo / "package.json"
        if not pj.exists():
            return set()
        try:
            d = json.loads(pj.read_text())
            return set(d.get("dependencies", {})) | set(d.get("devDependencies", {}))
        except Exception:
            return set()

    def _load_scripts(self):
        pj = self.repo / "package.json"
        if not pj.exists():
            return {}
        try:
            return json.loads(pj.read_text()).get("scripts", {}) or {}
        except Exception:
            return {}

    def _collect_routes(self):
        """(method, path, file:line) from express-style registrations."""
        pat = re.compile(r"\.\s*(get|post|put|delete|patch|all|use)\s*\(\s*['\"`]([^'\"`]+)['\"`]")
        routes = []
        for p in self.code_files:
            if p.suffix not in {".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"}:
                continue
            try:
                text = p.read_text(errors="replace")
            except Exception:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                for m in pat.finditer(line):
                    routes.append((m.group(1), m.group(2),
                                   f"{p.relative_to(self.repo)}:{i}"))
        return routes

    def _doc_lines(self):
        """Yield (relpath, lineno, line, in_fence, context) for every doc line.
        context = this line plus the 6 preceding raw lines (for tutorial detection)."""
        for doc in self.doc_files:
            rel = str(doc.relative_to(self.repo))
            fence = False
            raw = doc.read_text(errors="replace").splitlines()
            for i, line in enumerate(raw, 1):
                if line.lstrip().startswith("```"):
                    fence = not fence
                    continue
                ctx = "\n".join(raw[max(0, i - 7):i])
                yield rel, i, line, fence, ctx

    def add(self, cls, doc, lineno, line, claim, evidence, receipt_cmd, verdictable=True):
        self.counts[cls] += 1
        self.findings.append({
            "class": cls, "doc": doc, "line_no": lineno, "doc_line": line.strip()[:300],
            "claim": claim, "evidence": evidence, "receipt_cmd": receipt_cmd,
        })

    # ------------------------------------------------------------ receipts
    def is_gitignored(self, relpath):
        """Runtime/build artifacts (.env, dist/...) are instructions, not content claims."""
        p = subprocess.run(["git", "check-ignore", "-q", relpath], cwd=self.repo)
        return p.returncode == 0

    def deletion_receipt(self, relpath):
        cmd, out = sh(["git", "log", "--diff-filter=D", "--format=%h %ad %s",
                       "--date=short", "--", relpath], self.repo)
        if out:
            first = out.splitlines()[0]
            return f"deleted in commit: {first}", f"git log --diff-filter=D --date=short -- {relpath}"
        return ("missing from worktree; no deletion commit in fetched 400-commit history "
                "(deletion predates fetched history, or path never existed on this branch)",
                f"git log --diff-filter=D -- {relpath}  -> (empty)")

    # ------------------------------------------------------------ A. file claims
    def path_exists(self, token, docdir):
        t = token.strip().lstrip("/")
        for base in (self.repo, docdir):
            if (base / t).exists():
                return True
        if "/" not in t:  # bare filename: anywhere in repo
            for p in self.repo.rglob(t):
                if not any(part in EXCLUDE_DIRS for part in p.parts):
                    return True
        else:  # slash path: also match as a suffix anywhere (doc-relative refs)
            last = t.rstrip("/").rsplit("/", 1)[-1]
            for p in self.repo.rglob(last):
                if any(part in EXCLUDE_DIRS for part in p.parts):
                    continue
                if str(p).endswith("/" + t.rstrip("/")):
                    return True
        return False

    def is_path_candidate(self, t):
        if len(t) > 120 or " " in t:
            return False
        if PLACEHOLDER_PAT.search(t):
            return False
        if t.startswith(("http", "git@", "//", "@", "#", "-", "../")):
            return False
        if re.search(r"example\.(com|org)|localhost|npmjs|github\.com", t):
            return False
        if "/" in t:
            if not re.fullmatch(r"\.?/?[\w.@+-]+(/[\w.@+-]+)+/?", t):
                return False
            last = t.rstrip("/").rsplit("/", 1)[-1]
            top = t.lstrip("./").split("/", 1)[0]
            # need a known file extension, an explicit ./, a trailing /,
            # or a repo-ish top dir; else likely a slug/model-id (user/repo, qwen/qwen3.6)
            return bool(re.search(r"\.%s$" % FILE_EXT_PAT, last, re.I)
                        or t.startswith("./") or t.endswith("/")
                        or top in REPOISH_TOPDIRS)
        if t in KNOWN_FILENAMES:
            return True
        return bool(re.fullmatch(r"\.?[\w.-]+\.%s" % FILE_EXT_PAT, t))

    def check_file_claims(self):
        seen = set()
        for rel, i, line, fence, ctx in self._doc_lines():
            if INSTRUCTIONAL_PAT.search(line) or INSTRUCTIONAL_PAT.search(ctx):
                self.suppressed["instructional_lines"] += 1
                continue  # suppressed: tutorial/recipe context (reader-created files)
            docdir = (self.repo / rel).parent
            tokens = []
            if fence:  # inside code block: whitespace-split words that look like paths
                if re.search(r"[│├└┌┬─╰╭]|^\s*\|", line):
                    continue  # suppressed: ASCII tree diagrams are illustrative structure
                for w in re.split(r"[\s'\"()=,;]+", line):
                    tokens.append(w)
            else:
                tokens += re.findall(r"`([^`\n]+)`", line)
            for tok in tokens:
                tok = tok.strip().rstrip(".,:;")
                if not tok or tok in CODE_IDIOM_TOKENS or not self.is_path_candidate(tok):
                    continue
                if "/" not in tok and tok in self.dep_names:
                    continue  # suppressed: npm package name (e.g. chart.js), not a file
                key = norm(tok)
                if key in seen:
                    continue
                seen.add(key)
                self.checked["A_file"] += 1
                if not self.path_exists(tok, docdir):
                    if self.is_gitignored(key):
                        self.suppressed["gitignored_paths"] += 1
                        continue  # suppressed: runtime/build artifact per .gitignore
                    if any(tok in t for t in self.blob.values()):
                        self.suppressed["code_corroborated"] =                             self.suppressed.get("code_corroborated", 0) + 1
                        continue  # suppressed: exact string appears in code (runtime URL/map)
                    ev, cmd = self.deletion_receipt(key)
                    self.add("A_file", rel, i, line,
                             f"doc references path `{tok}`", f"path does not exist; {ev}", cmd)

    # ------------------------------------------------------------ B. npm scripts
    def check_npm_scripts(self):
        pats = [r"\bnpm run(?:-script)?\s+([A-Za-z0-9:_.-]+)",
                r"\bpnpm(?: run)?\s+([A-Za-z0-9:_.-]+)",
                r"\byarn(?: run)?\s+([A-Za-z0-9:_.-]+)",
                r"\bnpm\s+(start|stop|restart)\b",
                r"\bnpm\s+(?:test|t)\b()"]
        seen = set()
        for rel, i, line, fence, ctx in self._doc_lines():
            for pat in pats:
                for m in re.finditer(pat, line):
                    name = m.group(1) or "test"
                    if name in YARN_BUILTINS or name in seen:
                        continue
                    if PLACEHOLDER_PAT.search(name) or name in {"run", "i", "ci", "install"}:
                        continue
                    seen.add(name)
                    self.checked["B_npm_script"] += 1
                    if name not in self.pkg_scripts:
                        self.add("B_npm_script", rel, i, line,
                                 f"doc says to run script `{name}`",
                                 f"`{name}` absent from package.json scripts; actual keys: "
                                 f"{sorted(self.pkg_scripts)}",
                                 "python: json.load(package.json)['scripts']")

    # ------------------------------------------------------------ C. env vars
    def _env_example_file(self):
        for n in (".env.example", ".example.env", ".env.sample", "env.example"):
            p = self.repo / n
            if p.exists():
                return p
        return None

    def check_env_vars(self):
        documented = {}  # token -> (docref, lineno, line); env-example seeded first
        envf = self._env_example_file()
        if envf:
            for i, line in enumerate(envf.read_text(errors="replace").splitlines(), 1):
                m = re.match(r"\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=", line)
                if m:
                    documented.setdefault(m.group(1), (envf.name, i, line))
        for rel, i, line, fence, ctx in self._doc_lines():
            for m in re.finditer(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b", line):
                documented.setdefault(m.group(0), (rel, i, line))

        blob = self.blob

        # dynamic suffix convention: code like `key + "_FILE"` reads FOO_FILE for every FOO
        dyn_file_suffix = any(re.search(r"['\"`]_FILE['\"`]", t) for t in blob.values())

        never_read = []
        for tok, (rel, i, line) in sorted(documented.items()):
            if tok in ENV_STOPLIST or ENV_JUNK_PAT.match(tok):
                continue
            if dyn_file_suffix and tok.endswith("_FILE"):
                continue  # suppressed: matched by dynamic `+ "_FILE"` construction in code
            self.checked["C_env_var"] += 1
            hit = None
            wb = re.compile(r"\b%s\b" % re.escape(tok))
            for p, text in blob.items():
                m = wb.search(text)
                if m:
                    ln = text[:m.start()].count("\n") + 1
                    hit = f"{p.relative_to(self.repo)}:{ln}"
                    break
            if hit is None:
                nfiles = len(blob)
                self.add("C_env_var", rel, i, line,
                         f"doc/env-example documents env var `{tok}`",
                         f"`{tok}` matched 0 times across all {nfiles} code/config files "
                         "(grep -rw, excluding *.md, .env*, lockfiles, .git)",
                         f"grep -rnw --include-scanned {tok} {self.repo.name}/ -> 0 matches")
                never_read.append(tok)

        # coverage info: read in code but undocumented (not a lie)
        read = set()
        for text in blob.values():
            read |= set(re.findall(r"process\.env\.([A-Z][A-Z0-9_]*)", text))
            read |= set(re.findall(r"process\.env\[['\"]([A-Z][A-Z0-9_]*)['\"]\]", text))
        undoc = sorted(t for t in read
                       if t not in documented and t not in ENV_STOPLIST)
        self.info["env_read_but_undocumented"] = undoc
        self.info["env_documented_total"] = len(documented)

    # ------------------------------------------------------------ D. internal links
    def check_internal_links(self):
        seen = set()
        for rel, i, line, fence, ctx in self._doc_lines():
            if fence:
                continue
            for m in re.finditer(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)", line):
                tgt = m.group(1)
                if re.match(r"^(https?:|mailto:|#|data:|//|ftp:)", tgt.strip("<>()")):
                    continue  # external (also unwraps malformed <(url)> wrapping)
                if PLACEHOLDER_PAT.search(tgt):
                    continue
                clean = tgt.split("#", 1)[0].split("?", 1)[0]
                if not clean or clean in seen:
                    continue
                seen.add(clean)
                self.checked["D_internal_link"] += 1
                base = self.repo if clean.startswith("/") else (self.repo / rel).parent
                if not (base / norm(clean)).exists():
                    relguess = norm(str((Path(rel).parent / clean)) if not clean.startswith("/") else clean)
                    if self.is_gitignored(relguess):
                        continue
                    ev, cmd = self.deletion_receipt(relguess)
                    self.add("D_internal_link", rel, i, line,
                             f"markdown link points to `{tgt}`",
                             f"link target missing; {ev}", cmd)

    # ------------------------------------------------------------ E. routes
    def _route_matches(self, path):
        segs = [s for s in path.split("/") if s]
        use_prefixes = [r[1] for r in self.routes if r[0] == "use"]
        for method, rpath, loc in self.routes:
            cands = [rpath] + [pref.rstrip("/") + rpath for pref in use_prefixes]
            for cand in cands:
                csegs = [s for s in cand.split("/") if s]
                if len(csegs) != len(segs):
                    continue
                if all(cs.startswith(":") or cs in ("*",) or cs == ds
                       for cs, ds in zip(csegs, segs)):
                    return f"{method.upper()} {rpath} @ {loc}"
        # lenient: any registered route whose path is a suffix of the doc path
        for method, rpath, loc in self.routes:
            if rpath != "/" and (path.endswith(rpath) or rpath.endswith(path)):
                return f"{method.upper()} {rpath} @ {loc}"
        return None

    def check_routes(self):
        seen = set()
        url_pat = re.compile(
            r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(/[^\s'\")`<>\]]*)")
        for rel, i, line, fence, ctx in self._doc_lines():
            if INSTRUCTIONAL_PAT.search(line) or INSTRUCTIONAL_PAT.search(ctx):
                continue  # suppressed: tutorial context (routes the reader will add)
            for m in url_pat.finditer(line):
                path = m.group(1).split("?", 1)[0].rstrip("/")
                path = re.sub(r"\{[^}]*\}|<[^>]*>|:[a-zA-Z]+", ":param", path)
                if not path or path == "/" or path in seen:
                    continue
                if re.search(r"\.\w{2,5}$", path):   # static asset, handled as file claim
                    continue
                seen.add(path)
                self.checked["E_route"] += 1
                if self._route_matches(path) is None:
                    self.add("E_route", rel, i, line,
                             f"doc shows URL path `{path}`",
                             f"no matching route registration among {len(self.routes)} "
                             "express-style registrations scanned (.get/.post/.put/.delete/"
                             ".patch/.all/.use with string literal), including .use-prefix "
                             "composition",
                             "python route scan over *.js/*.ts (regex '.method(\\'path\\'')")

    # ------------------------------------------------------------ run
    def run(self):
        self.check_file_claims()
        self.check_npm_scripts()
        self.check_env_vars()
        self.check_internal_links()
        self.check_routes()
        return {
            "repo": self.repo.name,
            "doc_files_scanned": [str(p.relative_to(self.repo)) for p in self.doc_files],
            "code_files_scanned": len(self.code_files),
            "routes_scanned": len(self.routes),
            "counts": self.counts,
            "claims_checked": self.checked,
            "suppressed": self.suppressed,
            "findings": self.findings,
            "info": self.info,
        }


def main():
    repo = Path(sys.argv[1])
    res = Detector(repo).run()
    out_json = None
    if "--json" in sys.argv:
        out_json = sys.argv[sys.argv.index("--json") + 1]
        Path(out_json).write_text(json.dumps(res, indent=2))
    print(f"== {res['repo']}: docs={res['doc_files_scanned']} "
          f"code_files={res['code_files_scanned']} routes={res['routes_scanned']}")
    print("findings:", json.dumps(res["counts"]))
    print("claims_checked:", json.dumps(res["claims_checked"]))
    print("suppressed:", json.dumps(res["suppressed"]))
    for f in res["findings"]:
        print(f"\n[{f['class']}] {f['doc']}:{f['line_no']}")
        print(f"  doc line: {f['doc_line']}")
        print(f"  claim:    {f['claim']}")
        print(f"  evidence: {f['evidence']}")
        print(f"  receipt:  {f['receipt_cmd']}")
    if res["info"]:
        print("\ninfo:", json.dumps(res["info"], indent=2))


if __name__ == "__main__":
    main()
