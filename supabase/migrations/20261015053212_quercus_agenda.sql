create table public.quercus_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  canvas_user_id text not null,
  canvas_name text not null,
  token_encrypted text not null,
  connection_id uuid not null default gen_random_uuid(),
  last_synced_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.quercus_completions (
  user_id uuid not null references auth.users(id) on delete cascade,
  canvas_user_id text not null,
  assignment_id text not null,
  completed_at timestamptz not null default now(),
  primary key (user_id, canvas_user_id, assignment_id)
);
alter table public.quercus_connections enable row level security;
alter table public.quercus_completions enable row level security;
revoke all on public.quercus_connections from anon, authenticated;
revoke all on public.quercus_completions from anon, authenticated;
grant select, insert, update, delete on public.quercus_connections to authenticated;
grant select, insert, update, delete on public.quercus_completions to authenticated;
create policy quercus_connections_select on public.quercus_connections for select to authenticated using ((select auth.uid()) = user_id);
create policy quercus_connections_insert on public.quercus_connections for insert to authenticated with check ((select auth.uid()) = user_id);
create policy quercus_connections_update on public.quercus_connections for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy quercus_connections_delete on public.quercus_connections for delete to authenticated using ((select auth.uid()) = user_id);
create policy quercus_completions_select on public.quercus_completions for select to authenticated using ((select auth.uid()) = user_id);
create policy quercus_completions_insert on public.quercus_completions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy quercus_completions_update on public.quercus_completions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy quercus_completions_delete on public.quercus_completions for delete to authenticated using ((select auth.uid()) = user_id);
