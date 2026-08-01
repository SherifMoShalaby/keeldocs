#!/usr/bin/env python3
"""vue-router route-record extractor (client-routes)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "_runtime"))
from objroutes import scan  # noqa: E402

if __name__ == "__main__":
    scan(sys.argv[1], anchors={"routes"},
         marker_bytes=[b"vue-router", b"createRouter", b"RouteRecordRaw"])
