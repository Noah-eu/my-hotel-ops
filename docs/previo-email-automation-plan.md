# Previo E-mail Automation Plan

## Cíl
Bezpečně automatizovat příjem Previo Stav PDF přes e-mail, ale import potvrzovat ručně v aplikaci.

## Průběh v1 (bez auto-confirm)
1. Previo pošle Stav PDF do dedikované schránky.
2. Gmail filtr označí zprávu štítkem (např. `previo-stav`).
3. Google Apps Script periodicky čte nepřečtené zprávy s tímto štítkem.
4. Script najde PDF přílohu se slovem `Stav` v názvu.
5. Script odešle request na endpoint (`/api/previo-import-email` nebo Netlify function) s hlavičkou `X-Import-Secret`.
6. Endpoint vytvoří Firestore `importJob` se stavem `received`.
7. Admin v Hotel Ops otevře sekci `Importy z Previa`, zkontroluje náhled a ručně klikne `Potvrdit import`.
8. Po úspěšném potvrzení se job přepne na `confirmed`.
9. Script označí e-mail jako zpracovaný (změna štítku / přesun / read).

## Firestore model
Kolekce: `hotels/chill-apartments/importJobs/{jobId}`

Doporučená pole:
- `type`: `previo-state-pdf`
- `source`: `email` nebo `manual`
- `status`: `received | parsed | needs_review | confirmed | failed | cancelled`
- `fileName`
- `receivedAt`
- `parsedAt`
- `confirmedAt`
- `confirmedBy`
- `detectedDaysCount`
- `turnoverCount`
- `stayoverCount`
- `freeCount`
- `warnings`
- `error`
- `storagePath`
- `previewSummary`
- `parserVersion`

## Bezpečnost
- `PREVIO_IMPORT_SECRET` je pouze server-side env proměnná.
- Frontend nesmí secret obsahovat.
- Endpoint musí vracet `401`, pokud secret chybí nebo nesedí.
- Public zápisy mimo endpoint zůstávají blokované Firestore pravidly.

## Doporučené env proměnné
- `PREVIO_IMPORT_SECRET`
- `PREVIO_IMPORT_HOTEL_ID` (default `chill-apartments`)
- `FIREBASE_SERVICE_ACCOUNT_JSON` (server-side JSON service account)

## Další krok (v2)
- Přidat server-side parsování PDF v background workeru.
- Z `received` přepnout job na `parsed/needs_review` automaticky.
- Zachovat ruční potvrzení importu v admin UI.
