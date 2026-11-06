-- Thuis-app schema (Supabase / Postgres): huis-app met beurtenrooster voor een groot huis (17 huisgenoten).
-- Wordt uitgevoerd door .github/workflows/setup.yml (en getest door supabase/tests/rls.test.mjs).
-- Idempotent: mag vaker draaien. Principe: elke tabel achter Row Level Security, je ziet alleen je eigen huis.

-- ───────── Basis: huishouden + leden ─────────
-- Code van 8 tekens zonder verwarrende tekens (0/O, 1/I/L): ~8e11 combinaties, niet te raden.
create or replace function new_join_code() returns text
language sql volatile set search_path = public as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + get_byte(b, i) % 31, 1), '')
  from (select uuid_send(gen_random_uuid()) as b) r, generate_series(0, 7) i
$$;

create table if not exists households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  join_code   text not null unique default new_join_code(),
  created_at  timestamptz not null default now()
);

create table if not exists members (
  id               uuid primary key references auth.users(id) on delete cascade,
  household_id     uuid not null references households(id) on delete cascade,
  name             text not null,
  emoji            text not null default '🙂',
  is_admin         boolean not null default false,
  zone             text not null default 'unknown' check (zone in ('home','nearby','away','unknown')),
  zone_updated_at  timestamptz not null default now(),
  out_status       text not null default 'none' check (out_status in ('none','wants','going')),
  out_place        text check (length(out_place) <= 80),
  out_note         text check (length(out_note) <= 200),
  out_until        timestamptz,
  created_at       timestamptz not null default now()
);

-- Geheime token voor iOS Shortcuts / Android automation. Niet leesbaar voor huisgenoten.
create table if not exists member_secrets (
  member_id uuid primary key references members(id) on delete cascade,
  token     text not null unique default encode(uuid_send(gen_random_uuid()), 'hex')
);

-- security definer => geen RLS-lus
create or replace function my_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from members where id = auth.uid()
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from members where id = auth.uid()), false)
$$;

-- Hoort dit lid bij mijn huis?
create or replace function in_my_household(p_member uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where id = p_member and household_id = my_household())
$$;

-- ───────── Beurtenrooster ─────────
-- Wie aan de beurt is wordt UITGEREKEND uit start_date + rotatievolgorde (app/rota.js), geen cron.
-- Uitzonderingen (handmatig of via ruil) staan in chore_overrides.
create table if not exists chores (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null default my_household() references households(id) on delete cascade,
  name          text not null check (length(name) <= 60),
  emoji         text not null default '🗑️',
  start_date    date not null default current_date,           -- begin van periode 0
  period_days   int  not null default 7  check (period_days between 1 and 31),
  team_size     int  not null default 1  check (team_size between 1 and 5),  -- personen per beurt
  created_at    timestamptz not null default now()
);

create table if not exists chore_rotation (
  chore_id      uuid not null references chores(id) on delete cascade,
  member_id     uuid not null references members(id) on delete cascade,
  household_id  uuid not null default my_household() references households(id) on delete cascade,
  position      int  not null,
  primary key (chore_id, member_id)
);

create table if not exists chore_overrides (
  chore_id      uuid not null references chores(id) on delete cascade,
  period_start  date not null,
  slot          int  not null default 0,
  member_id     uuid not null references members(id) on delete cascade,
  reason        text,                                          -- 'handmatig' of 'ruil'
  household_id  uuid not null default my_household() references households(id) on delete cascade,
  primary key (chore_id, period_start, slot)
);

create table if not exists chore_done (
  chore_id      uuid not null references chores(id) on delete cascade,
  period_start  date not null,
  slot          int  not null default 0,
  member_id     uuid not null default auth.uid() references members(id) on delete cascade,  -- wie afvinkte
  done_at       timestamptz not null default now(),
  household_id  uuid not null default my_household() references households(id) on delete cascade,
  primary key (chore_id, period_start, slot)
);

create table if not exists swap_requests (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null default my_household() references households(id) on delete cascade,
  chore_id      uuid not null references chores(id) on delete cascade,
  period_start  date not null,
  slot          int  not null default 0,
  from_member   uuid not null default auth.uid() references members(id) on delete cascade,
  to_member     uuid not null references members(id) on delete cascade,
  status        text not null default 'open' check (status in ('open','accepted','declined','cancelled')),
  created_at    timestamptz not null default now(),
  check (from_member <> to_member)
);

