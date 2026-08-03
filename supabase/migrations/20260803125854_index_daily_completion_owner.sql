create index daily_completions_daily_owner_idx
  on public.daily_completions (daily_id, user_id);
