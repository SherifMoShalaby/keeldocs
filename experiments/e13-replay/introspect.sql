-- Shared introspection: identical SQL against pglite and real Postgres.
-- Deterministic ordering everywhere; udt_name as the canonical type spelling.
select json_build_object(
  'tables', (
    select coalesce(json_agg(t order by t->>'name'), '[]'::json) from (
      select json_build_object(
        'schema', c.table_schema,
        'table', c.table_name,
        'name', c.table_schema || '.' || c.table_name,
        'columns', (
          select json_agg(json_build_object(
            'name', col.column_name,
            'type', coalesce(col.domain_name, col.udt_name),
            'nullable', col.is_nullable = 'YES',
            'default', col.column_default
          ) order by col.ordinal_position)
          from information_schema.columns col
          where col.table_schema = c.table_schema and col.table_name = c.table_name
        ),
        'relations', (
          select coalesce(json_agg(json_build_object(
            'field', fk.cols,
            'target', fk.ftable
          ) order by fk.cols, fk.ftable), '[]'::json)
          from (
            select tc.constraint_name,
                   string_agg(kcu.column_name, ',' order by kcu.ordinal_position) as cols,
                   min(ccu.table_schema || '.' || ccu.table_name) as ftable
            from information_schema.table_constraints tc
            join information_schema.key_column_usage kcu
              on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
            join information_schema.constraint_column_usage ccu
              on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
            where tc.constraint_type = 'FOREIGN KEY'
              and tc.table_schema = c.table_schema and tc.table_name = c.table_name
            group by tc.constraint_name
          ) fk
        )
      ) as t
      from information_schema.tables c
      where c.table_type = 'BASE TABLE'
        and c.table_schema not in ('pg_catalog', 'information_schema', 'auth', 'storage', 'cron', 'extensions')
    ) sub
  ),
  'enums', (
    select coalesce(json_agg(e order by e->>'name'), '[]'::json) from (
      select json_build_object(
        'name', n.nspname || '.' || t.typname,
        'values', (select json_agg(en.enumlabel order by en.enumsortorder)
                   from pg_enum en where en.enumtypid = t.oid)
      ) as e
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typtype = 'e' and n.nspname not in ('pg_catalog', 'information_schema', 'auth', 'storage', 'cron', 'extensions')
    ) sub
  )
) as result;
