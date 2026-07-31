#!/bin/bash
set -e
dir="$1"; db="spike_$(basename "$dir" | tr -c 'a-z0-9\n' '_')"
psql -h /tmp/pgsock -U postgres -qc "drop database if exists $db" postgres
psql -h /tmp/pgsock -U postgres -qc "create database $db" postgres
for f in $(ls "$dir"/*.sql | sort); do
  psql -h /tmp/pgsock -U postgres -q -v ON_ERROR_STOP=1 -f "$f" "$db" > /dev/null
done
psql -h /tmp/pgsock -U postgres -qtA -f /tmp/pglite-spike/introspect.sql "$db"
