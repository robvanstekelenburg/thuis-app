import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from './config.js';
import { addIso, periodOf, periodStart, periodEnd, holders } from './rota.js';

const sb = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privémodus */ } },
};

const TABS = ['home', 'uit', 'activiteiten', 'eten', 'ik'];
const state = {
  tab: TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : store.get('tab') || 'home',
  push: 'unknown', // unconfigured | unsupported | needs-install | denied | off | on
  me: null, household: null, secret: null, session: null,
  members: [], chores: [], rotation: [], overrides: [], done: [], swaps: [],
  activities: [], actRsvps: [], dinners: [], dinRsvps: [],
};

// ───────── Helpers ─────────
const DAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => iso(new Date());
function dayLabel(s) {
  if (s === today()) return 'vandaag';
  if (s === addIso(today(), 1)) return 'morgen';
  const d = new Date(s + 'T12:00:00');
  return `${DAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}
const timeFmt = (ts) => (ts ? new Date(ts).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const ago = (ts) => {
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  return m < 1 ? 'zojuist' : m < 60 ? `${m} min geleden` : m < 1440 ? `${Math.round(m / 60)} uur geleden` : `${Math.round(m / 1440)} d geleden`;
};
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove('show'), 2600);
}
const ZONES = { home: 'thuis', nearby: 'in de buurt', away: 'weg', unknown: '?' };
const OUT_HOURS = 12; // "wil uit" verloopt vanzelf, anders blijft het dagen staan
const outActive = (m) => m.out_status !== 'none' && (!m.out_until || new Date(m.out_until) > new Date());
const memberName = (id) => state.members.find((m) => m.id === id)?.name || '?';
const names = (ids, max = 6) => {
  const n = ids.map(memberName).filter((x) => x !== '?');
  if (!n.length) return '–';
  return n.length > max ? `${n.slice(0, max).join(', ')} +${n.length - max}` : n.join(', ');
};

// ───────── Rooster (berekend met rota.js, geen cron nodig) ─────────
const rotOf = (c) => state.rotation.filter((r) => r.chore_id === c.id).sort((a, b) => a.position - b.position).map((r) => r.member_id);
const holdersOf = (c, p) => holders(c, p, rotOf(c), state.overrides);
const curPeriod = (c) => Math.max(0, periodOf(c, today()));
const isDone = (c, h) => state.done.find((d) => d.chore_id === c.id && d.period_start === h.ps && d.slot === h.slot);

// ───────── Data ─────────
async function ensureSession() {
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session;
  const r = await sb.auth.signInAnonymously();
  if (r.error) throw r.error;
  return r.data.session;
}

async function loadAll() {
  const t = today();
  const since = addIso(t, -35);
  const actSince = new Date(Date.now() - 6 * 3600e3).toISOString(); // activiteiten van vandaag blijven nog even staan
  const res = await Promise.all([
    sb.from('members').select('*').order('created_at'),
    sb.from('chores').select('*').order('created_at'),
    sb.from('chore_rotation').select('*'),
    sb.from('chore_overrides').select('*').gte('period_start', since),
    sb.from('chore_done').select('*').gte('period_start', since),
    sb.from('swap_requests').select('*').eq('status', 'open'),
    sb.from('activities').select('*').or(`starts_at.is.null,starts_at.gte.${actSince}`).order('starts_at', { nullsFirst: false }).limit(50),
    sb.from('activity_rsvps').select('*'),
    sb.from('dinners').select('*').gte('day', t).order('day').limit(14),
    sb.from('dinner_rsvps').select('*'),
  ]);
  const err = res.find((r) => r.error)?.error;
  if (err) throw err;
  const [m, c, r, o, d, s, a, ar, dn, dr] = res.map((x) => x.data);
  Object.assign(state, { members: m, chores: c, rotation: r, overrides: o, done: d, swaps: s, activities: a, actRsvps: ar, dinners: dn, dinRsvps: dr });
  state.me = state.members.find((x) => x.id === state.session.user.id) || null;
  if (state.me) {
    const [h, sec] = await Promise.all([sb.from('households').select('*').maybeSingle(), sb.from('member_secrets').select('token').maybeSingle()]);
    state.household = h.data;
    state.secret = sec.data?.token || null;
  }
}

let refreshTimer;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => { try { await loadAll(); render(true); } catch { /* volgende update probeert opnieuw */ } }, 250);
}

function subscribe() {
  const ch = sb.channel('huis');
  ['members', 'chores', 'chore_rotation', 'chore_overrides', 'chore_done', 'swap_requests', 'activities', 'activity_rsvps', 'dinners', 'dinner_rsvps']
    .forEach((table) => ch.on('postgres_changes', { event: '*', schema: 'public', table }, refreshSoon));
  ch.subscribe((status) => $('#conn').classList.toggle('live', status === 'SUBSCRIBED'));
}

// Voert een schrijfactie uit; geeft de data (of true) terug bij succes, anders false.
async function run(promise, okMsg) {
  const { data, error } = await promise;
  if (error) { toast('Mislukt: ' + error.message); return false; }
  if (okMsg) toast(okMsg);
  try { await loadAll(); } catch { /* realtime haalt het later op */ }
  render();
  return data ?? true;
}

// Push naar huisgenoten. De Edge Function bouwt de tekst zelf op uit de database.
const notify = (type, extra = {}) => sb.functions.invoke('notify', { body: { type, ...extra } }).catch(() => {});

// ───────── Pushmeldingen ─────────
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

async function currentSub() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function detectPush() {
  if (!VAPID_PUBLIC_KEY) return 'unconfigured';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIos && !standalone ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && (await currentSub()) ? 'on' : 'off';
}
async function saveSub(sub) {
  const j = sub.toJSON();
  const { error } = await sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  if (error) toast('Opslaan mislukt: ' + error.message);
  return !error;
}
async function enablePush() {
  try {
    // iOS: requestPermission moet direct in de klik gebeuren, dus dit is de eerste await.
    if ((await Notification.requestPermission()) !== 'granted') { state.push = await detectPush(); render(); return toast('Meldingen niet toegestaan'); }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID_PUBLIC_KEY) }));
    if (!(await saveSub(sub))) return;
    state.push = 'on'; render(); toast('Meldingen staan aan');
  } catch (e) { toast('Aanzetten mislukt: ' + (e.message || e)); }
}
async function disablePush() {
  const sub = await currentSub();
  if (sub) {
    await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  }
  state.push = 'off'; render(); toast('Meldingen staan uit');
}
async function testPush() {
  const { data, error } = await sb.functions.invoke('notify', { body: { type: 'test' } });
  if (error) return toast('Mislukt: ' + error.message);
  toast(data?.sent ? 'Testmelding verstuurd' : 'Geen toestel gevonden; zet meldingen opnieuw aan');
}

// ───────── Zone (alleen grove zone, coördinaten verlaten je telefoon nooit) ─────────
const dist = (a, b) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const getPos = () => new Promise((res, rej) => navigator.geolocation.getCurrentPosition(
  (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }), rej, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }));

async function setZone(zone) {
  await run(sb.from('members').update({ zone, zone_updated_at: new Date().toISOString() }).eq('id', state.me.id), `Zone: ${ZONES[zone]}`);
}
async function locate() {
  try {
    const home = JSON.parse(store.get('homePos') || 'null');
    if (!home) return toast('Zet eerst "Dit is thuis" in het Ik-tabblad');
    const d = dist(await getPos(), home);
    await setZone(d < 150 ? 'home' : d < 2500 ? 'nearby' : 'away');
  } catch { toast('Locatie niet beschikbaar'); }
}
async function saveHome() {
  try { store.set('homePos', JSON.stringify(await getPos())); toast('Thuislocatie opgeslagen (alleen op dit toestel)'); } catch { toast('Locatie niet beschikbaar'); }
}

// ───────── Views ─────────
function viewSetup() {
  return `<div class="card"><h2 style="margin-top:0">Nog niet gekoppeld</h2>
    <p class="muted">Deze app is nog niet verbonden met een Supabase-project. Volg de stappen in de README van de repository.</p></div>`;
}

function viewOnboarding() {
  return `<div class="card"><h2 style="margin-top:0">Welkom</h2>
    <p class="muted">Start een nieuw huis (jij wordt beheerder), of sluit aan met de code van een huisgenoot.</p>
    <form data-form="create"><input name="household" placeholder="Naam van het huis" required maxlength="60">
      <input name="name" placeholder="Jouw naam" required maxlength="30"><input name="emoji" placeholder="Emoji (bijv. 🦊)" maxlength="8">
      <button class="primary">Nieuw huis starten</button></form></div>
    <div class="card"><form data-form="join"><input name="code" placeholder="Uitnodigingscode" required autocapitalize="characters" autocomplete="off">
      <input name="name" placeholder="Jouw naam" required maxlength="30"><input name="emoji" placeholder="Emoji" maxlength="8">
      <button>Aansluiten</button></form></div>`;
}

function swapCards() {
  const chore = (id) => state.chores.find((c) => c.id === id);
  const inc = state.swaps.filter((s) => s.to_member === state.me.id).map((s) => `<div class="card today"><b>${esc(memberName(s.from_member))}</b> vraagt of jij <b>${esc(chore(s.chore_id)?.name)}</b> overneemt (${dayLabel(s.period_start)}).
    <div class="row wrap" style="margin-top:8px"><button class="primary" data-act="swap" data-id="${s.id}" data-ans="accept">Ja, ik doe het</button>
    <button data-act="swap" data-id="${s.id}" data-ans="decline">Nee</button></div></div>`).join('');
  const out = state.swaps.filter((s) => s.from_member === state.me.id).map((s) => `<div class="card muted">Ruilverzoek aan ${esc(memberName(s.to_member))} (${esc(chore(s.chore_id)?.name)}, ${dayLabel(s.period_start)}) wacht op antwoord.
    <button data-act="swap" data-id="${s.id}" data-ans="cancel">Intrekken</button></div>`).join('');
  return inc + out;
}

function choreCard(c) {
  const p = curPeriod(c);
  const started = today() >= c.start_date;
  const hs = holdersOf(c, p);
  const rows = hs.map((h) => {
    const d = isDone(c, h);
    const mine = h.id === state.me.id;
    const pending = state.swaps.some((s) => s.chore_id === c.id && s.period_start === h.ps && s.slot === h.slot && s.from_member === state.me.id);
    return `<div class="row"><span class="grow"><b>${esc(memberName(h.id))}</b>${h.over ? ' <span class="chip">aangepast</span>' : ''}${mine ? ' <span class="chip warn">jij</span>' : ''}</span>
      ${d ? '<span class="chip home">✔ klaar</span>' : ''}
      ${(mine || state.me.is_admin) && started ? `<button data-act="done" data-chore="${c.id}" data-ps="${h.ps}" data-slot="${h.slot}">${d ? 'Ongedaan' : '✔ Klaar'}</button>` : ''}
      ${mine && !d && !pending ? `<button data-act="swapform" data-chore="${c.id}" data-ps="${h.ps}" data-slot="${h.slot}">↔ Ruil</button>` : ''}</div>
      <div id="sw-${c.id}-${h.slot}"></div>`;
  }).join('');
  const upcoming = [1, 2, 3].map((k) => `${dayLabel(periodStart(c, p + k))}: ${esc(names(holdersOf(c, p + k).map((h) => h.id), 3))}`).join(' · ');
  const n = rotOf(c).length;
  const full = Array.from({ length: Math.max(1, Math.ceil(n / c.team_size)) }, (_, k) => {
    const hh = holdersOf(c, p + k);
    return `<div class="row"><span class="muted" style="width:76px">${dayLabel(periodStart(c, p + k))}</span><span class="grow">${esc(names(hh.map((h) => h.id), 3))}</span></div>`;
  }).join('');
  return `<div class="card ${hs.some((h) => h.id === state.me.id) ? 'today' : ''}"><div class="dayhead"><b>${esc(c.emoji)} ${esc(c.name)}</b>
    <span class="muted">${started ? `t/m ${dayLabel(periodEnd(c, p))}` : `start ${dayLabel(c.start_date)}`}</span></div>${rows}
    <div class="muted" style="margin-top:6px">Daarna: ${upcoming}</div>
    <details><summary class="muted">Volledig rooster (${n} personen)</summary>${full}</details></div>`;
}

function viewHome() {
  const chores = state.chores.map(choreCard).join('') || `<p class="muted">Nog geen taken. ${state.me.is_admin ? 'Voeg er een toe in het Ik-tabblad.' : 'Een beheerder kan taken toevoegen.'}</p>`;
  const people = state.members.map((m) => `<div class="row"><span class="big">${esc(m.emoji)}</span>
    <div class="grow"><b>${esc(m.name)}</b><div class="muted">${ago(m.zone_updated_at)}</div></div>
    <span class="chip ${m.zone}">${ZONES[m.zone]}</span></div>`).join('');
  const home = state.members.filter((m) => m.zone === 'home').length;
  const mine = ['home', 'nearby', 'away'].map((z) => `<button data-act="zone" data-zone="${z}" class="${state.me.zone === z ? 'on' : ''}">${ZONES[z]}</button>`).join('');
  return `${swapCards()}<h2>Beurten</h2>${chores}
    <h2>Wie is thuis? (${home}/${state.members.length})</h2>
    <div class="card"><div class="row wrap">${mine}<button data-act="locate">📍 Bepaal zone</button></div></div>
    <details class="card" open><summary class="muted">Huisgenoten</summary>${people}</details>`;
}

function viewUit() {
  const mine = state.me;
  const others = state.members.filter((m) => m.id !== mine.id && outActive(m));
  const list = others.map((m) => `<div class="card"><div class="row"><span class="big">${esc(m.emoji)}</span>
    <div class="grow"><b>${esc(m.name)}</b> ${m.out_status === 'going' ? 'gaat' : 'wil'} uit${m.out_place ? ` · ${esc(m.out_place)}` : ''}
    <div class="muted">${esc(m.out_note)}</div></div>
    <button data-act="joinout" data-id="${m.id}">Ik ook</button></div></div>`).join('') || '<p class="muted">Niemand heeft nu plannen.</p>';
  const now = !outActive(mine) ? 'geen plannen' : mine.out_status === 'wants' ? 'wil uit' : 'gaat uit';
  return `<h2>Mijn status</h2><div class="card"><form data-form="out">
    <input name="place" placeholder="Waar? (bijv. stad, bioscoop)" maxlength="80" value="${esc(outActive(mine) ? mine.out_place : '')}">
    <input name="note" placeholder="Opmerking" maxlength="200" value="${esc(outActive(mine) ? mine.out_note : '')}">
    <div class="row wrap"><button class="primary" name="status" value="wants">Ik wil uit</button>
    <button name="status" value="going">Ik ga uit</button><button name="status" value="none">Niet meer</button></div></form>
    <p class="muted">Nu: ${now}</p></div>
    <h2>Huisgenoten</h2>${list}`;
}

function rsvpButtons(kind, id, mineAnswer) {
  return ['mee', 'misschien', 'niet'].map((a) => `<button data-act="${kind}" data-id="${id}" data-ans="${a}" class="${mineAnswer === a ? 'on' : ''}">${a === 'mee' ? '👍 mee' : a === 'niet' ? '👎 niet' : '🤔 misschien'}</button>`).join('');
}

function viewActiviteiten() {
  const items = state.activities.map((a) => {
    const r = state.actRsvps.filter((x) => x.activity_id === a.id);
    const my = r.find((x) => x.member_id === state.me.id)?.answer;
    const mee = r.filter((x) => x.answer === 'mee').map((x) => x.member_id);
    return `<div class="card"><div class="dayhead"><b>${esc(a.title)}</b><span class="muted">${timeFmt(a.starts_at)}</span></div>
      <div class="muted">${esc(a.note)}</div>
      <div class="row wrap" style="margin:8px 0">${rsvpButtons('arsvp', a.id, my)}</div>
      <div class="muted"><b>${mee.length}</b> mee: ${esc(names(mee, 8))}</div>
      ${a.created_by === state.me.id || state.me.is_admin ? `<button data-act="delact" data-id="${a.id}">Verwijderen</button>` : ''}</div>`;
  }).join('') || '<p class="muted">Nog geen activiteiten. Voeg er een toe: film, spelletjes, klussen…</p>';
  return `<h2>Nieuwe activiteit</h2><div class="card"><form data-form="activity">
    <input name="title" placeholder="Wat? (filmavond, Catan, tuin opruimen)" required maxlength="120">
    <input name="starts_at" type="datetime-local"><input name="note" placeholder="Opmerking" maxlength="500"><button class="primary">Toevoegen</button></form></div>
    <h2>Thuis-activiteiten</h2>${items}`;
}

function viewEten() {
  const days = Array.from({ length: 7 }, (_, i) => addIso(today(), i));
  return days.map((day) => {
    const d = state.dinners.find((x) => x.day === day);
    const r = d ? state.dinRsvps.filter((x) => x.dinner_id === d.id) : [];
    const my = r.find((x) => x.member_id === state.me.id);
    const eaters = r.filter((x) => x.answer === 'mee');
    const total = eaters.reduce((s, x) => s + 1 + x.guests, 0);
    const open = state.members.length - r.length;
    return `<div class="card ${day === today() ? 'today' : ''}"><div class="dayhead"><b>${dayLabel(day)}</b>
      <span class="chip">${total} eters</span></div>
      <div>${d?.menu ? '🍽️ ' + esc(d.menu) : '<span class="muted">Nog geen menu</span>'}${d?.cook_id ? ` · kok: ${esc(memberName(d.cook_id))}` : ''}</div>
      <div class="row wrap" style="margin:8px 0">${rsvpButtons('drsvp', day, my?.answer)}
      <button data-act="guest" data-id="${day}">+gast (${my?.guests || 0})</button></div>
      <div class="muted">Mee: ${esc(names(eaters.map((x) => x.member_id), 8))} · nog niet gereageerd: ${open}</div>
      <details><summary class="muted">Menu / kok</summary><form data-form="dinner" data-day="${day}">
        <input name="menu" placeholder="Wat eten we?" maxlength="120" value="${esc(d?.menu)}">
        <select name="cook"><option value="">Wie kookt?</option>${state.members.map((m) => `<option value="${m.id}" ${d?.cook_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
        <button>Opslaan</button></form></details></div>`;
  }).join('');
}

