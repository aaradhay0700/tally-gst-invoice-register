import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getJob, getSignedDownloadUrl } from '../lib/jobs'
import type { Job } from '../types'
import StatusBadge from '../components/StatusBadge'

export default function JobDetail() {
  const { id } = useParams<{ id: string }>()
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false

    async function load() {
      try {
        const j = await getJob(id!)
        if (!cancelled) setJob(j)
        // The Edge Function call the "New register" page makes is
        // synchronous, so in the normal flow the job is already
        // done/error by the time you land here. This poll is just a
        // safety net for a page refresh that catches a job mid-flight.
        if (j.status === 'pending' || j.status === 'processing') {
          if (!pollRef.current) {
            pollRef.current = setInterval(load, 3000)
          }
        } else if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    load()

    return () => {
      cancelled = true
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [id])

  async function handleDownload(path: string) {
    try {
      const url = await getSignedDownloadUrl(path)
      window.open(url, '_blank')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!job) return <p className="text-sm text-slate-400">Loading…</p>

  const stats = job.stats

  return (
    <div className="max-w-3xl">
      <Link to="/" className="text-sm text-brand-600 hover:underline">
        ← All registers
      </Link>

      <div className="flex items-center justify-between mt-2 mb-6">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{job.company}</h1>
          <p className="text-sm text-slate-500">
            {job.state} · {job.period}
          </p>
        </div>
        <StatusBadge status={job.status} />
      </div>

      {(job.status === 'pending' || job.status === 'processing') && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-3">
          Still working — reconstructing vouchers and building the workbook. This page refreshes itself.
        </div>
      )}

      {job.status === 'error' && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-3 space-y-2">
          <p className="font-medium">{job.error_message ?? 'This job failed.'}</p>
        </div>
      )}

      {stats && !stats.verification_passed && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <p className="text-sm font-medium text-red-800 mb-2">
            GST rate verification FAILED — the reconstructed voucher totals don't match the source PDF for the
            head(s) below. The register was not built.
          </p>
          <table className="w-full text-xs">
            <thead className="text-red-700">
              <tr>
                <th className="text-left py-1">Head</th>
                <th className="text-right py-1">Raw (source PDF)</th>
                <th className="text-right py-1">Reconstructed</th>
                <th className="text-right py-1">Diff</th>
              </tr>
            </thead>
            <tbody className="text-red-900">
              {stats.mismatches.map((m) => (
                <tr key={m.head} className="border-t border-red-100">
                  <td className="py-1">{m.head}</td>
                  <td className="py-1 text-right">{m.raw_total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  <td className="py-1 text-right">
                    {m.reconstructed_total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="py-1 text-right font-medium">
                    {m.diff > 0 ? '+' : ''}
                    {m.diff.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {job.csv_storage_path && (
            <button
              onClick={() => handleDownload(job.csv_storage_path!)}
              className="mt-3 text-xs font-medium text-red-700 hover:underline"
            >
              Download the raw reconstructed vouchers (CSV) to diagnose
            </button>
          )}
        </div>
      )}

      {job.status === 'done' && stats && (
        <div className="space-y-6">
          <div className="flex gap-3">
            {job.xlsx_storage_path && (
              <button
                onClick={() => handleDownload(job.xlsx_storage_path!)}
                className="rounded-md bg-brand-600 text-white text-sm font-medium px-4 py-2 hover:bg-brand-700"
              >
                Download invoice register (.xlsx)
              </button>
            )}
            {job.csv_storage_path && (
              <button
                onClick={() => handleDownload(job.csv_storage_path!)}
                className="rounded-md border border-slate-300 text-slate-700 text-sm font-medium px-4 py-2 hover:bg-slate-50"
              >
                Download raw vouchers (.csv)
              </button>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Summary</h2>
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-slate-500">Raw ledger entries parsed</dt>
              <dd className="text-right font-medium">{stats.raw_entries}</dd>
              <dt className="text-slate-500">Vouchers reconstructed</dt>
              <dd className="text-right font-medium">{stats.vouchers}</dd>
              <dt className="text-slate-500">Purchase invoices</dt>
              <dd className="text-right font-medium">{stats.purchase_invoice_count}</dd>
              <dt className="text-slate-500">Credit notes</dt>
              <dd className="text-right font-medium">{stats.credit_note_count}</dd>
              <dt className="text-slate-500">Rows with no invoice number stated</dt>
              <dd className="text-right font-medium">{stats.no_invoice_no_count}</dd>
              <dt className="text-slate-500">Purchase rows missing a vendor</dt>
              <dd className="text-right font-medium">{stats.purchase_invoice_missing_vendor}</dd>
            </dl>
            <p className="mt-3 text-xs text-emerald-700 bg-emerald-50 rounded px-2 py-1 inline-block">
              GST rate verification PASSED — every rate head's raw ledger total matches the reconstructed voucher
              total exactly.
            </p>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Voucher types</h2>
            <ul className="text-sm space-y-1">
              {Object.entries(stats.txn_type_counts).map(([type, count]) => (
                <li key={type} className="flex justify-between">
                  <span className="text-slate-600">{type.replace(/_/g, ' ')}</span>
                  <span className="font-medium">{count}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Sheets in the workbook</h2>
            <div className="flex flex-wrap gap-2">
              {stats.sheets.map((s) => (
                <span key={s} className="text-xs bg-slate-100 text-slate-700 rounded-full px-2.5 py-1">
                  {s}
                </span>
              ))}
            </div>
          </div>

          <p className="text-xs text-slate-400">
            Run parameters: refunds {job.include_refunds ? 'included' : 'excluded'} · rows without an invoice number
            or vendor {job.require_reference ? 'dropped' : 'kept and flagged'}.
          </p>
        </div>
      )}
    </div>
  )
}
