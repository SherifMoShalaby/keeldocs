-- The PostgREST surface, synthetically: a stable read function (GET+POST rpc),
-- a volatile writer (POST rpc only), an OVERLOAD of that writer (two distinct
-- facts, one path), a trigger function (a real schema object that PostgREST
-- does NOT expose), and a view (an exposed surface this version does not
-- model, so it must surface as a named gap rather than as silence).

create function nearby_pickup_points(p_lat double precision,
                                     p_lng double precision,
                                     p_radius_m double precision default 500)
returns setof pickup_points
language sql
stable
as $$
  select * from pickup_points where p_radius_m > 0 and p_lat is not null and p_lng is not null;
$$;

create function claim_order(p_order_id bigint) returns boolean
language plpgsql
security definer
as $$
begin
  update orders set status = 'paid' where id = p_order_id;
  return found;
end;
$$;

create function claim_order(p_order_id bigint, p_actor uuid) returns boolean
language plpgsql
security definer
as $$
begin
  update orders set status = 'paid' where id = p_order_id and user_id is not null and p_actor is not null;
  return found;
end;
$$;

create function touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create view open_orders as
  select id, total from orders where status = 'pending';
