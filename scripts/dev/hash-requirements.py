#!/usr/bin/env python3
"""Regenerate providers/requirements.txt hash pins from PyPI.

Reads the `name==version` pins already in the file, fetches every published
sha256 for each version, and rewrites the --hash lines. Listing EVERY file's
hash (not just this machine's wheel) is deliberate: CI runs three operating
systems, and a hash set that only covers the generating machine breaks the
other two with an unhelpful error.

Never hand-edit a hash. Run this, review the diff, commit.
"""
import json, re, sys, urllib.request

REQ = "providers/requirements.txt"

def main():
    src = open(REQ, encoding="utf-8").read()
    header = src.split("\n\n", 1)[0] if src.startswith("#") else ""
    pins = re.findall(r"^([A-Za-z0-9._-]+)==([0-9][^\s#\\]*)", src, re.M)
    if not pins:
        sys.exit(f"no pins found in {REQ}")
    blocks = []
    for name, ver in pins:
        url = f"https://pypi.org/pypi/{name}/{ver}/json"
        d = json.load(urllib.request.urlopen(url, timeout=60))
        hashes = sorted({f["digests"]["sha256"] for f in d["urls"]})
        if not hashes:
            sys.exit(f"{name}=={ver}: PyPI lists no files")
        body = f"{name}=={ver}"
        for h in hashes:
            body += f" \\\n    --hash=sha256:{h}"
        blocks.append(body)
        print(f"  {name}=={ver}: {len(hashes)} hashes", file=sys.stderr)
    open(REQ, "w", encoding="utf-8", newline="\n").write(header + "\n\n" + "\n".join(blocks) + "\n")
    print(f"wrote {REQ}", file=sys.stderr)

if __name__ == "__main__":
    main()
