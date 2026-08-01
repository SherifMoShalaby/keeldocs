#!/usr/bin/env python3
"""Angular Routes extractor (client-routes)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "_runtime"))
from objroutes import scan  # noqa: E402

if __name__ == "__main__":
    scan(sys.argv[1], anchors={"routes", "ROUTES", "appRoutes"},
         marker_bytes=[b"Routes", b"RouterModule", b"provideRouter"])
