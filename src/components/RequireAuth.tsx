import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()

  if (loading) {
    return <div className="max-w-5xl mx-auto px-4 py-16 text-center text-slate-400 text-sm">Loading…</div>
  }
  if (!session) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}
