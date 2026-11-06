-- Thuis-app schema (Supabase / Postgres).
-- Plak in: Supabase dashboard > SQL editor > Run. Daarna: Authentication > Providers > "Allow anonymous sign-ins" AAN.
-- Principe: elke tabel staat achter Row Level Security; je ziet alleen data van je eigen huishouden.

create extension if not exists pgcrypto;

-- ───────── Basis: huishouden + leden ─────────
create table if not exists households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  join_code   text not null unique default upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6)),
  created_at  timestamptz not null default now()
);

create table if not exists members (
  id               uuid primary key references auth.users(id) on delete cascade,
  household_id     uuid not null references households(id) on delete cascade,
  name             text not null,
  emoji            text not null default '🙂',
  zone             text not null default 'unknown' check (zone in ('home','nearby','away','unknown')),
  zone_updated_at  timestamptz not null default now(),
  out_status       text not null default 'none' check (out_status in ('none','wants','going')),
  out_place        text,
  out_note         text,
  out_until        timestamptz,
  created_at       timestamptz not null default now()
);

-- Geheime token voor iOS Shortcuts / Android automation. Niet leesbaar voor huisgenoten.
create table if not exists member_secrets (
  member_id uuid primary key references members(id) on delete cascade,
  token     text not null unique default encode(gen_random_bytes(16), 'hex')
);

-- Hulpfunctie: in welk huishouden zit de ingelogde gebruiker? (security definer => geen RLS-lus)
create or replace function my_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from members where id = auth.uid()
$$;

-- ───────── Features ─────────
create table if not exists activities (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null default my_household() references households(id) on delete cascade,
  title         text not null,
  note          text,
  starts_at     timestamptz,
  created_by    uuid default auth.uid() references members(id) on delete set null,
  created_at    timestamptz not null default now()
);

create table if not exists activity_rsvps (
  activity_id   uuid not null references activities(id) on delete cascade,
  member_id     uuid not null default auth.uid() references members(id) on delete cascade,
  household_id  uuid not null default my_household() references households(id) on delete cascade,
  answer        text not null check (answer in ('mee','niet','misschien')),
  primary key (activity_id, member_id)
);

create table if not exists dinners (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null default my_household() references households(id) on delete cascade,
  day           date not null,
  menu          text,
  cook_id       uuid references members(id) on delete set null,
  note          text,
  unique (household_id, day)
);

create table if not exists dinner_rsvps (
  dinner_id     uuid not null references dinners(id) on delete cascade,
  member_id     uuid not null default auth.uid() references members(id) on delete cascade,
  household_id  uuid not null default my_household() references households(id) on delete cascade,
  answer        text not null check (answer in ('mee','niet','misschien')),
  guests        int  not null default 0 check (guests between 0 and 10),
  primary key (dinner_id, member_id)
);

-- Afvalkalender: wordt gevuld door het sync-script (service role), niet door de app.
create table if not exists waste_events (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  day           date not null,
  kind          text not null,   -- rest | gft | pmd | papier | glas | overig
  label         text,
  unique (household_id, day, kind)
);

-- ───────── Row Level Security ─────────
alter table households     enable row level security;
alter table members        enable row level security;
alter table member_secrets enable row level security;
alter table activities     enable row level security;
alter table activity_rsvps enable row level security;
alter table dinners        enable row level security;
alter table dinner_rsvps   enable row level security;
alter table waste_events   enable row level security;

create policy "household: eigen"      on households     for select using (id = my_household());
create policy "members: lezen"        on members        for select using (household_id = my_household());
create policy "members: eigen update" on members        for update using (id = auth.uid()) with check (id = auth.uid() and household_id = my_household());
create policy "secrets: eigen"        on member_secrets for select using (member_id = auth.uid());
create policy "waste: lezen"          on waste_events   for select using (household_id = my_household());

create policy "activities: alles"     on activities     for all using (household_id = my_household()) with check (household_id = my_household());
create policy "dinners: alles"        on dinners        for all using (household_id = my_household()) with check (household_id = my_household());
create policy "act_rsvp: lezen"       on activity_rsvps for select using (household_id = my_household());
create policy "act_rsvp: eigen"       on activity_rsvps for insert with check (member_id = auth.uid() and household_id = my_household());
create policy "act_rsvp: eigen upd"   on activity_rsvps for update using (member_id = auth.uid()) with check (member_id = auth.uid());
create policy "act_rsvp: eigen del"   on activity_rsvps for delete using (member_id = auth.uid());
create policy "din_rsvp: lezen"       on dinner_rsvps   for select using (household_id = my_household());
create policy "din_rsvp: eigen"       on dinner_rsvps   for insert with check (member_id = auth.uid() and household_id = my_household());
create policy "din_rsvp: eigen upd"   on dinner_rsvps   for update using (member_id = auth.uid()) with check (member_id = auth.uid());
create policy "din_rsvp: eigen del"   on dinner_rsvps   for delete using (member_id = auth.uid());

-- ───────── RPC's ─────────
-- Nieuw huishouden starten; geeft de uitnodigingscode terug.
create or replace function create_household(p_household text, p_name text, p_emoji text default '🙂')
returns text language plpgsql security definer set search_path = public as $$
declare hid uuid; code text;
begin
  if auth.uid() is null then raise exception 'niet ingelogd'; end if;
  if exists (select 1 from members where id = auth.uid()) then raise exception 'al lid van een huishouden'; end if;
  insert into households(name) values (left(trim(p_household), 60)) returning id, join_code into hid, code;
  insert into members(id, household_id, name, emoji) values (auth.uid(), hid, left(trim(p_name), 30), p_emoji);
  insert into member_secrets(member_id) values (auth.uid());
  return code;
end $$;

-- Aansluiten met code.
create or replace function join_household(p_code text, p_name text, p_emoji text default '🙂')
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'niet ingelogd'; end if;
  if exists (select 1 from members where id = auth.uid()) then raise exception 'al lid van een huishouden'; end if;
  select id into hid from households where join_code = upper(trim(p_code));
  if hid is null then raise exception 'onbekende code'; end if;
  insert into members(id, household_id, name, emoji) values (auth.uid(), hid, left(trim(p_name), 30), p_emoji);
  insert into member_secrets(member_id) values (auth.uid());
  return hid;
end $$;

-- Zone zetten vanuit een automation (iOS Shortcuts "Aankomen bij thuis" -> GET/POST). Alleen zone, nooit coördinaten.
create or replace function set_zone_by_token(p_token text, p_zone text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_zone not in ('home','nearby','away') then raise exception 'ongeldige zone'; end if;
  update members set zone = p_zone, zone_updated_at = now()
   where id = (select member_id from member_secrets where token = p_token);
end $$;
grant execute on function set_zone_by_token(text, text) to anon, authenticated;
grant execute on function create_household(text, text, text) to authenticated;
grant execute on function join_household(text, text, text) to authenticated;

-- ───────── Realtime ─────────
alter publication supabase_realtime add table members, activities, activity_rsvps, dinners, dinner_rsvps, waste_events;
