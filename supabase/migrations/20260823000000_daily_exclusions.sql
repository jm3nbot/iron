create table if not exists public.daily_exclusions (
  user_id uuid not null references auth.users(id) on delete cascade,
  exclusion_date date not null,
  reason text not null default '' check (char_length(reason) <= 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, exclusion_date)
);

create index if not exists daily_exclusions_user_date_idx
  on public.daily_exclusions (user_id, exclusion_date desc);

alter table public.daily_exclusions enable row level security;

revoke all on public.daily_exclusions from anon, authenticated;
grant select, insert, update, delete on public.daily_exclusions to authenticated;

drop policy if exists "daily_exclusions_select_own" on public.daily_exclusions;
drop policy if exists "daily_exclusions_insert_own" on public.daily_exclusions;
drop policy if exists "daily_exclusions_update_own" on public.daily_exclusions;
drop policy if exists "daily_exclusions_delete_own" on public.daily_exclusions;

create policy "daily_exclusions_select_own"
  on public.daily_exclusions for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "daily_exclusions_insert_own"
  on public.daily_exclusions for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "daily_exclusions_update_own"
  on public.daily_exclusions for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "daily_exclusions_delete_own"
  on public.daily_exclusions for delete to authenticated
  using ((select auth.uid()) = user_id);

alter table public.daily_exclusions replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'daily_exclusions'
  ) then
    alter publication supabase_realtime add table public.daily_exclusions;
  end if;
end;
$$;
