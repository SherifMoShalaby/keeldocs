-- initial RLS surface
create table orders (id serial primary key, user_id uuid, total int);
create table notes (id serial primary key, body text, owner uuid);

alter table orders enable row level security;
alter table notes enable row level security;

create policy orders_select_own on orders
  for select to authenticated
  using (auth.uid() = user_id);

-- deliberately too-broad; replaced in 0002 (replay must drop it)
create policy notes_all on notes
  for all to authenticated
  using (true);
