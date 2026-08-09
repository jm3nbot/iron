create index workspace_item_members_item_owner_idx
  on public.workspace_item_members (item_id, owner_id);

create index workspace_item_members_owner_idx
  on public.workspace_item_members (owner_id);
