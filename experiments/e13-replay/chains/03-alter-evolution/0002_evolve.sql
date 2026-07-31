alter table items add column price numeric(10,2) not null default 0;
alter table items alter column name set not null;
alter table items rename column qty to quantity;
alter table items drop column price;
alter table items add column note varchar(80);
