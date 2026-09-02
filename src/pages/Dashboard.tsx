import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listJobs, deleteJob } from '../lib/jobs'
import type { Job } from '../types'
import StatusBadge from '../components/StatusBadge'

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      setJobs(await listJobs())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  async function handleDelete(id: string) {
    if (!confirm('Delete this job? This removes the row and its uploaded/generated files cannot be reached again.')) return
    await deleteJob(id)
    refresh()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-slate-900">Your registers</h1>
        <Link
          to="/jobs/new"
          className="rounded-md bg-brand-600 text-white text-sm font-medium px-4 py-2 hover:bg-brand-700"
        >
          New register
        </Link>
      </div>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      {jobs === null && <p className="text-sm text-slate-400">Loading…</p>}

      {jobs !== null && jobs.length === 0 && (
        <div className="text-center py-16 border border-dashed border-slate-300 rounded-xl">
          <p className="text-slate-500 text-sm mb-4">You haven't built a register yet.</p>
          <Link to="/jobs/new" className="text-brand-600 font-medium text-sm">
            Upload a Tally GST-ledger PDF to get started →
          </Link>
        </div>
      )}

      {jobs !== null && jobs.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Company</th>
                <th className="text-left px-4 py-2 font-medium">Period</th>
                <th className="text-left px-4 py-2 font-medium">Source file</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link to={`/jobs/${job.id}`} className="font-medium text-brand-700 hover:underline">
                      {job.company}
                    </Link>
                    <div className="text-xs text-slate-400">{job.state}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{job.period}</td>
                  <td className="px-4 py-3 text-slate-600 truncate max-w-[16rem]">{job.source_filename}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-xs">{new Date(job.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(job.id)}
                      className="text-xs text-slate-400 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
