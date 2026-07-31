drop table temp_stuff;
drop table sessions;
create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_ref integer,
  expires_at timestamptz
);
