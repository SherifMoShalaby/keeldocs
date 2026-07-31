-- tighten notes access: drop the broad policy, scope to owner
drop policy notes_all on notes;

create policy notes_owner_rw on notes
  as permissive for all to authenticated
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

create policy notes_admin_read on public.notes
  for select to service_role, admin
  using (true);
