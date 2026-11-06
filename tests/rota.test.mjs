import assert from 'node:assert/strict';
import { addIso, diffDays, periodOf, periodStart, periodEnd, holder, holders } from '../app/rota.js';

// Datums, ook over de zomertijdwissel heen
assert.equal(addIso('2026-10-24', 7), '2026-10-31');
assert.equal(addIso('2026-03-28', 1), '2026-03-29');
assert.equal(diffDays('2026-10-20', '2026-10-27'), 7);
assert.equal(addIso('2026-12-31', 1), '2027-01-01');

const chore = { id: 'c', start_date: '2026-11-02', period_days: 7, team_size: 1 };
assert.equal(periodOf(chore, '2026-11-02'), 0);
assert.equal(periodOf(chore, '2026-11-08'), 0);
assert.equal(periodOf(chore, '2026-11-09'), 1);
assert.equal(periodOf(chore, '2026-11-01'), -1);
assert.equal(periodStart(chore, 2), '2026-11-16');
assert.equal(periodEnd(chore, 0), '2026-11-08');

// 17 huisgenoten, 1 per beurt: iedereen precies één keer per 17 weken, daarna herhaalt het
const rot = Array.from({ length: 17 }, (_, i) => `m${i}`);
const cycle = Array.from({ length: 17 }, (_, p) => holder(chore, p, 0, rot, []).id);
assert.equal(new Set(cycle).size, 17);
assert.equal(holder(chore, 17, 0, rot, []).id, 'm0');

// 2 per beurt: slots lopen door de lijst, oneven aantal loopt netjes rond
const duo = { ...chore, team_size: 2 };
assert.deepEqual(holders(duo, 0, rot, []).map((h) => h.id), ['m0', 'm1']);
assert.deepEqual(holders(duo, 8, rot, []).map((h) => h.id), ['m16', 'm0']);
const seen = new Map();
for (let p = 0; p < 17; p++) holders(duo, p, rot, []).forEach((h) => seen.set(h.id, (seen.get(h.id) || 0) + 1));
assert.ok([...seen.values()].every((n) => n === 2), 'in 17 periodes iedereen precies 2x');

// Override wint, ook voor slot 1
const ov = [{ chore_id: 'c', period_start: '2026-11-09', slot: 1, member_id: 'x' }];
assert.deepEqual(holders(duo, 1, rot, ov).map((h) => [h.id, h.over]), [['m2', false], ['x', true]]);
assert.equal(holder(chore, 0, 0, [], []).id, null);

console.log('✓ rooster-tests geslaagd');

// De Edge Function gebruikt een kopie; die moet identiek blijven.
import { readFileSync } from 'node:fs';
assert.equal(readFileSync(new URL('../supabase/functions/notify/rota.js', import.meta.url), 'utf8'),
  readFileSync(new URL('../app/rota.js', import.meta.url), 'utf8'), 'kopieer app/rota.js naar supabase/functions/notify/rota.js');
console.log('✓ rota.js-kopie gelijk');
