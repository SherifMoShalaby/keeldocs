create table notes (id serial primary key, owner text not null, body text);
alter table notes enable row level security;
create policy notes_owner_rw on notes for all to public using (owner = current_user);
