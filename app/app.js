import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privémodus */ } },
};

const state = {
  tab: store.get('tab') || 'home',
  me: null, household: null, secret: null,
  members: [], waste: [], activities: [], actRsvps: [], dinners: [], dinRsvps: [],
};

// ───────── Helpers ─────────
const DAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
function dayLabel(s) {
  const t = iso(new Date());
  if (s === t) return 'vandaag';
  if (s === iso(addDays(1))) return 'morgen';
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
  clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove('show'), 2200);
}
const WASTE = { rest: ['🗑️', 'Restafval'], gft: ['🥬', 'GFT'], pmd: ['🧴', 'PMD'], papier: ['📰', 'Papier'], glas: ['🍾', 'Glas'], overig: ['♻️', 'Overig'] };
const ZONES = { home: 'thuis', nearby: 'in de buurt', away: 'weg', unknown: '?' };

// ───────── Data ─────────
async function ensureSession() {
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session;
  const r = await sb.auth.signInAnonymously();
  if (r.error) throw r.error;
  return r.data.session;
}

async function loadAll() {
  const today = iso(new Date());
  const [m, w, a, ar, d, dr] = await Promise.all([
    sb.from('members').select('*').order('created_at'),
    sb.from('waste_events').select('*').gte('day', today).order('day').limit(40),
    sb.from('activities').select('*').order('starts_at', { nullsFirst: false }).limit(50),
    sb.from('activity_rsvps').select('*'),
    sb.from('dinners').select('*').gte('day', today).order('day').limit(14),
    sb.from('dinner_rsvps').select('*'),
  ]);
  state.members = m.data || []; state.waste = w.data || [];
  state.activities = a.data || []; state.actRsvps = ar.data || [];
  state.dinners = d.data || []; state.dinRsvps = dr.data || [];
  state.me = state.members.find((x) => x.id === state.session.user.id) || null;
  if (state.me) {
    const h = await sb.from('households').select('*').maybeSingle();
    state.household = h.data;
    const s = await sb.from('member_secrets').select('token').maybeSingle();
    state.secret = s.data?.token || null;
  }
}

let refreshTimer;
function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(async () => { await loadAll(); render(true); }, 250); }

function subscribe() {
  const ch = sb.channel('huis');
  ['members', 'activities', 'activity_rsvps', 'dinners', 'dinner_rsvps', 'waste_events'].forEach((table) =>
    ch.on('postgres_changes', { event: '*', schema: 'public', table }, refreshSoon));
  ch.subscribe((status) => $('#conn').classList.toggle('live', status === 'SUBSCRIBED'));
}

