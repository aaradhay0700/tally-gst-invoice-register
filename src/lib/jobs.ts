import { supabase } from './supabaseClient'
import type { Job } from '../types'

export async function listJobs(): Promise<Job[]> {
  const { data, error } = await supabase.from('jobs').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Job[]
}

export async function getJob(id: string): Promise<Job> {
  const { data, error } = await supabase.from('jobs').select('*').eq('id', id).single()
  if (error) throw error
  return data as Job
}

export async function deleteJob(id: string): Promise<void> {
  const { error } = await supabase.from('jobs').delete().eq('id', id)
  if (error) throw error
}

export interface CreateJobParams {
  file: File
  company: string
  state: string
  period: string
  includeRefunds: boolean
  requireReference: boolean
}

/**
 * Uploads the PDF, creates the job row, then invokes the process-ledger
 * Edge Function and waits for it to finish. The function runs
 * synchronously (it's a single HTTP request/response, not a queue), so by
 * the time this resolves the job is already 'done' or 'error' -- but we
 * still re-fetch the row afterward rather than trusting the function's own
 * response body, since the row is the single source of truth the rest of
 * the app (job detail, refresh) also reads from.
 */
export async function createAndRunJob(params: CreateJobParams, onProgress?: (stage: string) => void): Promise<Job> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')

  const jobId = crypto.randomUUID()
  const pdfPath = `${user.id}/${jobId}/${params.file.name}`

  onProgress?.('Uploading PDF…')
  const { error: uploadErr } = await supabase.storage.from('tally-uploads').upload(pdfPath, params.file, {
    contentType: 'application/pdf',
    upsert: false,
  })
  if (uploadErr) throw new Error(`Could not upload the PDF: ${uploadErr.message}`)

  onProgress?.('Creating job…')
  const { error: insertErr } = await supabase.from('jobs').insert({
    id: jobId,
    user_id: user.id,
    status: 'pending',
    company: params.company,
    state: params.state,
    period: params.period,
    include_refunds: params.includeRefunds,
    require_reference: params.requireReference,
    source_filename: params.file.name,
    pdf_storage_path: pdfPath,
  })
  if (insertErr) throw new Error(`Could not create the job: ${insertErr.message}`)

  onProgress?.('Reconstructing vouchers and building the register (this can take a little while for a large ledger)…')
  const { error: fnErr } = await supabase.functions.invoke('process-ledger', { body: { job_id: jobId } })
  if (fnErr) {
    // The job row itself is the source of truth for *why* it failed (the
    // function updates error_message even on failure) -- getJob below
    // will surface that; this invoke-level error is usually just "non-2xx
    // status code", which isn't useful to show on its own.
    console.warn('process-ledger invoke returned an error; falling back to the job row for details', fnErr)
  }

  return getJob(jobId)
}

export async function getSignedDownloadUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('tally-outputs').createSignedUrl(path, 60 * 10)
  if (error || !data) throw error ?? new Error('Could not create a download link')
  return data.signedUrl
}
