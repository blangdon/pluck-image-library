-- Pluck Asset Library: access requests
-- Run once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- Also included at the end of schema.sql.

-- Who can approve requests (signed in with this Google account).
create table if not exists library_admins (
  email text primary key            -- lower-case
);
insert into library_admins (email) values ('b.rakiura@gmail.com') on conflict do nothing;

-- One row per person who asked for access.
create table if not exists access_requests (
  email text primary key,
  name text,
  requested_at timestamptz not null default now(),
  status text not null default 'pending',   -- pending | approved
  approved_at timestamptz,
  approved_by text
);

alter table library_admins enable row level security;
alter table access_requests enable row level security;
revoke all on library_admins, access_requests from anon, authenticated;

create or replace function is_library_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from library_admins where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

-- Called by a signed-in person who isn't on the list yet.
-- Returns 'new' (first request, so notify), 'pending' (already asked) or 'approved'.
create or replace function request_access() returns text
language plpgsql security definer set search_path = public as $$
declare
  e text := lower(coalesce(auth.jwt() ->> 'email', ''));
  n text := coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() -> 'user_metadata' ->> 'name', '');
  s text;
begin
  if auth.uid() is null or e = '' then raise exception 'Sign in first'; end if;
  if is_allowed() then return 'approved'; end if;
  select status into s from access_requests where email = e;
  if s is null then
    insert into access_requests (email, name) values (e, n);
    return 'new';
  end if;
  return s;
end;
$$;

-- Called by an admin from the approval link in the notification email.
create or replace function approve_access(target text) returns text
language plpgsql security definer set search_path = public as $$
declare t text := lower(trim(coalesce(target, '')));
begin
  if not is_library_admin() then raise exception 'Only a library admin can approve access'; end if;
  if t !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Not an email address'; end if;
  insert into allowed_emails (email) values (t) on conflict do nothing;
  insert into access_requests (email, status, approved_at, approved_by)
    values (t, 'approved', now(), lower(auth.jwt() ->> 'email'))
    on conflict (email) do update set status = 'approved', approved_at = now(), approved_by = excluded.approved_by;
  return t;
end;
$$;

revoke all on function request_access(), approve_access(text), is_library_admin() from anon;
grant execute on function request_access(), approve_access(text), is_library_admin() to authenticated;
