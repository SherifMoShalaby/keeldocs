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
  ),
  -- Routines. `signature` is the IDENTITY argument list (types only, the
  -- spelling ALTER/DROP need) so overloads stay distinct facts; `arguments`
  -- is the documentation spelling (names + defaults), which is also exactly
  -- the parameter set a PostgREST rpc call takes. body_digest is a CHANGE
  -- DETECTOR over the stored source, not a signature: it exists so that a
  -- rewritten function body stales the prose describing what it does.
  'functions', (
    select coalesce(json_agg(f order by f->>'name', f->>'signature'), '[]'::json) from (
      select json_build_object(
        'schema', n.nspname,
        'function', p.proname,
        'name', n.nspname || '.' || p.proname,
        'signature', pg_get_function_identity_arguments(p.oid),
        'arguments', pg_get_function_arguments(p.oid),
        'returns', pg_get_function_result(p.oid),
        'kind', case p.prokind when 'p' then 'procedure' else 'function' end,
        'set_returning', p.proretset,
        'volatility', case p.provolatile when 'i' then 'immutable'
                                         when 's' then 'stable' else 'volatile' end,
        'language', l.lanname,
        'security_definer', p.prosecdef,
        'body_digest', substr(md5(coalesce(p.prosrc, '')), 1, 12)
      ) as f
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where p.prokind in ('f', 'p')
        and n.nspname not in ('pg_catalog', 'information_schema', 'auth', 'storage', 'cron', 'extensions')
    ) sub
  ),
  -- Primary keys are a SEPARATE fact, not a table attribute: adding them to
  -- the table payload would change every table's hash on upgrade and stale
  -- every ERD in existence. The same shape `rls` already uses - an attribute
  -- OF a table rather than a surface of its own. PostgREST needs them because
  -- PUT is single-row upsert and only exists for a keyed relation.
  'primary_keys', (
    select coalesce(json_agg(p order by p->>'table'), '[]'::json) from (
      select json_build_object(
        'table', tc.table_schema || '.' || tc.table_name,
        'constraint', tc.constraint_name,
        'columns', (select json_agg(k.column_name order by k.ordinal_position)
                    from information_schema.key_column_usage k
                    where k.constraint_name = tc.constraint_name
                      and k.constraint_schema = tc.constraint_schema)
      ) as p
      from information_schema.table_constraints tc
      where tc.constraint_type = 'PRIMARY KEY'
        and tc.table_schema not in ('pg_catalog', 'information_schema', 'auth', 'storage', 'cron', 'extensions')
    ) sub
  ),
  -- Views and materialized views. Column types use pg_type.typname, the same
  -- spelling `udt_name` gives the table columns, so one ERD never shows two
  -- vocabularies. WRITABILITY is read from the catalog rather than assumed:
  -- PostgREST exposes write verbs on a view only when the view is
  -- auto-updatable or carries INSTEAD OF triggers, and a materialized view is
  -- never writable through it.
  'views', (
    select coalesce(json_agg(v order by v->>'name'), '[]'::json) from (
      select json_build_object(
        'schema', n.nspname,
        'view', c.relname,
        'name', n.nspname || '.' || c.relname,
        'materialized', c.relkind = 'm',
        'columns', (
          select coalesce(json_agg(json_build_object(
            'name', a.attname,
            'type', t.typname,
            'nullable', not a.attnotnull
          ) order by a.attnum), '[]'::json)
          from pg_attribute a join pg_type t on t.oid = a.atttypid
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        ),
        'insertable', coalesce((select iv.is_insertable_into = 'YES' or iv.is_trigger_insertable_into = 'YES'
                                from information_schema.views iv
                                where iv.table_schema = n.nspname and iv.table_name = c.relname), false),
        'updatable', coalesce((select iv.is_updatable = 'YES' or iv.is_trigger_updatable = 'YES'
                               from information_schema.views iv
                               where iv.table_schema = n.nspname and iv.table_name = c.relname), false),
        'deletable', coalesce((select iv.is_updatable = 'YES' or iv.is_trigger_deletable = 'YES'
                               from information_schema.views iv
                               where iv.table_schema = n.nspname and iv.table_name = c.relname), false)
      ) as v
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('v', 'm')
        and n.nspname not in ('pg_catalog', 'information_schema', 'auth', 'storage', 'cron', 'extensions')
    ) sub
  )
) as result;
