-- The E9-learned supabase reality, synthetically: bundled extensions load for
-- real, unavailable ones are shape-stubbed, and platform schemas exist.
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm     WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS postgis     WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS moddatetime WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;

create table pickup_points (
  id uuid primary key default gen_random_uuid(),
  owner uuid references auth.users(id),
  label text not null,
  geog geography(POINT, 4326),
  updated_at timestamptz not null default now()
);

create index pickup_points_geog_idx on pickup_points using gist (geog);
create index pickup_points_label_trgm on pickup_points using gin (label extensions.gin_trgm_ops);

create trigger pickup_points_touch
  before update on pickup_points
  for each row execute function extensions.moddatetime('updated_at');

select cron.schedule('kd-fixture-job', '*/5 * * * *', 'select 1');

alter table pickup_points enable row level security;
create policy pickup_owner_rw on pickup_points for all to authenticated
  using (owner = auth.uid());
create policy avatar_read on storage.objects for select to authenticated
  using (bucket_id = 'avatars');
