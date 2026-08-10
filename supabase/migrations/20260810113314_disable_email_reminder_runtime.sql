-- Retire the email-reminder runtime. The feature code remains available in
-- Git history and vaulted-features/, but no scheduled worker or reminder data
-- remains active in production.
do $$
declare
  reminder_job_id bigint;
begin
  select jobid into reminder_job_id
  from cron.job
  where jobname = 'ink-and-iron-email-reminders';

  if reminder_job_id is not null then
    perform cron.unschedule(reminder_job_id);
  end if;
end;
$$;

drop trigger if exists stop_completed_item_reminders on public.workspace_items;
drop trigger if exists stop_removed_collaborator_reminders on public.workspace_item_members;
drop function if exists private.stop_completed_item_reminders();
drop function if exists private.stop_removed_collaborator_reminders();
drop function if exists private.dispatch_due_reminders();

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'task_email_reminders'
  ) then
    alter publication supabase_realtime drop table public.task_email_reminders;
  end if;
end;
$$;

drop table if exists public.task_email_deliveries;
drop table if exists public.task_email_reminders;

-- Project-wide sharing: accepted members can view and edit every line in a
-- project, including lines created by its owner after the invitation.
create table public.workspace_project_members (
  id uuid primary key default gen_random_uuid(),
  project_name text not null check (length(trim(project_name)) between 1 and 120),
  owner_id uuid not null references auth.users(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  invited_by uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('editor')),
  invite_status text not null default 'pending'
    check (invite_status in ('pending', 'accepted', 'declined')),
  invited_at timestamptz not null default now(),
  responded_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (project_name, owner_id, user_id),
  check (owner_id = invited_by),
  check (user_id <> invited_by)
);

create index workspace_project_members_user_status_idx
  on public.workspace_project_members (user_id, invite_status, invited_at desc);
create index workspace_project_members_owner_project_idx
  on public.workspace_project_members (owner_id, project_name, invite_status);

alter table public.workspace_project_members enable row level security;
revoke all on public.workspace_project_members from anon, authenticated;
grant select, insert, delete on public.workspace_project_members to authenticated;
grant update (project_name, invite_status, responded_at, updated_at)
  on public.workspace_project_members to authenticated;

create policy "project_members_select_involved"
  on public.workspace_project_members for select
  to authenticated
  using ((select auth.uid()) = user_id or (select auth.uid()) = invited_by);

create policy "project_members_owner_invite"
  on public.workspace_project_members for insert
  to authenticated
  with check (
    (select auth.uid()) = invited_by
    and owner_id = (select auth.uid())
    and user_id <> (select auth.uid())
  );

create policy "project_members_respond_or_rename"
  on public.workspace_project_members for update
  to authenticated
  using ((select auth.uid()) = user_id or (select auth.uid()) = invited_by)
  with check (
    (
      (select auth.uid()) = user_id
      and invite_status in ('accepted', 'declined')
    )
    or (
      (select auth.uid()) = invited_by
      and owner_id = (select auth.uid())
    )
  );

create policy "project_members_leave_or_revoke"
  on public.workspace_project_members for delete
  to authenticated
  using ((select auth.uid()) = user_id or (select auth.uid()) = invited_by);

drop policy if exists "workspace_select_owned_or_shared" on public.workspace_items;
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
    or (
      section = 'projects'
      and exists (
        select 1
        from public.workspace_project_members member
        where member.owner_id = workspace_items.user_id
          and member.project_name = workspace_items.group_name
          and member.user_id = (select auth.uid())
          and member.invite_status in ('pending', 'accepted')
      )
    )
  );

drop policy if exists "workspace_update_owned_or_shared" on public.workspace_items;
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
    or (
      section = 'projects'
      and exists (
        select 1
        from public.workspace_project_members member
        where member.owner_id = workspace_items.user_id
          and member.project_name = workspace_items.group_name
          and member.user_id = (select auth.uid())
          and member.invite_status = 'accepted'
      )
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
    or (
      section = 'projects'
      and exists (
        select 1
        from public.workspace_project_members member
        where member.owner_id = workspace_items.user_id
          and member.project_name = workspace_items.group_name
          and member.user_id = (select auth.uid())
          and member.invite_status = 'accepted'
      )
    )
  );

alter table public.workspace_project_members replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'workspace_project_members'
  ) then
    alter publication supabase_realtime add table public.workspace_project_members;
  end if;
end;
$$;
