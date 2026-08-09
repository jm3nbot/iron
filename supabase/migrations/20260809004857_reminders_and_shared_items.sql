create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Profiles double as the authenticated username directory. Keep email private
-- with column-level privileges even though usernames are searchable.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_authenticated"
  on public.profiles for select
  to authenticated
  using (true);

revoke select on public.profiles from authenticated;
grant select (id, username, created_at, updated_at) on public.profiles to authenticated;

alter table public.workspace_items
  add constraint workspace_items_id_user_unique unique (id, user_id);

create table public.workspace_item_members (
  id uuid primary key default gen_random_uuid(),
  item_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  invited_by uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('editor')),
  invite_status text not null default 'pending'
    check (invite_status in ('pending', 'accepted', 'declined')),
  invited_at timestamptz not null default now(),
  responded_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (item_id, owner_id)
    references public.workspace_items (id, user_id) on delete cascade,
  unique (item_id, user_id),
  check (user_id <> invited_by),
  check (owner_id = invited_by)
);

create index workspace_item_members_user_status_idx
  on public.workspace_item_members (user_id, invite_status, invited_at desc);
create index workspace_item_members_item_status_idx
  on public.workspace_item_members (item_id, invite_status);
create index workspace_item_members_inviter_idx
  on public.workspace_item_members (invited_by, invited_at desc);

alter table public.workspace_item_members enable row level security;
revoke all on public.workspace_item_members from anon, authenticated;
grant select, insert, delete on public.workspace_item_members to authenticated;
grant update (invite_status, responded_at, updated_at)
  on public.workspace_item_members to authenticated;

create policy "workspace_members_select_involved"
  on public.workspace_item_members for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or (select auth.uid()) = invited_by
  );

create policy "workspace_members_owner_invite"
  on public.workspace_item_members for insert
  to authenticated
  with check (
    (select auth.uid()) = invited_by
    and owner_id = (select auth.uid())
    and user_id <> (select auth.uid())
  );

create policy "workspace_members_recipient_respond"
  on public.workspace_item_members for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and invite_status in ('accepted', 'declined')
  );

create policy "workspace_members_leave_or_revoke"
  on public.workspace_item_members for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    or (select auth.uid()) = invited_by
  );

-- Accepted collaborators edit one canonical item. Pending recipients may read
-- the item as an invitation preview, but cannot mutate it.
drop policy if exists "workspace_select_own" on public.workspace_items;
create policy "workspace_select_owned_or_shared"
  on public.workspace_items for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or id in (
      select member.item_id
      from public.workspace_item_members member
      where member.user_id = (select auth.uid())
        and member.invite_status in ('pending', 'accepted')
    )
  );

drop policy if exists "workspace_update_own" on public.workspace_items;
create policy "workspace_update_owned_or_shared"
  on public.workspace_items for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    or id in (
      select member.item_id
      from public.workspace_item_members member
      where member.user_id = (select auth.uid())
        and member.invite_status = 'accepted'
    )
  )
  with check (
    (select auth.uid()) = user_id
    or id in (
      select member.item_id
      from public.workspace_item_members member
      where member.user_id = (select auth.uid())
        and member.invite_status = 'accepted'
    )
  );

create or replace function private.protect_workspace_item_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.user_id <> old.user_id then
    raise exception 'Workspace item ownership cannot be transferred.';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_workspace_item_owner() from public, anon, authenticated;

create trigger protect_workspace_item_owner
  before update of user_id on public.workspace_items
  for each row execute function private.protect_workspace_item_owner();

create table public.task_email_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null references public.workspace_items(id) on delete cascade,
  recipient_email text not null,
  start_days_before smallint not null default 3
    check (start_days_before between 0 and 365),
  repeat_every_hours smallint not null default 24
    check (repeat_every_hours between 1 and 720),
  send_time time not null default '09:00',
  timezone text not null default 'UTC',
  next_send_at timestamptz not null,
  last_sent_at timestamptz,
  status text not null default 'active'
    check (status in ('active', 'paused', 'stopped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, item_id)
);

create index task_email_reminders_due_idx
  on public.task_email_reminders (next_send_at)
  where status = 'active';
create index task_email_reminders_item_idx
  on public.task_email_reminders (item_id, user_id);

create table public.task_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references public.task_email_reminders(id) on delete cascade,
  scheduled_for timestamptz not null,
  provider_message_id text,
  status text not null default 'processing'
    check (status in ('processing', 'sent', 'failed')),
  error text,
  attempted_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (reminder_id, scheduled_for)
);