function viewPush() {
  const why = '<p class="muted">Je krijgt een melding als jouw beurt eraan komt, iemand met je wil ruilen, een huisgenoot uit wil, een activiteit plant of het avondeten invult.</p>';
  const body = {
    unknown: '<p class="muted">Bezig met controleren…</p>',
    unconfigured: '<p class="muted">Meldingen zijn nog niet ingesteld op de server.</p>',
    unsupported: '<p class="muted">Deze browser ondersteunt geen meldingen.</p>',
    'needs-install': '<p>Op iPhone werken meldingen alleen vanaf het beginscherm: Safari → Deel → <b>Zet op beginscherm</b>. Open Thuis daarna via het icoon.</p>',
    denied: '<p>Meldingen zijn geblokkeerd. Zet ze aan via de instellingen van je telefoon (Meldingen → Thuis) en open de app opnieuw.</p>',
    off: '<button class="primary" data-act="pushon">🔔 Meldingen aanzetten</button>',
    on: '<p>✅ Meldingen staan aan op dit toestel.</p><div class="row wrap"><button data-act="pushtest">Testmelding</button><button data-act="pushoff">Uitzetten</button></div>',
  }[state.push];
  return `<h2>Meldingen</h2><div class="card">${why}${body}</div>`;
}

function adminPanel() {
  const chores = state.chores.map((c) => {
    const list = rotOf(c).map((id, i) => `<div class="row"><span class="muted" style="width:24px">${i + 1}</span><span class="grow">${esc(memberName(id))}</span>
      <button data-act="move" data-chore="${c.id}" data-member="${id}" data-dir="-1" aria-label="omhoog">↑</button>
      <button data-act="move" data-chore="${c.id}" data-member="${id}" data-dir="1" aria-label="omlaag">↓</button></div>`).join('');
    const opts = state.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    const slots = Array.from({ length: c.team_size }, (_, s) => `<option value="${s}">plek ${s + 1}</option>`).join('');
    return `<details class="card"><summary><b>${esc(c.emoji)} ${esc(c.name)}</b> <span class="muted">(${c.period_days} d, ${c.team_size} p.)</span></summary>
      <p class="muted">Volgorde van de rotatie:</p>${list}
      <form data-form="override" data-chore="${c.id}"><p class="muted">Beurt van deze periode handmatig overschrijven:</p>
        <select name="member">${opts}</select>${c.team_size > 1 ? `<select name="slot">${slots}</select>` : ''}<button>Overschrijf huidige beurt</button></form>
      <button data-act="delchore" data-id="${c.id}">Taak verwijderen</button></details>`;
  }).join('');
  const people = state.members.map((m) => `<div class="row"><span class="grow">${esc(m.emoji)} ${esc(m.name)} ${m.is_admin ? '<span class="chip">beheerder</span>' : ''}</span>
    ${m.id === state.me.id ? '' : `<button data-act="admin" data-id="${m.id}" data-val="${!m.is_admin}">${m.is_admin ? 'Geen beheerder' : 'Beheerder'}</button>
    <button data-act="rmmember" data-id="${m.id}">Verwijder</button>`}</div>`).join('');
  return `<h2>Beheer: taken</h2>${chores}
    <div class="card"><form data-form="chore"><input name="name" placeholder="Nieuwe taak (bijv. Afval buiten zetten)" required maxlength="60">
      <input name="emoji" placeholder="Emoji" maxlength="8" value="🗑️">
      <label class="muted">Eerste beurt begint op</label><input name="start" type="date" value="${today()}" required>
      <label class="muted">Dagen per beurt</label><input name="period" type="number" min="1" max="31" value="7" required>
      <label class="muted">Personen per beurt</label><input name="team" type="number" min="1" max="5" value="1" required>
      <button class="primary">Taak toevoegen (alle ${state.members.length} huisgenoten in de rotatie)</button></form></div>
    <h2>Beheer: huisgenoten</h2><div class="card">${people}</div>`;
}