-- ───────── Overige features ─────────
create table if not exists activities (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null default my_household() references households(id) on delete cascade,
  title         text not null check (length(title) <= 120),
  note          text check (length(note) <= 500),
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
  menu          text check (length(menu) <= 120),
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

-- Web Push-abonnementen (één per toestel). Alleen de Edge Function 'notify' leest ze allemaal.
create table if not exists push_subscriptions (
  endpoint      text primary key,
  member_id     uuid not null references members(id) on delete cascade,
  household_id  uuid not null references households(id) on delete cascade,
  p256dh        text not null,
  auth          text not null,
  created_at    timestamptz not null default now()
);

-- ───────── Row Level Security ─────────
do $$
declare t text; p record;
begin
  foreach t in array array['households','members','member_secrets','chores','chore_rotation','chore_overrides','chore_done',
                           'swap_requests','activities','activity_rsvps','dinners','dinner_rsvps','push_subscriptions'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  -- Alle policies opnieuw opbouwen, zodat dit script idempotent is.
  for p in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

create policy "household: eigen"      on households     for select using (id = my_household());
create policy "members: lezen"        on members        for select using (household_id = my_household());
create policy "members: eigen update" on members        for update using (id = auth.uid()) with check (id = auth.uid());
create policy "members: admin delete" on members        for delete using (is_admin() and household_id = my_household() and id <> auth.uid());
create policy "secrets: eigen"        on member_secrets for select using (member_id = auth.uid());

-- Kolomrechten: niemand kan zichzelf beheerder maken of van huis wisselen via een gewone update.
revoke update on members from authenticated, anon;
grant  update (name, emoji, zone, zone_updated_at, out_status, out_place, out_note, out_until) on members to authenticated;

-- Rooster: iedereen leest, alleen beheerders wijzigen; afvinken en ruil aanvragen mag iedereen binnen het huis.
create policy "chores: lezen"         on chores          for select using (household_id = my_household());
create policy "chores: admin"         on chores          for all    using (household_id = my_household() and is_admin()) with check (household_id = my_household() and is_admin());
create policy "rotation: lezen"       on chore_rotation  for select using (household_id = my_household());
create policy "rotation: admin"       on chore_rotation  for all    using (household_id = my_household() and is_admin())
  with check (household_id = my_household() and is_admin() and in_my_household(member_id)
              and exists (select 1 from chores c where c.id = chore_id and c.household_id = my_household()));
create policy "overrides: lezen"      on chore_overrides for select using (household_id = my_household());
create policy "overrides: admin"      on chore_overrides for all    using (household_id = my_household() and is_admin())
  with check (household_id = my_household() and is_admin() and in_my_household(member_id)
              and exists (select 1 from chores c where c.id = chore_id and c.household_id = my_household()));
create policy "done: lezen"           on chore_done      for select using (household_id = my_household());
-- shortcut: de app laat alleen de beurthouder (of beheerder) afvinken; de database checkt alleen het huis.
create policy "done: invullen"        on chore_done      for insert
  with check (member_id = auth.uid() and household_id = my_household()
              and exists (select 1 from chores c where c.id = chore_id and c.household_id = my_household()));
create policy "done: eigen weg"       on chore_done      for delete using (household_id = my_household() and (member_id = auth.uid() or is_admin()));
create policy "swaps: lezen"          on swap_requests   for select using (household_id = my_household());
create policy "swaps: aanvragen"      on swap_requests   for insert
  with check (from_member = auth.uid() and household_id = my_household() and status = 'open' and in_my_household(to_member)
              and exists (select 1 from chores c where c.id = chore_id and c.household_id = my_household()));
-- (status wijzigen gaat alleen via respond_swap)

create policy "activities: lezen"     on activities     for select using (household_id = my_household());
create policy "activities: maken"     on activities     for insert with check (household_id = my_household() and created_by = auth.uid());
create policy "activities: wijzigen"  on activities     for update using (household_id = my_household() and (created_by = auth.uid() or is_admin())) with check (household_id = my_household());
create policy "activities: weg"       on activities     for delete using (household_id = my_household() and (created_by = auth.uid() or is_admin()));
create policy "dinners: alles"        on dinners        for all using (household_id = my_household())
  with check (household_id = my_household() and (cook_id is null or in_my_household(cook_id)));
create policy "act_rsvp: lezen"       on activity_rsvps for select using (household_id = my_household());
create policy "act_rsvp: eigen"       on activity_rsvps for insert with check (member_id = auth.uid() and household_id = my_household() and exists (select 1 from activities a where a.id = activity_id and a.household_id = my_household()));
create policy "act_rsvp: eigen upd"   on activity_rsvps for update using (member_id = auth.uid()) with check (member_id = auth.uid() and household_id = my_household() and exists (select 1 from activities a where a.id = activity_id and a.household_id = my_household()));
create policy "act_rsvp: eigen del"   on activity_rsvps for delete using (member_id = auth.uid());
create policy "din_rsvp: lezen"       on dinner_rsvps   for select using (household_id = my_household());
create policy "din_rsvp: eigen"       on dinner_rsvps   for insert with check (member_id = auth.uid() and household_id = my_household() and exists (select 1 from dinners d where d.id = dinner_id and d.household_id = my_household()));
create policy "din_rsvp: eigen upd"   on dinner_rsvps   for update using (member_id = auth.uid()) with check (member_id = auth.uid() and household_id = my_household() and exists (select 1 from dinners d where d.id = dinner_id and d.household_id = my_household()));
create policy "din_rsvp: eigen del"   on dinner_rsvps   for delete using (member_id = auth.uid());
create policy "push: eigen lezen"     on push_subscriptions for select using (member_id = auth.uid());
create policy "push: eigen del"       on push_subscriptions for delete using (member_id = auth.uid());

-- ───────── RPC's ─────────
-- Nieuw huis; de maker wordt beheerder. Geeft de uitnodigingscode terug.
create or replace function create_household(p_household text, p_name text, p_emoji text default '🙂')
returns text language plpgsql security definer set search_path = public as $$
declare hid uuid; code text;
begin
  if auth.uid() is null then raise exception 'niet ingelogd'; end if;
  if exists (select 1 from members where id = auth.uid()) then raise exception 'al lid van een huis'; end if;
  if coalesce(trim(p_household), '') = '' or coalesce(trim(p_name), '') = '' then raise exception 'naam ontbreekt'; end if;
  insert into households(name) values (left(trim(p_household), 60)) returning id, join_code into hid, code;
  insert into members(id, household_id, name, emoji, is_admin)
    values (auth.uid(), hid, left(trim(p_name), 30), left(coalesce(nullif(trim(p_emoji), ''), '🙂'), 8), true);
  insert into member_secrets(member_id) values (auth.uid());
  return code;
end $$;

-- Aansluiten met code; nieuwe huisgenoot komt achteraan in elke bestaande rotatie.
create or replace function join_household(p_code text, p_name text, p_emoji text default '🙂')
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'niet ingelogd'; end if;
  if exists (select 1 from members where id = auth.uid()) then raise exception 'al lid van een huis'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'naam ontbreekt'; end if;
  select id into hid from households where join_code = upper(trim(p_code));
  if hid is null then raise exception 'onbekende code'; end if;
  insert into members(id, household_id, name, emoji)
    values (auth.uid(), hid, left(trim(p_name), 30), left(coalesce(nullif(trim(p_emoji), ''), '🙂'), 8));
  insert into member_secrets(member_id) values (auth.uid());
  insert into chore_rotation(chore_id, member_id, household_id, position)
    select c.id, auth.uid(), hid, coalesce((select max(position) from chore_rotation r where r.chore_id = c.id), 0) + 1
    from chores c where c.household_id = hid;
  return hid;
end $$;

-- Nieuwe taak: alle huidige leden komen in de rotatie (op volgorde van aanmelden). Alleen beheerders.
create or replace function create_chore(p_name text, p_emoji text, p_start date, p_period int default 7, p_team int default 1)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid; hid uuid := my_household();
begin
  if not is_admin() then raise exception 'alleen beheerders'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'naam ontbreekt'; end if;
  insert into chores(household_id, name, emoji, start_date, period_days, team_size)
    values (hid, left(trim(p_name), 60), left(coalesce(nullif(trim(p_emoji), ''), '🗑️'), 8), p_start, p_period, p_team) returning id into cid;
  insert into chore_rotation(chore_id, member_id, household_id, position)
    select cid, m.id, hid, row_number() over (order by m.created_at) from members m where m.household_id = hid;
  return cid;
end $$;

-- Iemand een plek omhoog (-1) of omlaag (+1) in de rotatie schuiven. Alleen beheerders.
create or replace function move_rotation(p_chore uuid, p_member uuid, p_dir int)
returns void language plpgsql security definer set search_path = public as $$
declare mine int; other_member uuid; other_pos int;
begin
  if not is_admin() then raise exception 'alleen beheerders'; end if;
  if not exists (select 1 from chores where id = p_chore and household_id = my_household()) then raise exception 'onbekende taak'; end if;
  select position into mine from chore_rotation where chore_id = p_chore and member_id = p_member;
  if mine is null then return; end if;
  if p_dir < 0 then
    select member_id, position into other_member, other_pos from chore_rotation
      where chore_id = p_chore and position < mine order by position desc limit 1;
  else
    select member_id, position into other_member, other_pos from chore_rotation
      where chore_id = p_chore and position > mine order by position asc limit 1;
  end if;
  if other_member is null then return; end if;
  update chore_rotation set position = other_pos where chore_id = p_chore and member_id = p_member;
  update chore_rotation set position = mine      where chore_id = p_chore and member_id = other_member;
end $$;

create or replace function set_admin(p_member uuid, p_value boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'alleen beheerders'; end if;
  if p_member = auth.uid() and not p_value then raise exception 'je kunt jezelf niet degraderen'; end if;
  update members set is_admin = p_value where id = p_member and household_id = my_household();
end $$;

-- Ruilverzoek beantwoorden: 'accept' en 'decline' door de ontvanger, 'cancel' door de aanvrager.
create or replace function respond_swap(p_id uuid, p_action text)
returns void language plpgsql security definer set search_path = public as $$
declare s swap_requests;
begin
  select * into s from swap_requests where id = p_id and household_id = my_household() and status = 'open' for update;
  if s.id is null then raise exception 'verzoek niet gevonden of al afgehandeld'; end if;
  if p_action = 'cancel' and s.from_member = auth.uid() then
    update swap_requests set status = 'cancelled' where id = p_id;
  elsif p_action = 'decline' and s.to_member = auth.uid() then
    update swap_requests set status = 'declined' where id = p_id;
  elsif p_action = 'accept' and s.to_member = auth.uid() then
    insert into chore_overrides(chore_id, period_start, slot, member_id, reason, household_id)
      values (s.chore_id, s.period_start, s.slot, s.to_member, 'ruil', s.household_id)
      on conflict (chore_id, period_start, slot) do update set member_id = excluded.member_id, reason = 'ruil';
    update swap_requests set status = 'accepted' where id = p_id;
    -- andere open verzoeken voor dezelfde beurt zijn nu achterhaald
    update swap_requests set status = 'cancelled'
      where chore_id = s.chore_id and period_start = s.period_start and slot = s.slot and status = 'open';
  else
    raise exception 'niet toegestaan';
  end if;
end $$;

-- Zone zetten vanuit een automation (iOS Shortcuts). Alleen zone, nooit coördinaten.
create or replace function set_zone_by_token(p_token text, p_zone text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_zone not in ('home','nearby','away') then raise exception 'ongeldige zone'; end if;
  update members set zone = p_zone, zone_updated_at = now()
   where id = (select member_id from member_secrets where token = p_token);
  if not found then raise exception 'onbekende token'; end if;
end $$;

-- Push-abonnement opslaan; neemt het endpoint over als dit toestel eerder bij een ander account hoorde.
create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare hid uuid := my_household();
begin
  if hid is null then raise exception 'geen lid van een huis'; end if;
  if p_endpoint !~ '^https://' then raise exception 'ongeldig endpoint'; end if;
  insert into push_subscriptions(endpoint, member_id, household_id, p256dh, auth)
  values (p_endpoint, auth.uid(), hid, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set member_id = excluded.member_id, household_id = excluded.household_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

do $$
declare f text;
begin
  foreach f in array array['create_household(text,text,text)', 'join_household(text,text,text)', 'create_chore(text,text,date,int,int)',
                           'move_rotation(uuid,uuid,int)', 'set_admin(uuid,boolean)', 'respond_swap(uuid,text)',
                           'save_push_subscription(text,text,text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
grant execute on function set_zone_by_token(text, text) to anon, authenticated;

-- ───────── Realtime ─────────
do $$
declare t text;
begin
  foreach t in array array['members','chores','chore_rotation','chore_overrides','chore_done','swap_requests',
                           'activities','activity_rsvps','dinners','dinner_rsvps'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
