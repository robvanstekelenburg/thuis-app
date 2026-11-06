// Edge Function 'notify': stuurt Web Push naar huisgenoten.
//  - Vanuit de app (gebruikers-JWT): { type: 'out' | 'activity' | 'dinner' | 'swap' | 'test', id?, day? }
//    De tekst wordt hier uit de database opgebouwd, dus de app kan geen willekeurige berichten sturen.
//  - Vanuit GitHub Actions (header x-service-key = secret key): { type: 'rota' } → beurt-herinneringen.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { addIso, holders, periodEnd, periodOf, periodStart } from './rota.js'; // kopie van app/rota.js (test bewaakt dat)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, *',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Nieuwe sleutels (SUPABASE_SECRET_KEYS) met terugval op de legacy service_role key.
const secretKeys = Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')) as string[];
const legacyKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const adminKeys = new Set([...secretKeys, legacyKey].filter(Boolean));
const admin = createClient(Deno.env.get('SUPABASE_URL')!, secretKeys[0] || legacyKey!, { auth: { persistSession: false } });

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY');
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:thuis@example.invalid', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

type Msg = { title: string; body: string; tag: string; url: string };
type Member = { id: string; household_id: string; name: string; emoji: string; out_status: string; out_place: string | null; out_note: string | null };
type Chore = { id: string; household_id: string; name: string; emoji: string; start_date: string; period_days: number; team_size: number };

const TZ = 'Europe/Amsterdam';
const isoDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD in NL-tijd
const when = (ts: string) =>
  new Intl.DateTimeFormat('nl-NL', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
function dayName(day: string) {
  const today = isoDay(new Date());
  if (day === today) return 'vandaag';
  if (day === addIso(today, 1)) return 'morgen';
  return new Intl.DateTimeFormat('nl-NL', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(day + 'T12:00:00Z'));
}

// Stuurt naar alle toestellen die aan het filter voldoen; ruimt verlopen abonnementen op.
async function send(filter: { household?: string; except?: string; members?: string[] }, msg: Msg) {
  let q = admin.from('push_subscriptions').select('endpoint, p256dh, auth');
  if (filter.household) q = q.eq('household_id', filter.household);
  if (filter.except) q = q.neq('member_id', filter.except);
  if (filter.members) q = q.in('member_id', filter.members);
  const { data: subs, error } = await q;
  if (error) throw error;
  const payload = JSON.stringify(msg);
  const results = await Promise.allSettled((subs ?? []).map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 12 * 3600 })));
  const gone = (subs ?? []).filter((_, i) => {
    const r = results[i];
    return r.status === 'rejected' && [404, 410].includes((r.reason as { statusCode?: number })?.statusCode ?? 0);
  });
  if (gone.length) await admin.from('push_subscriptions').delete().in('endpoint', gone.map((s) => s.endpoint));
  results.forEach((r) => r.status === 'rejected' && console.error('push mislukt', (r.reason as Error)?.message ?? r.reason));
  return results.filter((r) => r.status === 'fulfilled').length;
}

async function fromApp(body: { type?: string; id?: string; day?: string }, me: Member) {
  const toOthers = (msg: Msg) => send({ household: me.household_id, except: me.id }, msg);
  const nameOf = async (id: string) => (await admin.from('members').select('name').eq('id', id).maybeSingle()).data?.name ?? '?';
  switch (body.type) {
    case 'test':
      return send({ members: [me.id] }, { title: '🔔 Meldingen werken', body: `Hoi ${me.name}, dit toestel krijgt meldingen van Thuis.`, tag: 'test', url: './#ik' });
    case 'out': {
      if (me.out_status === 'none') return 0;
      const what = me.out_status === 'going' ? 'gaat uit' : 'wil uit';
      const text = [me.out_place, me.out_note].filter(Boolean).join(' · ') || 'Wie gaat er mee?';
      return toOthers({ title: `${me.emoji} ${me.name} ${what}`, body: text, tag: `out-${me.id}`, url: './#uit' });
    }
    case 'activity': {
      const { data: a } = await admin.from('activities').select('*').eq('id', body.id ?? '').eq('household_id', me.household_id).maybeSingle();
      if (!a) return 0;
      return toOthers({ title: `🎲 ${a.title}`, body: `${me.name} plant iets${a.starts_at ? ' · ' + when(a.starts_at) : ''}. Doe je mee?`, tag: `act-${a.id}`, url: './#activiteiten' });
    }
    case 'dinner': {
      const { data: d } = await admin.from('dinners').select('*').eq('day', body.day ?? '').eq('household_id', me.household_id).maybeSingle();
      if (!d?.menu) return 0;
      const cook = d.cook_id ? await nameOf(d.cook_id) : null;
      return toOthers({ title: `🍝 ${dayName(d.day)}: ${d.menu}`, body: `${cook ? cook + ' kookt. ' : ''}Eet je mee?`, tag: `dinner-${d.day}`, url: './#eten' });
    }
    case 'swap': {
      const { data: s } = await admin.from('swap_requests').select('*, chores(name, emoji)').eq('id', body.id ?? '').eq('household_id', me.household_id).maybeSingle();
      if (!s) return 0;
      const chore = `${s.chores?.emoji ?? ''} ${s.chores?.name ?? 'een taak'}`.trim();
      const tag = `swap-${s.id}`;
      if (s.status === 'open' && s.from_member === me.id) {
        return send({ members: [s.to_member] }, { title: `↔ ${me.name} vraagt of je wilt ruilen`, body: `Neem jij ${chore} over (${dayName(s.period_start)})?`, tag, url: './#home' });
      }
      if (['accepted', 'declined'].includes(s.status) && s.to_member === me.id) {
        const ok = s.status === 'accepted';
        return send({ members: [s.from_member] }, { title: ok ? `✅ ${me.name} neemt je beurt over` : `❌ ${me.name} kan niet ruilen`, body: `${chore} (${dayName(s.period_start)})`, tag, url: './#home' });
      }
      return 0;
    }
    default:
      throw new Error('onbekend type');
  }
}

