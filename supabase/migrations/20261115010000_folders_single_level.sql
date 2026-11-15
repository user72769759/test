-- 이미 Supabase 프로젝트에 적용됨 (기록용)
-- 폴더는 1단계만: 새로 만들거나 수정하는 폴더는 상위 폴더를 가질 수 없음
alter table public.folders add constraint folders_single_level check (parent_id is null) not valid;
