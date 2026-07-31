create table events (
  id bigint generated always as identity primary key,
  kind text not null default 'generic',
  at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);
