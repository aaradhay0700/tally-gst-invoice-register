import { Link, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabaseClient'

export default function Layout({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const navigate = useNavigate()

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="font-semibold text-brand-900">
            Tally GST Invoice Register
          </Link>
          {session && (
            <div className="flex items-center gap-4 text-sm">
              <span className="text-slate-500">{session.user.email}</span>
              <button onClick={handleSignOut} className="text-brand-600 font-medium hover:text-brand-700">
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-8">{children}</main>
      <footer className="border-t border-slate-200 py-4">
        <p className="max-w-5xl mx-auto px-4 text-xs text-slate-400">
          Upload a Tally GST-ledger PDF and get back a formatted, per-rate invoice register. Refund vouchers are
          excluded by default; every kept voucher is shown even when a field is missing.
        </p>
      </footer>
    </div>
  )
}
