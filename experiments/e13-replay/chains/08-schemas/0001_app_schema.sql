create schema app;
create table app.settings (key text primary key, value text not null);
create table public.flags (name text primary key, enabled boolean not null default false);
