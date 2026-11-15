-- 이미 Supabase 프로젝트에 적용됨 (기록용)
-- 휴지통: deleted_at 이 있으면 휴지통에 있는 항목
alter table public.items add column if not exists deleted_at timestamptz;
create index if not exists items_user_deleted_idx on public.items(user_id, deleted_at);
