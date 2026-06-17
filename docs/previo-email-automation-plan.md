# Previo E-mail Automation Plan

## Cíl
Bezpečně automatizovat příjem Previo Stav PDF přes e-mail, ale import potvrzovat ručně v aplikaci.

## Průběh v1 (bez auto-confirm)
1. Previo pošle Stav PDF do dedikované schránky.
2. Gmail filtr označí zprávu štítkem (např. `previo-stav`).
3. Google Apps Script periodicky čte nepřečtené zprávy s tímto štítkem.
4. Script najde PDF přílohu se slovem `Stav` v názvu.
5. Script odešle request na endpoint (`/api/previo-import-email` nebo Netlify function) s hlavičkou `X-Import-Secret`.
6. Endpoint vytvoří Firestore `importJob` se stavem `received` a automaticky vygeneruje náhled (`parsed/needs_review`).
7. Dry-run auto-confirm vyhodnotí, zda by byl import automaticky potvrzen (bez aplikace změn).
8. Admin v Hotel Ops otevře sekci `Importy z Previa`, zkontroluje náhled a ručně klikne `Potvrdit import`.
9. Po úspěšném potvrzení se job přepne na `confirmed`.
10. Script označí e-mail jako zpracovaný (změna štítku / přesun / read).

## Payload pro endpoint
`POST /api/previo-import-email`

```json
{
	"fileName": "previo-state-2026-06-16-20.pdf",
	"contentType": "application/pdf",
	"source": "email",
	"pdfBase64": "<base64 PDF content>"
}
```

Pravidla validace:
- Header `X-Import-Secret` je povinný.
- Chybějící nebo špatný secret => `401`.
- Chybějící `pdfBase64` => `400`.
- Nepdf payload (ani `contentType=application/pdf`, ani `.pdf` název) => `400`.
- Maximální velikost dekódovaného PDF: 10 MB (`413`).

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
- `contentType`
- `sizeBytes`
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
- `FIREBASE_STORAGE_BUCKET` (např. `your_project.appspot.com`)
- `AUTO_CONFIRM_STAV_IMPORTS` (default `false`)
- `AUTO_CONFIRM_STAV_IMPORTS_DRY_RUN` (default `true`)

Frontend režimový přepínač (pro UI a klientské auto-confirm chování):
- `VITE_AUTO_CONFIRM_STAV_IMPORTS` (default `false`)
- `VITE_AUTO_CONFIRM_STAV_IMPORTS_DRY_RUN` (default `true`)

## Další krok (v2)
- Zapnout `AUTO_CONFIRM_STAV_IMPORTS=true` a `AUTO_CONFIRM_STAV_IMPORTS_DRY_RUN=false` až po provozním ověření dry-run.
- Ponechat pravidlo: auto-confirm pouze pro nejnovější bezpečný import.
