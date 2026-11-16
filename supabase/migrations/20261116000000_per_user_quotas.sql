-- 이미 Supabase 프로젝트에 적용됨 (기록용)
-- 10명 기준 1인당 한도: AI 분류 하루 30건, 저장 공간 90MB, 파일 1개 20MB

create or replace function public.my_storage_used()
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0)
  from storage.objects o
  where o.bucket_id = 'uploads' and (storage.foldername(o.name))[1] = (select auth.uid())::text;
$$;
revoke execute on function public.my_storage_used() from public, anon;
grant execute on function public.my_storage_used() to authenticated;

drop policy if exists "own uploads insert" on storage.objects;
create policy "own uploads insert" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.my_storage_used()) < 94371840  -- 90MB
  );

update storage.buckets
  set file_size_limit = 20971520,
      allowed_mime_types = array['image/*','video/*','audio/*','application/pdf','text/plain']
  where id = 'uploads';

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
create policy "read own ai usage" on public.ai_usage for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.consume_ai_quota()
returns int language plpgsql security definer set search_path = '' as $$
declare c int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.ai_usage as u (user_id, day, count)
  values (auth.uid(), (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set count = u.count + 1 where u.count < 30
  returning u.count into c;
  return coalesce(c, -1);
end;
$$;
revoke execute on function public.consume_ai_quota() from public, anon;
grant execute on function public.consume_ai_quota() to authenticated;

create or replace function public.my_usage()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'storage_used', (select public.my_storage_used()),
    'storage_limit', 94371840,
    'ai_used_today', coalesce((select count from public.ai_usage
                               where user_id = (select auth.uid()) and day = (now() at time zone 'utc')::date), 0),
    'ai_limit', 30
  );
$$;
revoke execute on function public.my_usage() from public, anon;
grant execute on function public.my_usage() to authenticated;
