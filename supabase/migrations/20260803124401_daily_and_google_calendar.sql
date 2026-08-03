create table public.daily_items (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  note text not null default '',
  links text[] not null default '{}',
  weekday_mask smallint not null default 127 check (weekday_mask between 1 and 127),
  start_date date,
  end_date date,
  position integer not null default 0 check (position >= 0),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  check (end_date is null or start_date is null or end_date >= start_date)
);

create index daily_items_user_active_position_idx
  on public.daily_items (user_id, archived, position);

create table public.daily_completions (
  daily_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  completion_date date not null,
  completed_at timestamptz not null default now(),
  primary key (daily_id, completion_date),
  foreign key (daily_id, user_id)
    references public.daily_items (id, user_id) on delete cascade
);

create index daily_completions_user_date_idx
  on public.daily_completions (user_id, completion_date desc);

create table public.google_calendar_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_expires_at timestamptz not null,
  calendar_email text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.google_calendar_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_verifier text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index google_calendar_oauth_states_user_idx
  on public.google_calendar_oauth_states (user_id, expires_at desc);

alter table public.daily_items enable row level security;
alter table public.daily_completions enable row level security;
alter table public.google_calendar_connections enable row level security;
alter table public.google_calendar_oauth_states enable row level security;

revoke all on public.daily_items from anon, authenticated;
revoke all on public.daily_completions from anon, authenticated;
revoke all on public.google_calendar_connections from anon, authenticated;
revoke all on public.google_calendar_oauth_states from anon, authenticated;

grant select, insert, update, delete on public.daily_items to authenticated;
grant select, insert, delete on public.daily_completions to authenticated;
grant select, insert, update, delete on public.google_calendar_connections to authenticated;
grant select, insert, delete on public.google_calendar_oauth_states to authenticated;

create policy "daily_items_select_own"
  on public.daily_items for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "daily_items_insert_own"
  on public.daily_items for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "daily_items_update_own"
  on public.daily_items for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "daily_items_delete_own"
  on public.daily_items for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "daily_completions_select_own"
  on public.daily_completions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "daily_completions_insert_own"
  on public.daily_completions for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "daily_completions_delete_own"
  on public.daily_completions for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "google_calendar_connections_select_own"
  on public.google_calendar_connections for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "google_calendar_connections_insert_own"
  on public.google_calendar_connections for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "google_calendar_connections_update_own"
  on public.google_calendar_connections for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "google_calendar_connections_delete_own"
  on public.google_calendar_connections for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "google_calendar_oauth_states_select_own"
  on public.google_calendar_oauth_states for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "google_calendar_oauth_states_insert_own"
  on public.google_calendar_oauth_states for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "google_calendar_oauth_states_delete_own"
  on public.google_calendar_oauth_states for delete to authenticated
  using ((select auth.uid()) = user_id);

alter table public.daily_items replica identity full;
alter table public.daily_completions replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'daily_items'
  ) then
    alter publication supabase_realtime add table public.daily_items;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'daily_completions'
  ) then
    alter publication supabase_realtime add table public.daily_completions;
  end if;
end;
$$;
