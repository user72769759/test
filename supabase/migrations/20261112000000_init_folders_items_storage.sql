-- 이미 Supabase 프로젝트에 적용됨 (기록용)
create table public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parent_id uuid references public.folders(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  created_at timestamptz not null default now()
);
create index folders_user_parent_idx on public.folders(user_id, parent_id);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  folder_id uuid references public.folders(id) on delete set null,
  kind text not null check (kind in ('note','image','video','audio','link','file')),
  title text not null default '',
  body text,
  url text,
  file_path text,
  created_at timestamptz not null default now()
);
create index items_user_folder_idx on public.items(user_id, folder_id, created_at desc);
create index items_folder_id_idx on public.items(folder_id);
create index folders_parent_id_idx on public.folders(parent_id);

alter table public.folders enable row level security;
alter table public.items enable row level security;

create policy "own folders" on public.folders for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own items" on public.items for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit)
values ('uploads', 'uploads', false, 52428800)
on conflict (id) do nothing;

create policy "own uploads select" on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own uploads insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own uploads delete" on storage.objects for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
