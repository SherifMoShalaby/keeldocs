#!/bin/bash
# Resolve 13 monthly snapshot SHAs, extract facts at each, compute rename maps.
set -u
BASE=/home/user/undrift-validation/e23
DATES="2025-08-01 2025-09-01 2025-10-01 2025-11-01 2025-12-01 2026-01-01 2026-02-01 2026-03-01 2026-04-01 2026-05-01 2026-06-01 2026-07-01 2026-07-30"

for REPO in hono zod; do
  R=$BASE/repos/$REPO
  OUT=$BASE/snapshots/$REPO
  mkdir -p "$OUT"
  : > "$OUT/shas.txt"
  PREV=""
  for D in $DATES; do
    SHA=$(git -C "$R" rev-list -1 --before="${D}T00:00:00Z" origin/main)
    echo "$D $SHA" >> "$OUT/shas.txt"
    git -C "$R" checkout -q -f "$SHA" 2>/dev/null
    python3 $BASE/scripts/extract.py "$R" "$OUT/$D.json"
    if [ -n "$PREV" ]; then
      git -C "$R" diff -M60% --name-status "$PREV" "$SHA" > "$OUT/renames_${PREV:0:8}_${SHA:0:8}.txt" 2>/dev/null
      echo "$PREV $SHA renames_${PREV:0:8}_${SHA:0:8}.txt" >> "$OUT/rename_index.txt"
    fi
    PREV=$SHA
  done
done
