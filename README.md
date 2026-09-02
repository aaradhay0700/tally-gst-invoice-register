# Tally GST Invoice Register — web app

A web front end for the `tally-gst-invoice-register` skill: sign in, upload
a Tally-exported GST ledger PDF, and get back a formatted multi-tab Excel
invoice register (a `Master` tab plus one tab per GST rate/type, e.g.
`CGST 9%`, `IGST 18%`, `IGST 18% RCM`) — the same output the skill produces
locally, built the same way, just running as a hosted app instead of a
local script.

## Why this isn't just "the Python scripts behind a form"

The skill's two scripts (`extract_vouchers.py`, `build_invoice_register.py`)
depend on `pdftotext` (a system binary) and Python libraries (`pandas`,
`openpyxl`) that don't run in a browser or in Supabase's Deno Edge
Functions. Rather than standing up a separate Python server, the
processing logic has been **ported to TypeScript** so the whole stack —
front end and back end — runs on Supabase + Netlify with no third service
to operate:

- **`pdftotext -layout`** → reimplemented on `pdfjs-dist` in
  `supabase/functions/process-ledger/shared/pdfLayout.ts`. See that file's
  module docstring for the reconstruction algorithm and its known limits.
- **`extract_vouchers.py`** → ported function-for-function to
  `.../shared/voucherParser.ts`. Same regex patterns, same voucher
  reconstruction and GST-rate self-verification logic.
- **`build_invoice_register.py`** → ported to `.../shared/registerBuilder.ts`,
  using `exceljs` in place of `openpyxl`. Same sheet layout, colors,
  formulas, and highlighting rules.

`scripts/test-harness/` has local tests (run under Node, not Deno — much
faster to iterate on) that check this port's behavior against the Python
originals' documented behavior. **Read `DEPLOYMENT.md`'s "Smoke-test the
pipeline" section before trusting this on real client data** — a hand-built
test fixture can't fully stand in for the variety of real Tally exports.

## Architecture

```
Browser (React + Vite, deployed on Netlify)
  │  Supabase Auth (email/password) — sign in
  │  supabase-js: upload PDF directly to Storage, insert a `jobs` row
  │  supabase-js: invoke the process-ledger Edge Function
  ▼
Supabase
  ├─ Postgres: `jobs` table (RLS: each user only sees their own rows)
  ├─ Storage: `tally-uploads` (private, source PDFs) and
  │           `tally-outputs` (private, generated .xlsx/.csv)
  └─ Edge Function `process-ledger` (Deno):
       downloads the PDF → pdfLayout.ts → voucherParser.ts →
       registerBuilder.ts → uploads outputs → updates the job row
```

Nothing here needs a server you manage: Netlify serves the static front
end, Supabase is the entire backend (auth, database, file storage, and the
one function that does the actual work).

## Repository layout

```
src/                                    React front end (Vite + TypeScript + Tailwind)
supabase/migrations/                    SQL: jobs table, RLS policies, storage buckets
supabase/functions/process-ledger/      The Edge Function and its ported parsing/xlsx logic
scripts/test-harness/                   Local Node tests for the shared logic (see its README)
netlify.toml                            Netlify build + SPA redirect config
DEPLOYMENT.md                           Step-by-step: your own Supabase project, GitHub, Netlify
```

## Local development

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project's URL + anon key
npm run dev                  # http://localhost:5173
```

The Edge Function itself is developed/tested separately — see
`DEPLOYMENT.md` for `supabase functions serve` / `supabase db push`, and
`scripts/test-harness/README.md` for the fast Node-based logic tests.

## Deploying

See **`DEPLOYMENT.md`** for the full walkthrough: creating your own
Supabase project, applying the migration, deploying the Edge Function,
pushing this repo to GitHub, and connecting it to Netlify.
