-- Run after the Quercus migration against a test Supabase database as postgres.
-- Fixtures and changes are always rolled back; no pgTAP dependency.
begin;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000091', 'quercus-owner@test.invalid'),
  ('00000000-0000-4000-8000-000000000092', 'quercus-other@test.invalid');
insert into public.quercus_connections (user_id, canvas_user_id, canvas_name, token_encrypted) values
  ('00000000-0000-4000-8000-000000000091', '11', 'Owner', 'encrypted-owner'),
  ('00000000-0000-4000-8000-000000000092', '22', 'Other', 'encrypted-other');
insert into public.quercus_completions (user_id, canvas_user_id, assignment_id) values
  ('00000000-0000-4000-8000-000000000091', '11', '101'),
  ('00000000-0000-4000-8000-000000000092', '22', '102');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000091', true);
do $$
declare n integer;
begin
  if (select count(*) from public.quercus_connections) <> 1 then raise exception 'connection SELECT leaked another account'; end if;
  if (select count(*) from public.quercus_completions) <> 1 then raise exception 'completion SELECT leaked another account'; end if;
  update public.quercus_connections set canvas_name = 'No' where canvas_user_id = '22';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'updated another account connection'; end if;
  delete from public.quercus_completions where canvas_user_id = '22';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'deleted another account completion'; end if;
  begin
    update public.quercus_connections set user_id = '00000000-0000-4000-8000-000000000092';
    raise exception 'connection ownership reassignment succeeded';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.quercus_completions(user_id, canvas_user_id, assignment_id) values ('00000000-0000-4000-8000-000000000092', '22', '999');
    raise exception 'forged completion INSERT succeeded';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.quercus_connections(user_id, canvas_user_id, canvas_name, token_encrypted) values ('00000000-0000-4000-8000-000000000093', '33', 'Forged', 'encrypted');
    raise exception 'forged connection INSERT succeeded';
  exception when insufficient_privilege then null; end;
  update public.quercus_connections set canvas_name = 'Updated owner';
  if not exists(select 1 from public.quercus_connections where canvas_name = 'Updated owner') then raise exception 'own connection UPDATE failed'; end if;
  insert into public.quercus_completions(user_id, canvas_user_id, assignment_id) values ('00000000-0000-4000-8000-000000000091', '11', '103');
  update public.quercus_completions set completed_at = now() where assignment_id = '103';
  delete from public.quercus_completions where assignment_id = '103';
  delete from public.quercus_connections;
  if (select count(*) from public.quercus_completions) <> 1 then raise exception 'disconnect removed completion'; end if;
  insert into public.quercus_connections(user_id, canvas_user_id, canvas_name, token_encrypted) values ('00000000-0000-4000-8000-000000000091', '11', 'Reconnected', 'encrypted');
end $$;
set local role anon;
do $$
begin
  begin perform * from public.quercus_connections; raise exception 'anonymous connection SELECT succeeded'; exception when insufficient_privilege then null; end;
  begin perform * from public.quercus_completions; raise exception 'anonymous completion SELECT succeeded'; exception when insufficient_privilege then null; end;
  begin delete from public.quercus_connections; raise exception 'anonymous connection DELETE succeeded'; exception when insufficient_privilege then null; end;
  begin update public.quercus_completions set completed_at = now(); raise exception 'anonymous completion UPDATE succeeded'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
