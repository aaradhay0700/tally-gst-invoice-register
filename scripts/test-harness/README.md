# Test harness

Local sanity checks for the shared parsing/xlsx-building logic under
`supabase/functions/process-ledger/shared/`, run with plain Node (via
`tsx`) instead of Deno -- useful because it's much faster to iterate on
than deploying an Edge Function on every change.

```bash
npm install         # once, from the repo root
npm run test:harness     # voucher parsing + xlsx building, against hand-built fixtures
npm run test:pdf-layout  # pdftotext -layout emulation, against a synthetic PDF
```

## What these do and don't prove

`run_pipeline_test.ts` runs `voucherParser.ts` and `registerBuilder.ts`
against two hand-built fixtures in `fixtures/` that are shaped like real
`pdftotext -layout` output (see `SAMPLE_LEDGER_LAYOUT`'s comments for
exactly what each fixture voucher is testing: voucher reconstruction
across multiple ledger pages, the CGST/SGST rate-folding, the GST-rate
self-verification catching both a clean pass and a deliberately broken
case, and the resulting `.xlsx`'s sheet layout/formulas/highlighting). It
proves the *ported* logic behaves the way the Python originals'
docstrings describe, given text in the expected shape.

`pdf_layout_test.ts` builds a small synthetic PDF with `pdf-lib` and
checks that `pdfLayout.ts` reconstructs recognisable, multi-space-
separated columns from known text positions. It proves the
coordinate-to-spacing reconstruction is directionally correct on a
controlled input.

**Neither test proves the whole pipeline works on a real client Tally
PDF.** Real Tally exports vary in font, column widths, and narration
phrasing in ways a hand-built fixture can't anticipate. Once you've
deployed (see `DEPLOYMENT.md`), run an actual client PDF through the
deployed app and treat the on-screen GST rate verification result (PASS
vs FAIL) and the missing-vendor/invoice-no counts the same way the
skill's own `SKILL.md` tells you to when running it locally: skim them,
and if something looks off, compare `tally_vouchers.csv` (downloadable
from the job detail page) against the source PDF pages, and adjust the
regex/column-width constants in `voucherParser.ts` / `pdfLayout.ts` --
never hand-patch a job's output.

## Why these files import bare `'exceljs'` / `'pdfjs-dist/...'`

The shared files run in two different runtimes unmodified: Deno (the
Supabase Edge Function, via the import map in
`supabase/functions/process-ledger/deno.json`) and Node (this harness, via
a normal `npm install` at the repo root). Both resolve the same bare
specifier to their own copy of the library, so don't change these imports
to `npm:`-prefixed specifiers (Deno-only) or relative paths into
`node_modules` (fragile, and wrong under Deno).
