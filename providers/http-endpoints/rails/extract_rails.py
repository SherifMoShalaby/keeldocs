#!/usr/bin/env python3
"""Rails routes.rb extractor (breadth batch).

The routing DSL is constrained enough for a deterministic block-stack parse:
  resources :orders [only:/except:]  -> the RESTful seven, filtered
  resource  :profile                 -> the singular six (no index, no :id)
  get/post/put/patch/delete "p" ...  -> one route
  namespace :admin do ... end        -> /admin prefix (also a module scope)
  scope "/x" do ... end              -> /x prefix
  root "c#a"                         -> GET /
Unrecognized DSL lines carrying route-ish keywords emit named gaps.
Deterministic: single pass, sorted emission.
"""
import json, os, re, sys

VERBS = {"get": "GET", "post": "POST", "put": "PUT", "patch": "PATCH", "delete": "DELETE"}
SEVEN = [("GET", ""), ("GET", "/new"), ("POST", ""), ("GET", "/:id"),
         ("GET", "/:id/edit"), ("PATCH", "/:id"), ("PUT", "/:id"), ("DELETE", "/:id")]
ACTION = {("GET", ""): "index", ("GET", "/new"): "new", ("POST", ""): "create",
          ("GET", "/:id"): "show", ("GET", "/:id/edit"): "edit",
          ("PATCH", "/:id"): "update", ("PUT", "/:id"): "update", ("DELETE", "/:id"): "destroy"}
SINGULAR = [("GET", "/new"), ("POST", ""), ("GET", ""), ("GET", "/edit"), ("PATCH", ""), ("PUT", ""), ("DELETE", "")]
SING_ACTION = {("GET", "/new"): "new", ("POST", ""): "create", ("GET", ""): "show",
               ("GET", "/edit"): "edit", ("PATCH", ""): "update", ("PUT", ""): "update", ("DELETE", ""): "destroy"}


def only_except(rest):
    only = re.search(r"only:\s*(?:%i\[([^\]]*)\]|\[([^\]]*)\])", rest)
    exc = re.search(r"except:\s*(?:%i\[([^\]]*)\]|\[([^\]]*)\])", rest)
    def names(m):
        if not m:
            return None
        body = next(g for g in m.groups() if g is not None)
        return {t.strip().lstrip(":") for t in re.split(r"[,\s]+", body) if t.strip()}
    return names(only), names(exc)


def main(root, detected=None):
    # argv[2], when the engine supplies it, is the `config/routes.rb` DETECTION
    # proved - which is not necessarily the one at the repository root. A Rails
    # API under `apps/api/` was found by detection, the provider ran, and this
    # function then looked for `<root>/config/routes.rb`, found nothing, and
    # printed an empty result with no warning: `http-endpoints` reported
    # `status: ok` over zero endpoints. Optional, so a direct invocation (the
    # fixture harness) keeps the root-relative behaviour and its golden.
    p = os.path.join(root, "config", "routes.rb") if not detected \
        else (detected if os.path.isabs(detected) else os.path.join(root, detected))
    rel = os.path.relpath(p, root).replace(os.sep, "/")
    endpoints, warns = [], []
    if not os.path.exists(p):
        # Being handed a path that is not there is a fact about the tree, not a
        # reason to answer "no endpoints" as though that had been measured.
        warns.append({"file": rel, "reason": "routes file not found"})
    if os.path.exists(p):
        stack = []  # (kind, prefix_segment) ; kind in {ns, scope, resources, plain}
        for i, raw in enumerate(open(p, encoding="utf-8", errors="replace")):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            prefix = "".join(seg for _k, seg in stack)
            m = re.match(r"^(namespace|scope)\s+[:\"']([\w\/-]+)[\"']?(.*)\bdo\b", line)
            if m:
                stack.append((m.group(1), "/" + m.group(2).strip("/")))
                continue
            m = re.match(r"^(resources|resource)\s+:(\w+)(.*)$", line)
            if m:
                kind, name, rest = m.group(1), m.group(2), m.group(3)
                only, exc = only_except(rest)
                table, actions = (SEVEN, ACTION) if kind == "resources" else (SINGULAR, SING_ACTION)
                for verb, tail in table:
                    act = actions[(verb, tail)]
                    if only is not None and act not in only:
                        continue
                    if exc is not None and act in exc:
                        continue
                    endpoints.append({"file": rel, "method": verb,
                                      "path": f"{prefix}/{name}{tail}" or "/"})
                if rest.strip().endswith("do"):
                    stack.append(("resources", f"/{name}/:id" if kind == "resources" else f"/{name}"))
                continue
            m = re.match(r"^(get|post|put|patch|delete)\s+[\"']([^\"']+)[\"']", line)
            if m:
                seg = m.group(2)
                full = seg if seg.startswith("/") else f"{prefix}/{seg}"
                endpoints.append({"file": rel, "method": VERBS[m.group(1)],
                                  "path": "/" + "/".join(s for s in full.split("/") if s)})
                continue
            if re.match(r"^root\b", line):
                endpoints.append({"file": rel, "method": "GET", "path": "/"})
                continue
            if line == "end":
                if stack:
                    stack.pop()
                continue
            if re.match(r"^\w+\s+do\b|^concern\b|^member\b|^collection\b|^match\b|^mount\b|^draw\b", line):
                warns.append({"file": rel, "reason": f"unrecognized routing DSL: {line[:40]}"})
                if line.endswith(" do") or line.endswith("do"):
                    stack.append(("plain", ""))
    endpoints.sort(key=lambda e: (e["file"], e["method"], e["path"]))
    warns.sort(key=lambda w: (w["file"], w["reason"]))
    # dedupe (PATCH+PUT share update when filtered oddly)
    seen, uniq = set(), []
    for e in endpoints:
        k = (e["method"], e["path"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(e)
    print(json.dumps({"endpoints": uniq, "warnings": warns}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
