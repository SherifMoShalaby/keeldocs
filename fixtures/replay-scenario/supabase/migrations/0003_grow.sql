alter type order_status add value 'shipped';
alter table orders add column user_id integer references users(id);
