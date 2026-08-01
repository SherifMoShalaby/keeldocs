-- The catalog decides which verbs a relation answers, and this file makes every
-- branch of that decision real: an AGGREGATE view is not auto-updatable so it
-- answers GET alone; a MATERIALIZED view is never writable through PostgREST;
-- and a table with NO primary key gets no PUT, because PUT is single-row upsert
-- and needs every key column in the query string.

create view order_totals as
  select status, sum(total) as total from orders group by status;

create materialized view order_stats as
  select status, count(*) as n from orders group by status;

create table event_log (
  at   timestamptz not null default now(),
  note text
);
