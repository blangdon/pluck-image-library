-- Recipe explorer (/recipes): one row per folder under "Recipes/Use Cases". Filled by tagger/recipes.py.
create table if not exists recipe_sets (
  id            text primary key,       -- Drive folder id
  parent_id     text,
  depth         int not null default 0,
  name          text not null,          -- folder name
  folder_path   text not null,          -- same format as images.folder_path
  kind          text,                   -- recipe / creator / collection / part
  title         text,
  creator       text,
  summary       text,
  flavours      text[] not null default '{}',
  proteins      text[] not null default '{}',
  meal          text[] not null default '{}',
  diet          text[] not null default '{}',
  ingredients   text[] not null default '{}',
  method        text[] not null default '{}',
  season        text[] not null default '{}',
  prep_minutes  int,
  servings      text,
  doc_id        text,
  doc_url       text,
  media_here    int not null default 0,
  sig           text,                   -- what the folder looked like when last read
  updated_at    timestamptz not null default now()
);
alter table recipe_sets enable row level security;
drop policy if exists "team can read recipes" on recipe_sets;
create policy "team can read recipes" on recipe_sets for select to authenticated using (is_allowed());
