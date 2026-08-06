alter table public.daily_items
  add column weekly_target smallint
  check (weekly_target between 1 and 7);

create table public.quick_links (
  user_id uuid not null references auth.users(id) on delete cascade,
  slot smallint not null check (slot between 1 and 4),
  label text not null check (char_length(trim(label)) between 1 and 32),
  url text not null check (url ~ '^https?://'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, slot)
);

alter table public.quick_links enable row level security;

revoke all on public.quick_links from anon, authenticated;
grant select, insert, update, delete on public.quick_links to authenticated;

create policy "quick_links_select_own"
  on public.quick_links for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "quick_links_insert_own"
  on public.quick_links for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "quick_links_update_own"
  on public.quick_links for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "quick_links_delete_own"
  on public.quick_links for delete to authenticated
  using ((select auth.uid()) = user_id);

alter table public.quick_links replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'quick_links'
  ) then
    alter publication supabase_realtime add table public.quick_links;
  end if;
end;
$$;
