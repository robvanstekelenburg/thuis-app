// Haalt een afval-ICS op (jouw gemeente/afvalbedrijf) en schrijft de komende ophaaldagen naar Supabase.
// Gebruik (lokaal):  ICS_URL=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... HOUSEHOLD_ID=... node scripts/sync-waste.mjs
// Draait automatisch via .github/workflows/waste-sync.yml. De service key staat ALLEEN in GitHub Secrets.

const { ICS_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY, HOUSEHOLD_ID } = process.env;
for (const [k, v] of Object.entries({ ICS_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY, HOUSEHOLD_ID })) {
  if (!v) { console.error(`Ontbrekende variabele: ${k}`); process.exit(1); }
}

const KIND_RULES = [
  [/gft|groen|organisch|keuken/i, 'gft'],
  [/pmd|plastic|metaal|drank|verpakking/i, 'pmd'],
  [/papier|karton/i, 'papier'],
  [/glas/i, 'glas'],
  [/rest|grijs|huisvuil/i, 'rest'],
];
const kindOf = (s) => (KIND_RULES.find(([re]) => re.test(s)) || [, 'overig'])[1];

function parseIcs(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, ''); // regels die doorlopen samenvoegen
  const events = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const summary = /^SUMMARY[^:]*:(.*)$/m.exec(block)?.[1]?.trim();
    const dt = /^DTSTART[^:]*:(\d{4})(\d{2})(\d{2})/m.exec(block);
    if (!summary || !dt) continue;
    events.push({ day: `${dt[1]}-${dt[2]}-${dt[3]}`, label: summary.replace(/\\,/g, ',') });
  }
  return events;
}

const res = await fetch(ICS_URL);
if (!res.ok) { console.error('ICS ophalen mislukt:', res.status); process.exit(1); }
const today = new Date().toISOString().slice(0, 10);
const horizon = new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10);

const rows = parseIcs(await res.text())
  .filter((e) => e.day >= today && e.day <= horizon)
  .map((e) => ({ household_id: HOUSEHOLD_ID, day: e.day, kind: kindOf(e.label), label: e.label }));

if (!rows.length) { console.log('Geen events gevonden; niets te doen.'); process.exit(0); }

const up = await fetch(`${SUPABASE_URL}/rest/v1/waste_events?on_conflict=household_id,day,kind`, {
  method: 'POST',
  headers: {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  },
  body: JSON.stringify(rows),
});
if (!up.ok) { console.error('Upsert mislukt:', up.status, await up.text()); process.exit(1); }
console.log(`${rows.length} ophaaldagen gesynchroniseerd.`);
