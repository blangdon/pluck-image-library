-- Pluck Image Library: database schema
-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: it only creates what's missing and replaces functions/policies.

-- ---------------------------------------------------------------------------
-- Who may open the gallery
-- ---------------------------------------------------------------------------
create table if not exists allowed_emails (
  email text primary key            -- lower-case, e.g. 'sam@example.com'
);

create table if not exists allowed_domains (
  domain text primary key           -- lower-case, without @, e.g. 'pluck.co.nz'
);

-- Locked: no policies, so only the dashboard (and the function below) can read or change the lists.
alter table allowed_emails enable row level security;
alter table allowed_domains enable row level security;
revoke all on allowed_emails, allowed_domains from anon, authenticated;

create or replace function is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from allowed_emails
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  ) or exists (
    select 1 from allowed_domains
    where domain = split_part(lower(coalesce(auth.jwt() ->> 'email', '')), '@', 2)
  );
$$;

-- ---------------------------------------------------------------------------
-- One row per image file in Drive
-- ---------------------------------------------------------------------------
create table if not exists images (
  id               text primary key,          -- Google Drive file id
  name             text not null,
  folder_path      text,                      -- e.g. 'Pluck/Marketing/2026 Shoots'
  mime_type        text,
  drive_url        text,
  md5              text,                      -- changes when the file's content changes
  drive_created_at  timestamptz,
  drive_modified_at timestamptz,
  added_by         text,                      -- Drive display name, when available
  width            int,
  height           int,
  thumb_path       text,                      -- path inside the 'thumbs' storage bucket

  -- AI tagging
  description      text,
  tags             text[] not null default '{}',
  flavours         text[] not null default '{}',
  packaging        text,                      -- 'new', 'old', 'mixed' or null
  is_render        boolean,                   -- true = 3D render / mockup, false = real photo
  tag_confidence   jsonb,                     -- {"pluck shaker": "high", ...}
  tagged_at        timestamptz,
  tag_model        text,
  tag_error        text,                      -- last tagging failure, if any
  tag_attempts     int not null default 0,    -- gives up after 3 failures until the file changes

  -- People's corrections (kept separate so re-tagging never overwrites them)
  manual_tags      text[] not null default '{}',
  hidden_tags      text[] not null default '{}',

  -- Face search (tagger/faces.py)
  people           text[] not null default '{}',  -- names matched by face search
  faces_md5        text,                          -- version of the file last scanned for faces

  first_seen_at    timestamptz not null default now(),  -- when the indexer first found it
  last_seen_at     timestamptz not null default now(),  -- last time the indexer saw it in Drive
  removed          boolean not null default false       -- no longer in the covered folders
);

-- Columns added after the first release (safe to re-run).
alter table images add column if not exists people text[] not null default '{}';
alter table images add column if not exists faces_md5 text;

create index if not exists images_first_seen_idx on images (first_seen_at desc);
create index if not exists images_tags_idx on images using gin (tags);
create index if not exists images_manual_tags_idx on images using gin (manual_tags);

alter table images enable row level security;

drop policy if exists "team can view images" on images;
create policy "team can view images" on images
  for select to authenticated using (is_allowed());

drop policy if exists "team can correct tags" on images;
create policy "team can correct tags" on images
  for update to authenticated using (is_allowed()) with check (is_allowed());

-- Signed-in people may only change the two correction columns, nothing else.
revoke insert, update, delete on images from authenticated, anon;
grant update (manual_tags, hidden_tags) on images to authenticated;

-- ---------------------------------------------------------------------------
-- "New since your last visit"
-- A visit counts as new after 30 minutes away. The function returns the time
-- the previous visit ended, so the page can highlight images added after it.
-- ---------------------------------------------------------------------------
create table if not exists user_visits (
  user_id          uuid primary key references auth.users on delete cascade,
  last_active_at   timestamptz not null,
  previous_visit_at timestamptz
);

alter table user_visits enable row level security;

drop policy if exists "people see their own visits" on user_visits;
create policy "people see their own visits" on user_visits
  for select to authenticated using (user_id = auth.uid());

create or replace function start_visit() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v user_visits;
begin
  if auth.uid() is null or not is_allowed() then
    return null;
  end if;

  select * into v from user_visits where user_id = auth.uid();

  if not found then
    insert into user_visits (user_id, last_active_at, previous_visit_at)
    values (auth.uid(), now(), null);
    return null;                                   -- first ever visit
  end if;

  if v.last_active_at < now() - interval '30 minutes' then
    update user_visits
      set previous_visit_at = v.last_active_at, last_active_at = now()
      where user_id = auth.uid();
    return v.last_active_at;
  else
    update user_visits set last_active_at = now() where user_id = auth.uid();
    return v.previous_visit_at;                    -- same visit continues
  end if;
end;
$$;

revoke all on function start_visit() from anon;
grant execute on function start_visit() to authenticated;

-- Lets the page tell someone they're signed in but not on the list.
grant execute on function is_allowed() to authenticated;

-- ---------------------------------------------------------------------------
-- Thumbnail storage (private; the page fetches short-lived signed links)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('thumbs', 'thumbs', false)
on conflict (id) do nothing;

drop policy if exists "team can view thumbnails" on storage.objects;
create policy "team can view thumbnails" on storage.objects
  for select to authenticated using (bucket_id = 'thumbs' and is_allowed());
