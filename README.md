# Thuis

Gratis huis-app (PWA) voor een groot huis: beurtenrooster met ruilen en afvinken, wie is er thuis, wie wil er uit, activiteiten, wie eet er mee. Met echte pushmeldingen.

**App:** https://robvanstekelenburg.github.io/thuis-app/

## Hoe het werkt

| Onderdeel | Waar |
|---|---|
| App (HTML/JS, geen build) | `app/`, gehost op GitHub Pages |
| Database, login, realtime | Supabase (gratis plan), schema in `supabase/migrations/` |
| Pushmeldingen | Web Push via Edge Function `supabase/functions/notify` |
| Beurt-herinnering (elke avond) | `.github/workflows/reminders.yml` |
| Rooster-berekening | `app/rota.js` (gedeeld met de Edge Function) |

Meldingen: *morgen ben jij aan de beurt*, *vandaag laatste dag* (als je nog niet hebt afgevinkt), ruilverzoeken en antwoorden, iemand wil uit, nieuwe activiteit, menu ingevuld.

## Eenmalig instellen

1. **Supabase-project**: maak een account op [supabase.com](https://supabase.com) en een nieuw project in regio *EU Central*. Bewaar het databasewachtwoord in je wachtwoordmanager.
2. **Project-ref**: de code in de project-URL, bijvoorbeeld `abcdefghijklmnop` uit `https://abcdefghijklmnop.supabase.co`.
3. **Access token**: Supabase → Account → *Access Tokens* → nieuwe token. Kies als dat kan een token met alleen rechten op dit project.
4. Zet ze in GitHub (in je eigen terminal; plak de token als erom gevraagd wordt):
   ```bash
   gh secret set SUPABASE_ACCESS_TOKEN -R robvanstekelenburg/thuis-app
   gh variable set SUPABASE_PROJECT_REF -R robvanstekelenburg/thuis-app --body JOUW-PROJECT-REF
   gh workflow run setup.yml -R robvanstekelenburg/thuis-app
   ```
5. De workflow **Supabase instellen** zet automatisch klaar: database en beveiliging, anonieme login, push-sleutels, de Edge Function, en deployt daarna de app opnieuw. Duurt ~2 minuten.
6. Open de app op je telefoon:
   - iPhone: Safari → Deel → **Zet op beginscherm**, open daarna via het icoon (nodig voor meldingen).
   - Android: Chrome → **App installeren**.
7. Start een huis (jij wordt beheerder), voeg in tab *Ik* de taak "Afval buiten zetten" toe en deel de uitnodigingscode met je huisgenoten.

De VAPID-sleutels voor push staan al in de repo-instellingen (`VAPID_PUBLIC_KEY` variabele, `VAPID_PRIVATE_KEY` secret). Niet vervangen: dan moet iedereen meldingen opnieuw aanzetten.

## Ontwikkelen

```bash
npm install
npm test          # rooster-wiskunde + database-beveiliging (RLS) op een echte Postgres (PGlite)
npm run serve     # app lokaal op http://localhost:8080
```

`app/rota.js` en `supabase/functions/notify/rota.js` moeten gelijk blijven (de test controleert dat).

## Grenzen

- Geen echte homescreen-widget en geen automatische achtergrond-locatie (beperkingen van een PWA). Zone automatisch zetten kan met iOS Shortcuts of Android-automatisering; de instructies staan in tab *Ik*.
- Anonieme accounts: wist iemand de Safari-gegevens, dan is het profiel kwijt. Een beheerder verwijdert het oude profiel en de persoon sluit opnieuw aan met de code.
- Wie de uitnodigingscode heeft, kan lid worden. Deel hem alleen binnen het huis.
