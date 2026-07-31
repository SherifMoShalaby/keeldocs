create type order_status as enum ('pending', 'paid');
create table orders (
  id bigserial primary key,
  status order_status not null default 'pending',
  total numeric(12,2) not null
);
