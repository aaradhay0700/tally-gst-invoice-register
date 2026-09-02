-- Tally GST Invoice Register -- initial schema
--
-- One `jobs` row per upload+run. Each user only ever sees their own rows
-- (enforced by RLS below). The row starts as 'pending' when the browser
-- inserts it and uploads the source PDF to storage; the `process-ledger`
-- Edge Function (using the service-role key, which bypasses RLS) then flips
-- it to 'processing' -> 'done'/'error' and fills in the output paths + stats.
--
-- Run this with `supabase db push` (or paste it into the SQL editor of your
-- own Supabase project) -- see DEPLOYMENT.md.

create extension if not exists pgcrypto;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'error')),
  error_message text,

  -- Run parameters, supplied at upload time (see SKILL.md Step 3 for what
  -- these mean: they become the workbook's title/subtitle text).
  company text not null,
  state text not null,
  period text not null,
  include_refunds boolean not null default false,
  require_reference boolean not null default false,

  -- Storage object paths (private buckets -- not public URLs). Always
  -- "<user_id>/<job_id>/<filename>" so storage RLS can key off the first
  -- path segment. See the storage policies below.
  source_filename text not null,
  pdf_storage_path text not null,
  csv_storage_path text,
  xlsx_storage_path text,

  -- Populated by the Edge Function once processing finishes: txn_type
  -- breakdown, missing-vendor/invoice-no counts, sheet list, and the GST
  -- rate self-verification result (see extract_vouchers.py's
  -- verify_head_totals docstring for what this is checking and why it
  -- matters -- a FAILED verification means the register would double- or
  -- under-count a rate head, so the UI must surface it prominently).
  stats jsonb
);

create index if not exists jobs_user_id_created_at_idx
  on public.jobs (user_id, created_at desc);

-- Keep updated_at current on every UPDATE (the Edge Function touches a row
-- several times as a job moves pending -> processing -> done/error).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
  before update on public.jobs
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
-- Every user only sees/creates/deletes their own jobs. There is
-- deliberately NO client-facing UPDATE policy: only the Edge Function
-- (invoked with the service-role key, which bypasses RLS entirely) is
-- allowed to move a job through pending -> processing -> done/error or
-- write stats/output paths. If a browser client could update its own job
-- rows it could mark a failed job "done" or point xlsx_storage_path at
-- someone else's file.

alter table public.jobs enable row level security;

create policy "jobs_select_own"
  on public.jobs for select
  to authenticated
  using (user_id = auth.uid());

create policy "jobs_insert_own"
  on public.jobs for insert
  to authenticated
  with check (user_id = auth.uid() and status = 'pending');

create policy "jobs_delete_own"
  on public.jobs for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------
-- Both buckets are PRIVATE. The front end never uses public URLs; it
-- always calls supabase.storage.from(bucket).createSignedUrl(path, ttl)
-- (uploads happen via the authenticated client directly, downloads via a
-- short-lived signed URL -- see src/lib/jobs.ts).

insert into storage.buckets (id, name, public)
values ('tally-uploads', 'tally-uploads', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('tally-outputs', 'tally-outputs', false)
on conflict (id) do nothing;

-- Object paths are always "<uid>/<job_id>/<filename>". These policies key
-- off the first path segment so a user can only read/write inside their
-- own "folder" -- the Edge Function's service-role client bypasses this
-- (service_role always bypasses storage RLS) so it can write outputs into
-- the path even though it authenticates as no particular user.

create policy "tally_uploads_owner_rw"
  on storage.objects for all
  to authenticated
  using (
    bucket_id = 'tally-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'tally-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "tally_outputs_owner_rw"
  on storage.objects for all
  to authenticated
  using (
    bucket_id = 'tally-outputs'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'tally-outputs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