function viewIk() {
  const hook = `${SUPABASE_URL}/rest/v1/rpc/set_zone_by_token`;
  return `<div class="card"><b>${esc(state.me.emoji)} ${esc(state.me.name)}</b> · ${esc(state.household?.name)} ${state.me.is_admin ? '<span class="chip">beheerder</span>' : ''}
    <p class="muted">Uitnodigingscode voor huisgenoten: <b class="code">${esc(state.household?.join_code)}</b></p></div>
    ${viewPush()}
    <h2>Locatie</h2><div class="card"><p class="muted">Je precieze locatie wordt nooit opgeslagen. Alleen de zone (thuis / buurt / weg).</p>
    <button data-act="sethome">📍 Dit is thuis</button></div>
    <h2>Automatisch (iOS Shortcuts / Android)</h2><div class="card">
    <p class="muted">Maak een persoonlijke automation "Aankomen bij thuis" met actie <b>URL ophalen</b>, methode POST:</p>
    <p class="muted">URL</p><code>${esc(hook)}</code>
    <p class="muted">Header <b>apikey</b></p><code>${esc(SUPABASE_KEY)}</code>
    <p class="muted">Header <b>Content-Type</b>: application/json. Body (JSON):</p><code>{"p_token":"${esc(state.secret)}","p_zone":"home"}</code>
    <p class="muted">Maak er nog een voor "Vertrekken" met <b>"away"</b>. Deel je token met niemand.</p></div>
    ${state.me.is_admin ? adminPanel() : ''}`;
}

