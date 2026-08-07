create policy "orders_owner_write" on public.orders
  for insert to authenticated
  with check (owner_id = auth.uid());
