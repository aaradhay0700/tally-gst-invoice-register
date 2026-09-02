import type { JobStatus } from '../types'

const STYLES: Record<JobStatus, string> = {
  pending: 'bg-slate-100 text-slate-600',
  processing: 'bg-amber-100 text-amber-700',
  done: 'bg-emerald-100 text-emerald-700',
  error: 'bg-red-100 text-red-700',
}

const LABELS: Record<JobStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  done: 'Done',
  error: 'Error',
}

export default function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STYLES[status]}`}>
      {LABELS[status]}
    </span>
  )
}
