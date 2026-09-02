import { useState, type FormEvent } from 'react'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pdfBufferToLayoutText } from '../../supabase/functions/process-ledger/shared/pdfLayout.ts'
import { extractVouchers, extractLedgerMeta, rowsToCsv, type ExtractionResult } from '../../supabase/functions/process-ledger/shared/voucherParser.ts'
import { loadRecords, buildWorkbook, summarizeRecords, fmtDate } from '../../supabase/functions/process-ledger/shared/registerBuilder.ts'

// pdfLayout.ts deliberately leaves GlobalWorkerOptions unset so the same
// source works under Deno/Node's "fake worker" fallback (see that file's
// module docstring). A real bundled browser doesn't take that fallback --
// pdf.js just hangs waiting for a worker that never spins up -- so this
// browser-only entry point points it at the worker script Vite bundles as
// an asset (the `new URL(..., import.meta.url)` form is what lets Vite
// recognize and emit it).
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString()

function downloadBlob(data: BlobPart, filename: string, type: string) {
  const blob = new Blob([data], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

interface RunResult {
  extraction: ExtractionResult
  sheets: string[]
  creditNoteCount: number
  noInvoiceCount: number
  xlsxBuffer: ArrayBuffer
  csv: string
  baseFilename: string
  company: string
  state: string
  period: string
}

export default function LocalConvert() {
  const [file, setFile] = useState<File | null>(null)
  const [includeRefunds, setIncludeRefunds] = useState(false)
  const [requireReference, setRequireReference] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setError(null)
    setResult(null)
    try {
      setStage('Reading PDF…')
      const pdfBytes = new Uint8Array(await file.arrayBuffer())

      setStage('Reconstructing ledger layout…')
      const layoutText = await pdfBufferToLayoutText(pdfBytes)

      setStage('Reading company / state / period from the PDF header…')
      const meta = extractLedgerMeta(layoutText)
      const company = meta.company ?? '(company not detected)'
      const state = meta.state ?? '(state not detected)'
      const period =
        meta.periodStartRaw && meta.periodEndRaw
          ? `${fmtDate(meta.periodStartRaw)} to ${fmtDate(meta.periodEndRaw)}`
          : '(period not detected)'

      setStage('Reconstructing vouchers and verifying GST-rate totals…')
      const extraction = extractVouchers(layoutText)

      setStage('Building the Excel workbook…')
      const records = loadRecords(extraction.rows, includeRefunds, requireReference)
      const wb = buildWorkbook({ records, company, state, period, notesExtra: [] })
      const summary = summarizeRecords(records)
      const xlsxBuffer = await wb.xlsx.writeBuffer()
      const csv = rowsToCsv(extraction.rows)

      setResult({
        extraction,
        sheets: summary.sheets,
        creditNoteCount: summary.creditNoteCount,
        noInvoiceCount: summary.noInvoiceCount,
        xlsxBuffer: xlsxBuffer as ArrayBuffer,
        csv,
        baseFilename: file.name.replace(/\.pdf$/i, '') || 'invoice-register',
        company,
        state,
        period,
      })
      setStage(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage(null)
    }
  }

  const busy = stage !== null
  const mismatches = result?.extraction.mismatches ?? []
  const verificationPassed = result !== null && mismatches.length === 0

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold text-slate-900 mb-1">New invoice register (local mode)</h1>
      <p className="text-sm text-slate-500 mb-6">
        Runs entirely in this browser tab — no sign-in, no upload to any server. Upload a Tally-exported GST ledger
        PDF (a control-account printout with "(as per details)" journal breakdowns, one page per CGST/SGST/IGST
        rate) and download the formatted Excel register directly. Company name, state and period are read straight
        from the PDF's own header — check the detected values in the results below before trusting the file.
      </p>

      <form onSubmit={handleSubmit} className="space-y-5 bg-white border border-slate-200 rounded-xl p-6">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Tally GST-ledger PDF</label>
          <input
            type="file"
            accept="application/pdf"
            required
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-600 file:mr-4 file:rounded-md file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
          />
        </div>

        <div className="space-y-2 pt-2 border-t border-slate-100">
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              disabled={busy}
              checked={includeRefunds}
              onChange={(e) => setIncludeRefunds(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Include GST refund vouchers
              <span className="block text-xs text-slate-400">
                Off by default — a refund references a return period, not an invoice, so most registers exclude it.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              disabled={busy}
              checked={requireReference}
              onChange={(e) => setRequireReference(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Require an invoice number or vendor name
              <span className="block text-xs text-slate-400">
                Off by default (safer for an audit trail). Turning this on drops purely internal postings that have
                nothing document-like in the narration — everything else stays, with missing fields flagged rather
                than dropped.
              </span>
            </span>
          </label>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {stage && <p className="text-sm text-brand-700">{stage}</p>}

        <button
          type="submit"
          disabled={busy || !file}
          className="w-full rounded-md bg-brand-600 text-white text-sm font-medium py-2.5 hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? 'Working…' : 'Build register'}
        </button>
      </form>

      {result && (
        <div className="mt-6 space-y-4">
          <div
            className={`rounded-xl border p-4 text-sm ${
              verificationPassed ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-300 bg-red-50 text-red-800'
            }`}
          >
            <p className="font-semibold">
              GST-rate verification: {verificationPassed ? 'PASSED' : 'FAILED'}
            </p>
            {!verificationPassed && (
              <>
                <p className="mt-1">
                  The reconstructed per-head totals don't match the ledger's own raw totals. This usually means this
                  PDF's column layout or phrasing doesn't quite match what the parser expects — check the audit CSV
                  against the source PDF before trusting the numbers.
                </p>
                <table className="mt-2 w-full text-xs">
                  <thead>
                    <tr className="text-left">
                      <th className="pr-3 py-1">Head</th>
                      <th className="pr-3 py-1">Raw total</th>
                      <th className="pr-3 py-1">Reconstructed</th>
                      <th className="py-1">Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mismatches.map((m) => (
                      <tr key={m.head}>
                        <td className="pr-3 py-1">{m.head}</td>
                        <td className="pr-3 py-1">{m.raw_total.toFixed(2)}</td>
                        <td className="pr-3 py-1">{m.reconstructed_total.toFixed(2)}</td>
                        <td className="py-1">{m.diff.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700 space-y-1">
            <p>Detected from the PDF: <span className="font-medium">{result.company}</span> — GST {result.state}, period {result.period}.</p>
            <p><span className="font-medium">{result.extraction.voucherCount}</span> vouchers reconstructed from <span className="font-medium">{result.extraction.rawEntryCount}</span> raw ledger entries.</p>
            <p><span className="font-medium">{result.extraction.purchaseInvoiceCount}</span> purchase invoices, <span className="font-medium">{result.creditNoteCount}</span> credit notes.</p>
            <p><span className="font-medium">{result.extraction.missingVendorCount}</span> missing vendor name, <span className="font-medium">{result.extraction.missingInvoiceNoCount}</span> missing invoice number, <span className="font-medium">{result.noInvoiceCount}</span> rows show "(no inv. no. stated)" on the register.</p>
            <p>Sheets: {result.sheets.join(', ')}</p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() =>
                downloadBlob(
                  result.xlsxBuffer,
                  `${result.baseFilename}.xlsx`,
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                )
              }
              className="rounded-md bg-brand-600 text-white text-sm font-medium px-4 py-2 hover:bg-brand-700"
            >
              Download Excel (.xlsx)
            </button>
            <button
              onClick={() => downloadBlob(result.csv, `${result.baseFilename}_vouchers.csv`, 'text/csv')}
              className="rounded-md border border-slate-300 text-slate-700 text-sm font-medium px-4 py-2 hover:bg-slate-50"
            >
              Download audit CSV
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
