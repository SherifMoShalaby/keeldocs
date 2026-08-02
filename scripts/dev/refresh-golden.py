#!/usr/bin/env python3
"""Regenerate a fixture golden, PRETTY-PRINTED.

Why this exists (D8). A committed golden is a review artifact: a contributor
adds a fixture, generates its golden, and a reviewer reads the diff to decide
whether the extractor is doing the right thing. That is the whole contribution
funnel - one query, one manifest, one fixture, no engine code - and it depends
on the golden being readable.

The wire format is a different thing with a different job. `ts-imports` emits
compact JSON because at 1M LOC pretty-printing its payload costs 1,046 ms of
serialisation and 10.2 MB of transport, for whitespace. Piping that straight
into a golden file would trade a real human need for a machine one that the
golden does not have.

These two do not have to agree, and the harness already knows it: golden
comparison is `canonical()` - json.loads then sort_keys - so formatting is not
part of that contract. Only the DETERMINISM gate compares bytes, and it compares
a provider against itself.

    python3 scripts/dev/refresh-golden.py <fixture> <golden-path> -- <cmd>...

Example:
    python3 scripts/dev/refresh-golden.py fixtures/symbols-scenario \\
        fixtures/symbols-scenario/golden/module-graph.json -- \\
        python3 providers/module-graph/ts-imports/extract_symbols.py
"""
import json
import subprocess
import sys


def main(argv):
    if "--" not in argv:
        print(__doc__)
        return 2
    split = argv.index("--")
    fixture, golden = argv[0], argv[1]
    cmd = argv[split + 1:] + [fixture]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(f"extractor failed (rc={r.returncode}):\n{r.stderr[-2000:]}\n")
        return 1
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"extractor did not emit JSON: {e}\n{r.stdout[:400]}\n")
        return 1
    # `_parsed` is the per-file cache handoff (D4/D6/D9), engine plumbing that
    # the engine strips before facts exist. It must never reach a golden.
    data.pop("_parsed", None)
    with open(golden, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(data, indent=1) + "\n")
    print(f"wrote {golden} ({len(json.dumps(data, indent=1))} bytes, pretty)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
