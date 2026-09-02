// Mirrors the `jobs` table defined in supabase/migrations/*_init.sql.
export type JobStatus = 'pending' | 'processing' | 'done' | 'error'

export interface HeadMismatch {
  head: string
  raw_total: number
  reconstructed_total: number
  diff: number
}

export interface JobStats {
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

export interface Job {
  id: string
  user_id: string
  created_at: string
  updated_at: string
  status: JobStatus
  error_message: string | null

  // Run parameters, set at upload time
  company: string
  state: string
  period: string
  include_refunds: boolean
  require_reference: boolean

  // Storage paths (private bucket object paths, not public URLs)
  source_filename: string
  pdf_storage_path: string
  csv_storage_path: string | null
  xlsx_storage_path: string | null

  // Filled in once processing finishes
  stats: JobStats | null
}
