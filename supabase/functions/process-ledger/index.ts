// process-ledger Edge Function
//
// Called by the front end (via supabase.functions.invoke, which attaches
// the signed-in user's access token automatically) with { job_id }. The
// job row and source PDF must already exist -- the browser creates the
// 'pending' job row and uploads the PDF to the 'tally-uploads' bucket
// itself (both allowed by RLS for the user's own rows/paths) *before*
// calling this function. This function does the actual reconstruction:
//
//   PDF bytes -> pdfLayout.ts (pdftotext -layout equivalent)
//             -> voucherParser.ts (voucher reconstruction + GST rate
//                self-verification -- see extract_vouchers.py's docstring)
//             -> registerBuilder.ts (formatted .xlsx, matching
//                build_invoice_register.py sheet-for-sheet)
//
// and writes tally_vouchers.csv + invoice_register.xlsx to the
// 'tally-outputs' bucket, then updates the job row's status/stats. See
// supabase/migrations/*_init.sql for why only this function (via the
// service-role key, which bypasses RLS) is allowed to write those fields.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'
import { pdfBufferToLayoutText } from './shared/pdfLayout.ts'
import { extractVouchers, rowsToCsv, type ExtractionResult, type HeadMismatch } from './shared/voucherParser.ts'
import { loadRecords, buildWorkbook, summarizeRecords } from './shared/registerBuilder.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

interface JobStatsPayload {
  raw_entries: number
  vouchers: number
  txn_type_counts: Record<string, number>
  purchase_invoice_count: number
  purchase_invoice_missing_vendor: number
  purchase_invoice_missing_invoice_no: number
  sheets: string[]
  credit_note_count: number
  no_invoice_no_count: number
  verification_passed: boolean
  mismatches: HeadMismatch[]
}

