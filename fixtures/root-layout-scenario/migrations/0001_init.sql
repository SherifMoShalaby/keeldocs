create table public.orders (
  id       bigserial primary key,
  owner_id uuid not null
);

alter table public.orders enable row level security;

create policy "orders_owner_read" on public.orders
  for select to authenticated
  using (owner_id = auth.uid());