const VIEWS = { home: viewHome, uit: viewUit, activiteiten: viewActiviteiten, eten: viewEten, ik: viewIk };

function render(skipIfBusy = false) {
  const onboarding = !state.me;
  $('#tabs').hidden = onboarding;
  $('#title').textContent = state.household?.name || 'Thuis';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  // Realtime-update mag typen of een open formulier niet onderbreken.
  if (skipIfBusy && (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || $('#view form details[open], #view details[open] form, #view [id^="sw-"] form'))) return;
  $('#view').innerHTML = onboarding ? viewOnboarding() : (VIEWS[state.tab] || viewHome)();
}

// ───────── Acties ─────────
async function ensureDinner(day) {
  const d = state.dinners.find((x) => x.day === day);
  if (d) return d;
  const r = await sb.from('dinners').upsert({ day }, { onConflict: 'household_id,day' }).select().single();
  if (r.error) { toast(r.error.message); return null; }
  return r.data;
}
const outUntil = () => new Date(Date.now() + OUT_HOURS * 3600e3).toISOString();
function setTab(tab) { state.tab = tab; store.set('tab', tab); history.replaceState(null, '', '#' + tab); render(); }

const actions = {
  tab(el) { setTab(el.dataset.tab); },
  zone(el) { return setZone(el.dataset.zone); },
  locate, sethome: saveHome,
  pushon: enablePush, pushoff: disablePush, pushtest: testPush,
  async joinout(el) {
    const o = state.members.find((m) => m.id === el.dataset.id);
    if (await run(sb.from('members').update({ out_status: 'going', out_place: o.out_place, out_note: o.out_note, out_until: o.out_until || outUntil() }).eq('id', state.me.id), 'Top, je gaat mee')) notify('out');
  },
  arsvp(el) { return run(sb.from('activity_rsvps').upsert({ activity_id: el.dataset.id, answer: el.dataset.ans }, { onConflict: 'activity_id,member_id' })); },
  delact(el) { if (confirm('Activiteit verwijderen?')) return run(sb.from('activities').delete().eq('id', el.dataset.id), 'Verwijderd'); },
  async drsvp(el) {
    const d = await ensureDinner(el.dataset.id); if (!d) return;
    const cur = state.dinRsvps.find((x) => x.dinner_id === d.id && x.member_id === state.me.id);
    return run(sb.from('dinner_rsvps').upsert({ dinner_id: d.id, answer: el.dataset.ans, guests: cur?.guests || 0 }, { onConflict: 'dinner_id,member_id' }));
  },
  async guest(el) {
    const d = await ensureDinner(el.dataset.id); if (!d) return;
    const cur = state.dinRsvps.find((x) => x.dinner_id === d.id && x.member_id === state.me.id);
    const guests = ((cur?.guests || 0) + 1) % 6; // 0..5, daarna weer 0
    return run(sb.from('dinner_rsvps').upsert({ dinner_id: d.id, answer: cur?.answer || 'mee', guests }, { onConflict: 'dinner_id,member_id' }));
  },
  // — rooster —
  done(el) {
    const { chore, ps } = el.dataset; const slot = Number(el.dataset.slot);
    const existing = state.done.find((d) => d.chore_id === chore && d.period_start === ps && d.slot === slot);
    return existing
      ? run(sb.from('chore_done').delete().eq('chore_id', chore).eq('period_start', ps).eq('slot', slot), 'Ongedaan gemaakt')
      : run(sb.from('chore_done').insert({ chore_id: chore, period_start: ps, slot }), 'Top, afgevinkt');
  },
  swapform(el) {
    const { chore, ps, slot } = el.dataset;
    const box = document.getElementById(`sw-${chore}-${slot}`);
    const opts = state.members.filter((m) => m.id !== state.me.id).map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    box.innerHTML = `<form data-form="swap" data-chore="${chore}" data-ps="${ps}" data-slot="${slot}"><select name="to" aria-label="Met wie ruilen?">${opts}</select>
      <div class="row wrap"><button class="primary">Vraag ruil aan</button><button type="button" data-act="swapclose">Annuleren</button></div></form>`;
  },
  swapclose(el) { el.closest('form').remove(); },
  async swap(el) {
    const ok = await run(sb.rpc('respond_swap', { p_id: el.dataset.id, p_action: el.dataset.ans }), { accept: 'Beurt overgenomen', decline: 'Geweigerd', cancel: 'Ingetrokken' }[el.dataset.ans]);
    if (ok && el.dataset.ans !== 'cancel') notify('swap', { id: el.dataset.id });
  },
  move(el) { return run(sb.rpc('move_rotation', { p_chore: el.dataset.chore, p_member: el.dataset.member, p_dir: Number(el.dataset.dir) })); },
  delchore(el) { if (confirm('Taak en rooster verwijderen?')) return run(sb.from('chores').delete().eq('id', el.dataset.id), 'Taak verwijderd'); },
  admin(el) { return run(sb.rpc('set_admin', { p_member: el.dataset.id, p_value: el.dataset.val === 'true' })); },
  rmmember(el) { if (confirm(`${memberName(el.dataset.id)} uit het huis verwijderen?`)) return run(sb.from('members').delete().eq('id', el.dataset.id), 'Verwijderd'); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});
addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS.includes(t) && t !== state.tab && state.me) setTab(t); });

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  const btn = e.submitter; if (btn) btn.disabled = true; // dubbel tikken = één actie
  try {
    const v = Object.fromEntries(new FormData(f));
    const kind = f.dataset.form;
    if (kind === 'create' || kind === 'join') {
      const r = kind === 'create'
        ? await sb.rpc('create_household', { p_household: v.household, p_name: v.name, p_emoji: v.emoji })
        : await sb.rpc('join_household', { p_code: v.code, p_name: v.name, p_emoji: v.emoji });
      if (r.error) return toast(r.error.message);
      await loadAll(); state.push = await detectPush(); render();
      toast(kind === 'create' ? 'Huis aangemaakt. De code voor huisgenoten staat in tab Ik.' : 'Aangesloten');
    } else if (kind === 'out') {
      const status = btn?.value || 'wants';
      const ok = await run(sb.from('members').update({
        out_status: status, out_place: status === 'none' ? null : v.place || null, out_note: status === 'none' ? null : v.note || null,
        out_until: status === 'none' ? null : outUntil(),
      }).eq('id', state.me.id), 'Status bijgewerkt');
      if (ok && status !== 'none') notify('out');
    } else if (kind === 'activity') {
      const a = await run(sb.from('activities').insert({ title: v.title, note: v.note || null, starts_at: v.starts_at ? new Date(v.starts_at).toISOString() : null }).select('id').single(), 'Toegevoegd');
      if (a) notify('activity', { id: a.id });
    } else if (kind === 'dinner') {
      const day = f.dataset.day;
      const old = state.dinners.find((x) => x.day === day);
      const ok = await run(sb.from('dinners').upsert({ day, menu: v.menu || null, cook_id: v.cook || null }, { onConflict: 'household_id,day' }), 'Opgeslagen');
      if (ok && v.menu && (v.menu !== old?.menu || (v.cook || null) !== (old?.cook_id || null))) notify('dinner', { day });
    } else if (kind === 'chore') {
      await run(sb.rpc('create_chore', { p_name: v.name, p_emoji: v.emoji, p_start: v.start, p_period: Number(v.period), p_team: Number(v.team) }), 'Taak toegevoegd');
    } else if (kind === 'swap') {
      const s = await run(sb.from('swap_requests').insert({ chore_id: f.dataset.chore, period_start: f.dataset.ps, slot: Number(f.dataset.slot), to_member: v.to }).select('id').single(), 'Ruilverzoek verstuurd');
      if (s) notify('swap', { id: s.id });
    } else if (kind === 'override') {
      const c = state.chores.find((x) => x.id === f.dataset.chore);
      await run(sb.from('chore_overrides').upsert(
        { chore_id: c.id, period_start: periodStart(c, curPeriod(c)), slot: Number(v.slot || 0), member_id: v.member, reason: 'handmatig' },
        { onConflict: 'chore_id,period_start,slot' }), 'Beurt aangepast');
    }
  } finally { if (btn?.isConnected) btn.disabled = false; }
});

// ───────── Start ─────────
(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!sb) { $('#view').innerHTML = viewSetup(); return; }
  try {
    state.session = await ensureSession();
    await loadAll(); render(); subscribe();
    state.push = await detectPush(); if (state.tab === 'ik') render();
    if (state.push === 'on' && state.me) currentSub().then((s) => s && saveSub(s)); // server-kant up-to-date houden
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSoon(); });
  } catch (err) {
    $('#view').innerHTML = `<div class="card"><b>Kan niet verbinden</b><p class="muted">${esc(err.message || err)}</p>
      <button onclick="location.reload()">Opnieuw proberen</button></div>`;
  }
})();