function buildStats(
  extraction: ExtractionResult,
  summary: { creditNoteCount: number; noInvoiceCount: number; sheets: string[] } | null,
): JobStatsPayload {
  return {
    raw_entries: extraction.rawEntryCount,
    vouchers: extraction.voucherCount,
    txn_type_counts: extraction.txnTypeCounts,
    purchase_invoice_count: extraction.purchaseInvoiceCount,
    purchase_invoice_missing_vendor: extraction.missingVendorCount,
    purchase_invoice_missing_invoice_no: extraction.missingInvoiceNoCount,
    sheets: summary?.sheets ?? [],
    credit_note_count: summary?.creditNoteCount ?? 0,
    no_invoice_no_count: summary?.noInvoiceCount ?? 0,
    verification_passed: extraction.mismatches.length === 0,
    mismatches: extraction.mismatches,
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  let body: { job_id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const jobId = body.job_id
  if (!jobId) return json({ error: 'job_id is required' }, 400)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  // Scoped to the caller's own JWT: used only to confirm the caller
  // actually owns this job. RLS (jobs_select_own) already guarantees the
  // select below returns nothing for a job that isn't theirs -- the
  // explicit ownership check afterward is belt-and-braces, not the only
  // line of defence.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const {
    data: { user },
    error: userErr,
  } = await callerClient.auth.getUser()
  if (userErr || !user) return json({ error: 'Invalid or expired session' }, 401)

  const { data: job, error: jobErr } = await callerClient.from('jobs').select('*').eq('id', jobId).single()
  if (jobErr || !job) return json({ error: 'Job not found' }, 404)
  if (job.user_id !== user.id) return json({ error: 'Forbidden' }, 403)
  if (job.status !== 'pending') return json({ error: `Job is already ${job.status}` }, 409)

  // From here on, use the service-role client: it's the only credential
  // allowed to move a job through processing -> done/error (see the
  // migration's RLS comment -- there is deliberately no client UPDATE
  // policy on jobs).
  const admin = createClient(supabaseUrl, serviceRoleKey)

  await admin.from('jobs').update({ status: 'processing', error_message: null }).eq('id', jobId)

  try {
    const { data: pdfBlob, error: dlErr } = await admin.storage.from('tally-uploads').download(job.pdf_storage_path)
    if (dlErr || !pdfBlob) {
      throw new Error(`Could not download the source PDF: ${dlErr?.message ?? 'not found'}`)
    }
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer())

    const layoutText = await pdfBufferToLayoutText(pdfBytes)
    const extraction = extractVouchers(layoutText)
    const csv = rowsToCsv(extraction.rows)
    const csvPath = `${user.id}/${jobId}/tally_vouchers.csv`

    if (extraction.mismatches.length > 0) {
      // Mirrors extract_vouchers.py's hard stop: "do not proceed to build
      // the register until this is resolved." The CSV is still written so
      // the run is diagnosable (ledgers_seen etc.), but no .xlsx is built
      // on a failed rate-verification -- see verify_head_totals()'s
      // docstring in voucherParser.ts for what a mismatch means.
      await admin.storage
        .from('tally-outputs')
        .upload(csvPath, new Blob([csv], { type: 'text/csv' }), { upsert: true })

      await admin
        .from('jobs')
        .update({
          status: 'error',
          error_message:
            'GST rate verification FAILED: the reconstructed voucher totals do not match the source PDF for one or more GST rate heads, so the register was not built. See the verification details on this job for which head(s) and by how much.',
          csv_storage_path: csvPath,
          stats: buildStats(extraction, null),
        })
        .eq('id', jobId)

      return json({ ok: false, status: 'error', reason: 'verification_failed' })
    }

    const records = loadRecords(extraction.rows, job.include_refunds, job.require_reference)
    if (records.length === 0) {
      await admin
        .from('jobs')
        .update({
          status: 'error',
          error_message:
            'No rows were left to write after filtering. Check the source PDF, and if "require reference" was enabled, try again with it off.',
          stats: buildStats(extraction, null),
        })
        .eq('id', jobId)
      return json({ ok: false, status: 'error', reason: 'no_records' })
    }

    const notesExtra: string[] = []
    if (job.include_refunds) {
      notesExtra.push(
        '10. This run was made WITH "include refunds": refund vouchers ARE present (their GST Head(s) reflect every ledger the refund journal touched, which is not meaningful the way it is for a real invoice -- treat those rows as informational only).',
      )
    }
    if (job.require_reference) {
      notesExtra.push(
        '10. This run was made WITH "require reference": vouchers with neither an invoice/bill number nor an identifiable vendor name were dropped, not just flagged.',
      )
    }

    const wb = buildWorkbook({
      records,
      company: job.company,
      state: job.state || '(state not specified)',
      period: job.period || '(period not specified)',
      notesExtra,
    })
    // exceljs types this as Promise<Buffer>. TS's lib.dom BlobPart type is
    // fussy about the exact ArrayBufferLike generic a Buffer carries (this
    // varies across TS versions), so the cast here is a deliberate "trust
    // the runtime" -- a Buffer is a Uint8Array subclass and Blob has always
    // accepted one.
    const xlsxBuffer = (await wb.xlsx.writeBuffer()) as unknown as BlobPart
    const xlsxPath = `${user.id}/${jobId}/invoice_register.xlsx`

    await admin.storage.from('tally-outputs').upload(csvPath, new Blob([csv], { type: 'text/csv' }), { upsert: true })
    await admin.storage.from('tally-outputs').upload(
      xlsxPath,
      new Blob([xlsxBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      { upsert: true },
    )

    const summary = summarizeRecords(records)
    await admin
      .from('jobs')
      .update({
        status: 'done',
        error_message: null,
        csv_storage_path: csvPath,
        xlsx_storage_path: xlsxPath,
        stats: buildStats(extraction, summary),
      })
      .eq('id', jobId)

    return json({ ok: true, status: 'done' })
  } catch (err) {
    console.error('process-ledger failed for job', jobId, err)
    await admin
      .from('jobs')
      .update({
        status: 'error',
        error_message: err instanceof Error ? err.message : String(err),
      })
      .eq('id', jobId)
    return json({ ok: false, status: 'error', reason: 'exception' }, 500)
  }
})
