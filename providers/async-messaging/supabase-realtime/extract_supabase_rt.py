#!/usr/bin/env python3
"""Supabase Realtime channel declarations (async-messaging)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "_runtime"))
from msgscan import emit  # noqa: E402

RULES = [
    ("channel", r"supabase|client|db", "channel", "both", ["pos:0"]),
    ("removeChannel", r"supabase|client", "channel", "both", ["pos:0"]),
]

if __name__ == "__main__":
    emit(sys.argv[1], "supabase-realtime", RULES, exts=(".ts", ".tsx", ".js", ".jsx", ".mjs"))
