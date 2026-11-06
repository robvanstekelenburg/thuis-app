// Rooster-wiskunde, gedeeld door de app en de Edge Function 'notify' (die krijgt bij deploy een kopie).
// Datums zijn 'YYYY-MM-DD'-strings; rekenen in UTC zodat zomertijd geen dag verschuift.
const ms = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const addIso = (s, n) => new Date(ms(s) + n * 864e5).toISOString().slice(0, 10);
export const diffDays = (a, b) => Math.round((ms(b) - ms(a)) / 864e5);

// Periode-nummer waarin `day` valt (negatief vóór de startdatum).
export const periodOf = (chore, day) => Math.floor(diffDays(chore.start_date, day) / chore.period_days);
export const periodStart = (chore, p) => addIso(chore.start_date, p * chore.period_days);
export const periodEnd = (chore, p) => addIso(chore.start_date, (p + 1) * chore.period_days - 1);

// rotation: member-id's in volgorde; overrides: rijen { chore_id, period_start, slot, member_id }.
export function holder(chore, p, slot, rotation, overrides) {
  const ps = periodStart(chore, p);
  const ov = overrides.find((o) => o.chore_id === chore.id && o.period_start === ps && o.slot === slot);
  if (ov) return { id: ov.member_id, over: true, ps, slot };
  const n = rotation.length;
  if (!n) return { id: null, over: false, ps, slot };
  return { id: rotation[(((p * chore.team_size + slot) % n) + n) % n], over: false, ps, slot };
}
export const holders = (chore, p, rotation, overrides) =>
  Array.from({ length: chore.team_size }, (_, slot) => holder(chore, p, slot, rotation, overrides));
