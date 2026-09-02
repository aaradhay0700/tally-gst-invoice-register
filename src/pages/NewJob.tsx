import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { createAndRunJob } from '../lib/jobs'

export default function NewJob() {
  const [file, setFile] = useState<File | null>(null)
  const [company, setCompany] = useState('')
  const [state, setState] = useState('')
  const [period, setPeriod] = useState('')
  const [includeRefunds, setIncludeRefunds] = useState(false)
  const [requireReference, setRequireReference] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setError(null)
    setStage('Starting…')
    try {
      const job = await createAndRunJob(
        { file, company, state, period, includeRefunds, requireReference },
        (s) => setStage(s),
      )
      navigate(`/jobs/${job.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage(null)
    }
  }

  const busy = stage !== null

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold text-slate-900 mb-1">New invoice register</h1>
      <p className="text-sm text-slate-500 mb-6">
        Upload a Tally-exported GST ledger PDF (a control-account printout with "(as per details)" journal
        breakdowns, one page per CGST/SGST/IGST rate) — not a flat purchase register. See the source skill's docs
        if you're not sure which shape you have.
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

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Company name</label>
            <input
              type="text"
              required
              disabled={busy}
              placeholder="e.g. Sand Martin Consultants Pvt Ltd"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">State</label>
            <input
              type="text"
              required
              disabled={busy}
              placeholder="e.g. Uttar Pradesh"
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Period</label>
          <input
            type="text"
            required
            disabled={busy}
            placeholder="e.g. 1-Apr-2026 to 30-Jun-2026"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
          <p className="text-xs text-slate-400 mt-1">Pull these three fields straight from the PDF's own header text.</p>
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
                Off by default (safer for an audit trail). Turning this on drops purely internal postings (rent,
                retainers) that have nothing document-like in the narration — everything else stays, with missing
                fields flagged rather than dropped.
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
    </div>
  )
}