async function run(promise, okMsg) {
  const { error } = await promise;
  if (error) { toast('Mislukt: ' + error.message); return false; }
  if (okMsg) toast(okMsg);
  await loadAll(); render(); return true;
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
function viewOnboarding() {
  return `<div class="card"><h2 style="margin-top:0">Welkom</h2>
    <p class="muted">Start een nieuw huishouden, of sluit aan met de code van een huisgenoot.</p>
    <form data-form="create"><input name="household" placeholder="Naam huishouden" required>
      <input name="name" placeholder="Jouw naam" required><input name="emoji" placeholder="Emoji (bijv. 🦊)" maxlength="4">
      <button class="primary">Nieuw huishouden starten</button></form></div>
    <div class="card"><form data-form="join"><input name="code" placeholder="Uitnodigingscode" required autocapitalize="characters">
      <input name="name" placeholder="Jouw naam" required><input name="emoji" placeholder="Emoji" maxlength="4">
      <button>Aansluiten</button></form></div>`;
}

function viewHome() {
  const next = state.waste.slice(0, 4).map((w) => {
    const [ic, nm] = WASTE[w.kind] || WASTE.overig; const l = dayLabel(w.day);
    const soon = l === 'vandaag' || l === 'morgen';
    return `<div class="row"><span class="big">${ic}</span><div class="grow">${esc(w.label || nm)}</div><span class="chip ${soon ? 'warn' : ''}">${l}</span></div>`;
  }).join('') || '<p class="muted">Nog geen afvaldata. Draai de afval-sync (zie plan).</p>';
  const people = state.members.map((m) => `<div class="row"><span class="big">${esc(m.emoji)}</span>
    <div class="grow"><b>${esc(m.name)}</b><div class="muted">${ago(m.zone_updated_at)}</div></div>
    <span class="chip ${m.zone}">${ZONES[m.zone]}</span></div>`).join('');
  const mine = ['home', 'nearby', 'away'].map((z) => `<button data-act="zone" data-zone="${z}" class="${state.me.zone === z ? 'on' : ''}">${ZONES[z]}</button>`).join('');
  return `<h2>Afval</h2><div class="card">${next}</div>
    <h2>Wie is thuis?</h2><div class="card">${people}</div>
    <div class="card"><div class="row wrap">${mine}<button data-act="locate">📍 Bepaal zone</button></div></div>`;
}

function viewUit() {
  const mine = state.me;
  const others = state.members.filter((m) => m.id !== mine.id && m.out_status !== 'none');
  const list = others.map((m) => `<div class="card"><div class="row"><span class="big">${esc(m.emoji)}</span>
    <div class="grow"><b>${esc(m.name)}</b> ${m.out_status === 'going' ? 'gaat' : 'wil'} uit${m.out_place ? ` · ${esc(m.out_place)}` : ''}
    <div class="muted">${esc(m.out_note || '')} ${m.out_until ? '· tot ' + timeFmt(m.out_until) : ''}</div></div>
    <button data-act="joinout" data-id="${m.id}">Ik ook</button></div></div>`).join('') || '<p class="muted">Niemand heeft nu plannen.</p>';
  return `<h2>Mijn status</h2><div class="card"><form data-form="out">
    <input name="place" placeholder="Waar? (bijv. stad, bioscoop)" value="${esc(mine.out_place || '')}">
    <input name="note" placeholder="Opmerking" value="${esc(mine.out_note || '')}">
    <div class="row wrap"><button class="primary" name="status" value="wants">Ik wil uit</button>
    <button name="status" value="going">Ik ga uit</button><button name="status" value="none">Niet meer</button></div></form>
    <p class="muted">Nu: ${mine.out_status === 'none' ? 'geen plannen' : mine.out_status === 'wants' ? 'wil uit' : 'gaat uit'}</p></div>
    <h2>Huisgenoten</h2>${list}`;
}

function rsvpButtons(kind, id, mineAnswer) {
  return ['mee', 'misschien', 'niet'].map((a) => `<button data-act="${kind}" data-id="${id}" data-ans="${a}" class="${mineAnswer === a ? 'on' : ''}">${a === 'mee' ? '👍 mee' : a === 'niet' ? '👎 niet' : '🤔 misschien'}</button>`).join('');
}
const names = (ids) => ids.map((i) => state.members.find((m) => m.id === i)?.name).filter(Boolean).join(', ') || '–';

function viewActiviteiten() {
  const items = state.activities.map((a) => {
    const r = state.actRsvps.filter((x) => x.activity_id === a.id);
    const my = r.find((x) => x.member_id === state.me.id)?.answer;
    return `<div class="card"><div class="dayhead"><b>${esc(a.title)}</b><span class="muted">${timeFmt(a.starts_at)}</span></div>
      <div class="muted">${esc(a.note || '')}</div>
      <div class="row wrap" style="margin:8px 0">${rsvpButtons('arsvp', a.id, my)}</div>
      <div class="muted">Mee: ${esc(names(r.filter((x) => x.answer === 'mee').map((x) => x.member_id)))}</div>
      ${a.created_by === state.me.id ? `<button data-act="delact" data-id="${a.id}">Verwijderen</button>` : ''}</div>`;
  }).join('') || '<p class="muted">Nog geen activiteiten. Voeg er een toe: film, spelletjes, klussen…</p>';
  return `<h2>Nieuwe activiteit</h2><div class="card"><form data-form="activity">
    <input name="title" placeholder="Wat? (filmavond, Catan, tuin opruimen)" required>
    <input name="starts_at" type="datetime-local"><input name="note" placeholder="Opmerking"><button class="primary">Toevoegen</button></form></div>
    <h2>Thuis-activiteiten</h2>${items}`;
}

function viewEten() {
  const days = Array.from({ length: 7 }, (_, i) => iso(addDays(i)));
  return days.map((day) => {
    const d = state.dinners.find((x) => x.day === day);
    const r = d ? state.dinRsvps.filter((x) => x.dinner_id === d.id) : [];
    const my = r.find((x) => x.member_id === state.me.id);
    const eaters = r.filter((x) => x.answer === 'mee');
    const total = eaters.reduce((s, x) => s + 1 + x.guests, 0);
    return `<div class="card ${day === iso(new Date()) ? 'today' : ''}"><div class="dayhead"><b>${dayLabel(day)}</b>
      <span class="chip">${total} eters</span></div>
      <div>${d?.menu ? '🍽️ ' + esc(d.menu) : '<span class="muted">Nog geen menu</span>'}${d?.cook_id ? ` · kok: ${esc(names([d.cook_id]))}` : ''}</div>
      <div class="row wrap" style="margin:8px 0">${rsvpButtons('drsvp', day, my?.answer)}
      <button data-act="guest" data-id="${day}">+gast (${my?.guests || 0})</button></div>
      <div class="muted">Mee: ${esc(names(eaters.map((x) => x.member_id)))}</div>
      <details><summary class="muted">Menu / kok</summary><form data-form="dinner" data-day="${day}">
        <input name="menu" placeholder="Wat eten we?" value="${esc(d?.menu || '')}">
        <select name="cook"><option value="">Wie kookt?</option>${state.members.map((m) => `<option value="${m.id}" ${d?.cook_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
        <button>Opslaan</button></form></details></div>`;
  }).join('');
}

function viewIk() {
  const hook = state.secret ? `${SUPABASE_URL}/rest/v1/rpc/set_zone_by_token` : '';
  return `<div class="card"><b>${esc(state.me.emoji)} ${esc(state.me.name)}</b> · ${esc(state.household?.name || '')}
    <p class="muted">Uitnodigingscode voor huisgenoten: <b>${esc(state.household?.join_code || '')}</b></p></div>
    <h2>Locatie</h2><div class="card"><p class="muted">Je precieze locatie wordt nooit opgeslagen. Alleen de zone (thuis / buurt / weg).</p>
    <button data-act="sethome">📍 Dit is thuis</button></div>
    <h2>Automatisch (iOS Shortcuts / Android)</h2><div class="card"><p class="muted">Maak een persoonlijke automation "Aankomen bij thuis" met actie "URL ophalen" (POST, JSON):</p>
    <code style="word-break:break-all;font-size:.8rem">${esc(hook)}</code>
    <p class="muted">Header apikey = anon key. Body: {"p_token":"${esc(state.secret || '')}","p_zone":"home"}. Gebruik "away" bij vertrekken.</p></div>`;
}

const VIEWS = { home: viewHome, uit: viewUit, activiteiten: viewActiviteiten, eten: viewEten, ik: viewIk };

function render(skipIfTyping = false) {
  const onboarding = !state.me;
  $('#tabs').hidden = onboarding;
  $('#title').textContent = state.household?.name || 'Thuis';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const focused = document.activeElement?.tagName;
  if (skipIfTyping && (focused === 'INPUT' || focused === 'TEXTAREA')) return; // realtime-update mag typen niet onderbreken
  $('#view').innerHTML = onboarding ? viewOnboarding() : (VIEWS[state.tab] || viewHome)();
}

// ───────── Acties ─────────
async function ensureDinner(day) {
  let d = state.dinners.find((x) => x.day === day);
  if (!d) {
    const r = await sb.from('dinners').upsert({ day }, { onConflict: 'household_id,day' }).select().single();
    if (r.error) { toast(r.error.message); return null; }
    d = r.data;
  }
  return d;
}

const actions = {
  tab(el) { state.tab = el.dataset.tab; store.set('tab', state.tab); render(); },
  zone(el) { return setZone(el.dataset.zone); },
  locate, sethome: saveHome,
  joinout(el) {
    const o = state.members.find((m) => m.id === el.dataset.id);
    return run(sb.from('members').update({ out_status: 'going', out_place: o.out_place, out_note: o.out_note }).eq('id', state.me.id), 'Top, je gaat mee');
  },
  arsvp(el) { return run(sb.from('activity_rsvps').upsert({ activity_id: el.dataset.id, answer: el.dataset.ans }, { onConflict: 'activity_id,member_id' })); },
  delact(el) { return run(sb.from('activities').delete().eq('id', el.dataset.id), 'Verwijderd'); },
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
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  const kind = f.dataset.form;
  if (kind === 'create') {
    const r = await sb.rpc('create_household', { p_household: v.household, p_name: v.name, p_emoji: v.emoji || '🙂' });
    if (r.error) return toast(r.error.message);
    await loadAll(); render(); toast('Huishouden aangemaakt');
  } else if (kind === 'join') {
    const r = await sb.rpc('join_household', { p_code: v.code, p_name: v.name, p_emoji: v.emoji || '🙂' });
    if (r.error) return toast(r.error.message);
    await loadAll(); render(); toast('Aangesloten');
  } else if (kind === 'out') {
    const status = e.submitter?.value || 'wants';
    await run(sb.from('members').update({ out_status: status, out_place: v.place || null, out_note: v.note || null }).eq('id', state.me.id), 'Status bijgewerkt');
  } else if (kind === 'activity') {
    await run(sb.from('activities').insert({ title: v.title, note: v.note || null, starts_at: v.starts_at ? new Date(v.starts_at).toISOString() : null }), 'Toegevoegd');
  } else if (kind === 'dinner') {
    const day = f.dataset.day;
    await run(sb.from('dinners').upsert({ day, menu: v.menu || null, cook_id: v.cook || null }, { onConflict: 'household_id,day' }), 'Opgeslagen');
  }
});

// ───────── Start ─────────
(async function init() {
  try {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    state.session = await ensureSession();
    await loadAll(); render(); subscribe();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSoon(); });
  } catch (err) {
    $('#view').innerHTML = `<div class="card"><b>Kan niet verbinden</b><p class="muted">${esc(err.message || err)}</p></div>`;
  }
})();
