-- The derived PostgREST surface, with every decision the provider has to make
-- present exactly once: a plain exposed table, a table whose NAME collides
-- across two exposed schemas (profile header decides, path cannot), a STABLE
-- function (GET and POST rpc), a VOLATILE one (POST only), a trigger function
-- (a real routine PostgREST never exposes) and a procedure (named as a gap).
create schema if not exists api;

create table public.rides (
  id bigserial primary key,
  driver text not null,
  seats int not null default 3
);

create table public.profiles (
  id uuid primary key,
  display_name text
);

-- same relation NAME in a second exposed schema: /rest/v1/rides is ambiguous
create table api.rides (
  id bigserial primary key,
  note text
);

create function public.search_rides(p_origin text, p_max_km numeric default 25)
returns setof public.rides
language sql
stable
as $$
  select * from public.rides where p_origin is not null and p_max_km > 0;
$$;

create function public.claim_ride(p_ride_id bigint) returns boolean
language plpgsql
as $$
begin
  return p_ride_id > 0;
end;
$$;

create function public.touch_row() returns trigger
language plpgsql
as $$
begin
  return new;
end;
$$;

create procedure public.rebuild_stats()
language plpgsql
as $$
begin
  perform 1;
end;
$$;

-- an auto-updatable view (write verbs), an aggregate view (GET only), and a
-- keyless table (no PUT) - the three catalog-decided branches
create view active_rides as select id, driver, seats from public.rides;

create view ride_counts as select driver, count(*) as n from public.rides group by driver;

create table public.ride_events (at timestamptz default now(), note text);
