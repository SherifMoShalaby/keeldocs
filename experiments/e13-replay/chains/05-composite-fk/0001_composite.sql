create table tenants (org_id integer, unit_id integer, name text, primary key (org_id, unit_id));
create table devices (
  id serial primary key,
  org_id integer not null,
  unit_id integer not null,
  foreign key (org_id, unit_id) references tenants (org_id, unit_id)
);
