# Deployment guide

Everything here is done from your own accounts — Supabase, GitHub, Netlify.
None of this repo's setup depends on where it was built.

## 0. Prerequisites

- Node.js 20+ and npm (for local dev/build)
- A Supabase account — [supabase.com](https://supabase.com)
- The Supabase CLI: `npm install -g supabase` (or see
  [supabase.com/docs/guides/cli](https://supabase.com/docs/guides/cli) for
  other install methods)
- A GitHub account
- A Netlify account — [netlify.com](https://netlify.com)

## 1. Create a Supabase project

1. In the [Supabase dashboard](https://supabase.com/dashboard), create a
   new project (any name, e.g. "tally-gst-invoice-register"; pick a region
   close to your users — `ap-south-1` (Mumbai) if your users are in India).
2. Note two things from **Project Settings → API** once it's ready:
   - **Project URL** (`https://<ref>.supabase.co`)
   - **anon / publishable key** (safe to expose in the browser — RLS is
     what actually restricts access, not this key)
3. Note the **Project Reference** (the `<ref>` part of the URL, also shown
   on the same Settings page) — you'll pass it to the CLI next.

You do **not** need to manually note or set the service-role key anywhere
in this repo: Supabase automatically injects `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` into every Edge
Function's environment. `supabase/functions/process-ledger/index.ts` just
reads them with `Deno.env.get(...)`.

## 2. Link the CLI and push the database schema

From the repo root:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

`supabase db push` runs `supabase/migrations/20260831000000_init.sql`,
which creates:

- the `jobs` table, with Row Level Security so each signed-in user only
  ever sees their own rows (see the migration file's own comments for
  exactly why there's no client-facing `UPDATE` policy on it),
- the two private Storage buckets (`tally-uploads`, `tally-outputs`) and
  their owner-scoped access policies.

If you'd rather not install the CLI, you can instead open the SQL Editor
in the Supabase dashboard and paste the contents of that migration file
directly — it's a single idempotent script.

## 3. Deploy the Edge Function

```bash
supabase functions deploy process-ledger
```

The CLI picks up `supabase/functions/process-ledger/deno.json` (the import
map that resolves `exceljs` and `pdfjs-dist` to their `npm:` equivalents
under Deno) and `supabase/config.toml` (which sets `verify_jwt = true` for
this function — i.e., only signed-in users can call it) automatically.

No function secrets need to be set — see the note in step 1 about the
auto-injected `SUPABASE_*` variables.

### Smoke-test the pipeline

Before trusting this on real client data, run one actual Tally GST-ledger
PDF through it (see `scripts/test-harness/README.md` for why the local
Node tests alone aren't sufficient proof). The fastest way:

```bash
supabase functions serve process-ledger --env-file .env.local
```

then sign up/sign in on the local front end (`npm run dev`) and upload a
real PDF. Watch the terminal running `functions serve` for errors, and
check the job's GST-rate verification result in the UI. If verification
FAILS or the numbers look off in some other way (a vendor/invoice-no rate
that seems too low even though rates PASS), it means this client's Tally
export doesn't quite match the shape `pdfLayout.ts` / `voucherParser.ts`
were written against — see those files' own comments (and
`extract_vouchers.py`'s original docstring, which explains the same
diagnosis process) for where to adjust: `voucherParser.ts`'s regex
constants (`INV_PATTERNS`, `DATE_PATTERNS`, `NARRATION_VENDOR_PATTERNS`,
`INTERNAL_BLOCKLIST`) if it's a phrasing issue, or `pdfLayout.ts`'s
`Y_TOLERANCE`/character-width estimate if whole columns are misaligned.
Never hand-patch a job's output — fix the parser and re-run.

## 4. Configure Supabase Auth

The app uses Supabase's built-in email/password auth, enabled by default
on every new project — nothing to turn on. Two settings worth checking in
**Authentication → Providers → Email**:

- **Confirm email**: on by default (a new user must click a link before
  they can sign in). Fine for production; if you want to test quickly with
  throwaway accounts, you can turn it off in the dashboard.
- **Site URL** / **Redirect URLs** (**Authentication → URL Configuration**):
  add your Netlify site's URL once you have it (step 7) so confirmation/
  magic-link emails point at the right place.

## 5. Configure the front end's environment

```bash
cp .env.example .env.local
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from step 1. Run
`npm install && npm run dev` to confirm it works locally before deploying.

## 6. Push to GitHub

```bash
git init                     # if this repo doesn't already have a .git directory
git add -A
git commit -m "Initial commit: Tally GST invoice register web app"
```

Create an empty repository on GitHub (via [github.com/new](https://github.com/new),
or `gh repo create <name> --private --source=. --remote=origin` if you have
the `gh` CLI), then:

```bash
git remote add origin git@github.com:<you>/<repo-name>.git
git branch -M main
git push -u origin main
```

## 7. Deploy to Netlify

1. In the Netlify dashboard: **Add new site → Import an existing project**,
   pick GitHub, and select this repository.
2. Netlify should auto-detect the build settings from `netlify.toml`
   (`npm run build`, publish directory `dist`) — confirm they're set that
   way if it asks.
3. Before the first deploy, add environment variables under **Site
   configuration → Environment variables**:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   (same values as `.env.local`.)
4. Deploy. Once it's live, copy the Netlify URL back into Supabase's
   **Authentication → URL Configuration** (step 4) so auth emails resolve
   correctly.

That's the whole stack live: Netlify serving the front end, Supabase
handling auth/storage/database and doing the actual PDF processing in the
Edge Function.

## Ongoing changes

- **Front end changes**: push to `main` (or your configured branch) —
  Netlify redeploys automatically.
- **Database changes**: add a new file to `supabase/migrations/` and run
  `supabase db push` again. Don't edit the existing migration file once
  it's been applied to a real project.
- **Edge Function changes**: `supabase functions deploy process-ledger`
  again — this creates a new version, no downtime.

## Security notes

- Both Storage buckets are **private**. The front end never constructs a
  public URL; downloads go through `supabase.storage.from(...).createSignedUrl()`,
  which mints a short-lived (10 minute) link.
- The `jobs` table has no client-facing `UPDATE` policy on purpose — only
  the Edge Function (using the service-role key, which never reaches the
  browser) can move a job through `processing → done/error` or write the
  output paths. See the migration file's comments for the reasoning.
- The Edge Function's CORS headers currently allow any origin
  (`Access-Control-Allow-Origin: '*'`) so it works during setup regardless
  of your Netlify URL. Once you know your final domain, you can tighten
  this in `supabase/functions/process-ledger/index.ts` — it doesn't
  meaningfully weaken security either way, since every request still needs
  a valid signed-in user's JWT (`verify_jwt = true`), but it's good
  hygiene.

## Costs

- **Supabase Free plan**: 2 active projects per organization, 500 MB
  database, 1 GB file storage, 2 million Edge Function invocations/month.
  This app is light on all of these for typical usage; upgrade only if you
  outgrow it.
- **Netlify Free plan**: 100 GB bandwidth/month, more than enough for an
  internal tool.

Both are optional paid upgrades later, not required to run this.
