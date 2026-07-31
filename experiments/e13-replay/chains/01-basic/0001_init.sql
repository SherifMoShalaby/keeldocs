create table users (
  id serial primary key,
  email text not null unique,
  created_at timestamptz not null default now()
);
create table posts (
  id serial primary key,
  author_id integer not null references users(id) on delete cascade,
  title varchar(200) not null,
  body text
);