create index task_email_deliveries_reminder_idx
  on public.task_email_deliveries (reminder_id, attempted_at desc);

alter table public.task_email_reminders enable row level security;
alter table public.task_email_deliveries enable row level security;
revoke all on public.task_email_reminders from anon, authenticated;
revoke all on public.task_email_deliveries from anon, authenticated;
grant select, insert, update, delete on public.task_email_reminders to authenticated;
grant select on public.task_email_deliveries to authenticated;

create policy "task_reminders_select_own"
  on public.task_email_reminders for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "task_reminders_insert_accessible"
  on public.task_email_reminders for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.workspace_items item
      where item.id = item_id
        and (
          item.user_id = (select auth.uid())
          or item.id in (
            select member.item_id
            from public.workspace_item_members member
            where member.user_id = (select auth.uid())
              and member.invite_status = 'accepted'
          )
        )
    )
  );

create policy "task_reminders_update_own"
  on public.task_email_reminders for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "task_reminders_delete_own"
  on public.task_email_reminders for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "task_deliveries_select_own"
  on public.task_email_deliveries for select
  to authenticated
  using (
    reminder_id in (
      select reminder.id
      from public.task_email_reminders reminder
      where reminder.user_id = (select auth.uid())
    )
  );

create or replace function private.stop_completed_item_reminders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.completed and not old.completed then
    update public.task_email_reminders
    set status = 'stopped', updated_at = now()
    where item_id = new.id and status <> 'stopped';
  end if;
  return new;
end;
$$;

revoke all on function private.stop_completed_item_reminders() from public, anon, authenticated;

create trigger stop_completed_item_reminders
  after update of completed on public.workspace_items
  for each row execute function private.stop_completed_item_reminders();

create or replace function private.stop_removed_collaborator_reminders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    update public.task_email_reminders
    set status = 'stopped', updated_at = now()
    where item_id = old.item_id and user_id = old.user_id;
    return old;
  end if;
  if new.invite_status <> 'accepted' then
    update public.task_email_reminders
    set status = 'stopped', updated_at = now()
    where item_id = new.item_id and user_id = new.user_id;
  end if;
  return new;
end;
$$;

revoke all on function private.stop_removed_collaborator_reminders() from public, anon, authenticated;

create trigger stop_removed_collaborator_reminders
  after update of invite_status or delete on public.workspace_item_members
  for each row execute function private.stop_removed_collaborator_reminders();

-- The cron dispatcher becomes active once project_url, publishable_key, and
-- reminder_cron_secret exist in Supabase Vault.
create or replace function private.dispatch_due_reminders()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  project_url text;
  publishable_key text;
  cron_secret text;
begin
  select decrypted_secret into project_url
  from vault.decrypted_secrets where name = 'project_url' limit 1;
  select decrypted_secret into publishable_key
  from vault.decrypted_secrets where name = 'publishable_key' limit 1;
  select decrypted_secret into cron_secret
  from vault.decrypted_secrets where name = 'reminder_cron_secret' limit 1;

  if project_url is null or publishable_key is null or cron_secret is null then
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', publishable_key,
      'x-cron-secret', cron_secret
    ),
    body := jsonb_build_object('requested_at', now()),
    timeout_milliseconds := 10000
  );
end;
$$;

revoke all on function private.dispatch_due_reminders() from public, anon, authenticated;

select cron.schedule(
  'ink-and-iron-email-reminders',
  '*/5 * * * *',
  'select private.dispatch_due_reminders()'
);

alter table public.workspace_item_members replica identity full;
alter table public.task_email_reminders replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'workspace_item_members'
  ) then
    alter publication supabase_realtime add table public.workspace_item_members;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'task_email_reminders'
  ) then
    alter publication supabase_realtime add table public.task_email_reminders;
  end if;
end;
$$;