// Elke avond: "morgen begint jouw beurt" en "vandaag laatste dag, nog niet afgevinkt".
async function rotaReminders() {
  const today = isoDay(new Date());
  const tomorrow = addIso(today, 1);
  const [{ data: chores, error }, { data: rot }, { data: ovs }, { data: done }] = await Promise.all([
    admin.from('chores').select('*'),
    admin.from('chore_rotation').select('chore_id, member_id, position').order('position'),
    admin.from('chore_overrides').select('*').gte('period_start', addIso(today, -31)),
    admin.from('chore_done').select('chore_id, period_start, slot').gte('period_start', addIso(today, -31)),
  ]);
  if (error) throw error;
  let sent = 0;
  for (const c of (chores ?? []) as Chore[]) {
    const rotation = (rot ?? []).filter((r) => r.chore_id === c.id).map((r) => r.member_id);
    const label = `${c.emoji} ${c.name}`;
    const pTomorrow = periodOf(c, tomorrow);
    if (pTomorrow >= 0 && periodStart(c, pTomorrow) === tomorrow) {
      const ids = holders(c, pTomorrow, rotation, ovs ?? []).map((h) => h.id).filter(Boolean) as string[];
      const until = c.period_days > 1 ? ` (t/m ${dayName(periodEnd(c, pTomorrow))})` : '';
      if (ids.length) sent += await send({ members: ids }, { title: `Morgen ben jij aan de beurt`, body: `${label}${until}`, tag: `rota-${c.id}-${tomorrow}`, url: './#home' });
    }
    const pToday = periodOf(c, today);
    if (pToday >= 0 && c.period_days > 1 && periodEnd(c, pToday) === today) {
      const open = holders(c, pToday, rotation, ovs ?? [])
        .filter((h) => h.id && !(done ?? []).some((d) => d.chore_id === c.id && d.period_start === h.ps && d.slot === h.slot))
        .map((h) => h.id) as string[];
      if (open.length) sent += await send({ members: open }, { title: `⏰ Vandaag laatste dag`, body: `${label} staat nog niet op klaar.`, tag: `rota-last-${c.id}-${today}`, url: './#home' });
    }
  }
  return { today, chores: chores?.length ?? 0, sent };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'alleen POST' }, 405);
  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return json({ error: 'VAPID-sleutels ontbreken' }, 500);
    const body = await req.json().catch(() => ({}));

    if (body.type === 'rota') {
      if (!adminKeys.has(req.headers.get('x-service-key') ?? '')) return json({ error: 'verboden' }, 403);
      return json(await rotaReminders());
    }

    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'niet ingelogd' }, 401);
    const { data: me } = await admin.from('members').select('*').eq('id', user.id).maybeSingle();
    if (!me) return json({ error: 'geen lid van een huis' }, 403);
    return json({ sent: await fromApp(body, me) });
  } catch (e) {
    console.error(e);
    const msg = (e as Error)?.message ?? String(e);
    return json({ error: msg }, msg === 'onbekend type' ? 400 : 500);
  }
});
