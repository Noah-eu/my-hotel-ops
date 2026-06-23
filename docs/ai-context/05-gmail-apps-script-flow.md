# 05 - Gmail Apps Script Flow

## Entrypoint
- Import automation entrypoint: `runPrevioGmailImporter` in `scripts/previo-gmail-importer.js`.

## Selection Strategy
- Prefer XLS/XLSX as primary import source.
- Attach PDF only as optional overlay for arrival-time enrichment.

## Change Policy
- Do not change Gmail Apps Script selection logic unless you can prove it selected the wrong files.
- If mismatch is observed, first prove divergence in server processing path before touching source selection.
