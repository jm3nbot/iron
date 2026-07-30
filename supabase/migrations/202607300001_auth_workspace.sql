create extension if not exists citext with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username extensions.citext not null unique
    check (username::text ~ '^[A-Za-z0-9_]{3,24}$'),
  email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_items (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  section text not null check (section in ('now', 'projects', 'library')),
  group_name text not null default '',
  url text,
  links text[] not null default '{}',
  note text not null default '',
  parent_id text references public.workspace_items(id) on delete set null,
  priority text not null default 'none'
    check (priority in ('none', 'high', 'medium', 'low')),
  due_date date,
  completed boolean not null default false,
  archived boolean not null default false,
  archived_at timestamptz,
  position integer not null default 0 check (position >= 0),
  indent integer not null default 0 check (indent between 0 and 3),
  bold boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workspace_items_user_location_idx
  on public.workspace_items (user_id, section, group_name, archived, position);
create index workspace_items_user_updated_idx
  on public.workspace_items (user_id, updated_at desc);
create index workspace_items_parent_idx
  on public.workspace_items (parent_id)
  where parent_id is not null;

alter table public.profiles enable row level security;
alter table public.workspace_items enable row level security;

revoke all on public.profiles from anon, authenticated;
revoke all on public.workspace_items from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (username, updated_at) on public.profiles to authenticated;
grant select, insert, update, delete on public.workspace_items to authenticated;

create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy "workspace_select_own"
  on public.workspace_items for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "workspace_insert_own"
  on public.workspace_items for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "workspace_update_own"
  on public.workspace_items for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "workspace_delete_own"
  on public.workspace_items for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create table private.pending_workspace_imports (
  email text primary key,
  items jsonb not null,
  created_at timestamptz not null default now()
);

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text := nullif(trim(new.raw_user_meta_data ->> 'username'), '');
  pending_items jsonb;
begin
  if requested_username is null
    or requested_username !~ '^[A-Za-z0-9_]{3,24}$' then
    raise exception 'Username must be 3–24 letters, numbers, or underscores.';
  end if;

  insert into public.profiles (id, username, email)
  values (new.id, requested_username, lower(new.email));

  select items into pending_items
  from private.pending_workspace_imports
  where email = lower(new.email);

  if pending_items is not null then
    insert into public.workspace_items (
      id, user_id, content, section, group_name, url, links, note, parent_id,
      priority, due_date, completed, archived, archived_at, position, indent,
      bold, created_at, updated_at
    )
    select
      item ->> 'id',
      new.id,
      item ->> 'content',
      item ->> 'section',
      coalesce(item ->> 'groupName', ''),
      nullif(item ->> 'url', ''),
      coalesce(
        array(select jsonb_array_elements_text(coalesce(item -> 'links', '[]'::jsonb))),
        '{}'::text[]
      ),
      coalesce(item ->> 'note', ''),
      nullif(item ->> 'parentId', ''),
      coalesce(item ->> 'priority', 'none'),
      nullif(item ->> 'dueDate', '')::date,
      coalesce((item ->> 'completed')::boolean, false),
      coalesce((item ->> 'archived')::boolean, false),
      nullif(item ->> 'archivedAt', '')::timestamptz,
      coalesce((item ->> 'position')::integer, 0),
      coalesce((item ->> 'indent')::integer, 0),
      coalesce((item ->> 'bold')::boolean, false),
      coalesce(nullif(item ->> 'createdAt', '')::timestamptz, now()),
      coalesce(nullif(item ->> 'updatedAt', '')::timestamptz, now())
    from jsonb_array_elements(pending_items) as item;

    delete from private.pending_workspace_imports
    where email = lower(new.email);
  end if;

  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure private.handle_new_user();

alter table public.workspace_items replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'workspace_items'
  ) then
    alter publication supabase_realtime add table public.workspace_items;
  end if;
end;
$$;
