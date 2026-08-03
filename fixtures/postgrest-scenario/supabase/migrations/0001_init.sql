-- The derived PostgREST surface, with every decision the provider has to make
-- present exactly once: a plain exposed table, a table whose NAME collides
-- across two exposed schemas (profile header decides, path cannot), a STABLE
-- function (GET and POST rpc), a VOLATILE one (POST only), a trigger function
-- (a real routine PostgREST never exposes) and a procedure (named as a gap).
create schema if not exists api;

create table public.items (
  id bigserial primary key,
  owner text not null,
  slots int not null default 3
);

create table public.profiles (
  id uuid primary key,
  display_name text
);

-- same relation NAME in a second exposed schema: /rest/v1/items is ambiguous
create table api.items (
  id bigserial primary key,
  note text
);

create function public.search_items(p_query text, p_max_n numeric default 25)
returns setof public.items
language sql
stable
as $$
  select * from public.items where p_query is not null and p_max_n > 0;
$$;

create function public.claim_item(p_item_id bigint) returns boolean
language plpgsql
as $$
begin
  return p_item_id > 0;
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
create view active_items as select id, owner, slots from public.items;

create view item_counts as select owner, count(*) as n from public.items group by owner;

create table public.item_events (at timestamptz default now(), note text);
