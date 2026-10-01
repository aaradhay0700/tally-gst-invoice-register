/**
 * voucherParser.ts
 *
 * TypeScript port of the skill's `scripts/extract_vouchers.py`. Pure logic,
 * no Node/Deno/browser-specific imports -- it takes the `pdftotext -layout`
 * -equivalent text of a Tally GST-ledger PDF (see pdfLayout.ts for how that
 * text is produced from the uploaded file) and reconstructs voucher-level
 * purchase rows from it.
 *
 * This file is deliberately kept import-free so the exact same source can
 * run unmodified under the Supabase Edge Function (Deno) and under the
 * local Node test harness in scripts/test-harness/ -- see that directory's
 * README for how the two are kept in sync.
 *
 * Read extract_vouchers.py's module docstring first if you haven't --it
 * explains *why* this reconstruction step exists (Tally reprints the same
 * journal voucher once per GST ledger it touches) and documents the
 * regex-based invoice/date/vendor extraction's "leave blank, never guess"
 * policy. This file mirrors that logic function-for-function; comments here
 * focus on the TS-specific translation, not on re-explaining the approach.
 */

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface RawEntry {
  ledger: string | null
  date: string | null
  drcr: string | null
  is_detail_entry: boolean
  is_bank: boolean
  vch_type: string | null
  vch_no: string | null
  entry_amount: string | null
  balance: string | null
  detail_lines: string[]
}

interface VoucherPre {
  ledger: string
  date: string | null
  drcr: string | null
  vch_type: string
  vch_no: string
  tax_amounts: Record<string, number>
  head_amounts: Record<string, number>
  vendor_candidates: [string, number][]
  taxable_candidates: [string, number][]
  narration: string
}

export interface Voucher {
  vch_type: string
  vch_no: string
  date: string | null
  drcr: string | null
  narration: string
  tax_amounts: Record<string, number>
  head_amounts: Record<string, number>
  vendor_candidates: [string, number][]
  taxable_candidates: [string, number][]
  ledgers_seen: string[]
  n_occurrences: number
}

export type TxnType = 'PURCHASE_INVOICE' | 'RCM_PURCHASE' | 'CREDIT_NOTE' | 'GST_REFUND_EXCLUDED'

export interface VoucherRow {
  txn_type: TxnType
  tally_date: string | null
  tally_date_raw: string | null
  vch_type: string
  vch_no: string
  drcr: string | null
  vendor_name_tally: string | null
  vendor_credit_amount: number | null
  taxable_value_tally: number | null
  cgst_tally: number
  sgst_tally: number
  igst_tally: number
  total_tax_tally: number
  gst_head_amounts_json: string
  gst_heads: string
  tally_invoice_no_raw: string | null
  tally_invoice_no_norm: string | null
  tally_invoice_date_raw: string | null
  tally_gstin: string | null
  narration: string
  ledgers_seen: string
  n_occurrences: number
}

export interface HeadMismatch {
  head: string
  raw_total: number
  reconstructed_total: number
  diff: number
}

export interface ExtractionResult {
  rows: VoucherRow[]
  mismatches: HeadMismatch[]
  rawEntryCount: number
  voucherCount: number
  txnTypeCounts: Record<string, number>
  purchaseInvoiceCount: number
  missingVendorCount: number
  missingInvoiceNoCount: number
  gstinFoundCount: number
}

// --------------------------------------------------------------------------
// Stage 1: split the layout text into raw (ledger, header, detail) entries
// --------------------------------------------------------------------------

const AMOUNT_TOKEN_RE = /[\d,]+\.\d{2}(?:\s*(?:Dr|Cr))?/g
const DATE_RE = /(\d{1,2}-[A-Za-z]{3}-\d{2,4})/

const TERMINATOR_PREFIXES = [
  'Carried Over',
  'Brought Forward',
  'By      Closing Balance',
  'By    Closing Balance',
  'By Closing Balance',
  'Group:',
  'Page',
  'Date',
  'CIN:',
  'continued',
  'Ledger:',
]

const CLOSING_BALANCE_RE = /\bClosing Balance\b/
const TWO_SPACE_SPLIT_RE = /\s{2,}/
const AMOUNT_ONLY_RE = /^[\d,]+\.\d{2}$/

export function isTerminator(s: string): boolean {
  if (s === '') return true
  for (const p of TERMINATOR_PREFIXES) {
    if (s.startsWith(p)) return true
  }
  // "By ... Closing Balance" lines use inconsistent internal spacing across
  // ledger pages (varies with column width), so an exact-prefix match on
  // TERMINATOR_PREFIXES can miss a spacing variant not in that fixed list.
  // Matching the phrase anywhere in the line is spacing-proof and this
  // phrase never occurs in genuine vendor/narration text.
  if (CLOSING_BALANCE_RE.test(s)) return true
  const cols = s.split(TWO_SPACE_SPLIT_RE)
  if (cols.length === 2 && cols.every((c) => AMOUNT_ONLY_RE.test(c))) return true // column-total line before a closing balance
  if (cols.length === 1 && AMOUNT_ONLY_RE.test(cols[0])) return true // a lone wrapped amount
  return false
}

function parseHeader(line: string, currentLedger: string | null) {
  const amtMatches = [...line.matchAll(AMOUNT_TOKEN_RE)]
  let balance: string | null = null
  let entryAmount: string | null = null
  let vchtextEnd = line.length
  if (amtMatches.length >= 2) {
    const last = amtMatches[amtMatches.length - 1]
    const secondLast = amtMatches[amtMatches.length - 2]
    balance = last[0].trim()
    entryAmount = secondLast[0].trim()
    vchtextEnd = secondLast.index ?? line.length
  } else if (amtMatches.length === 1) {
    entryAmount = amtMatches[0][0].trim()
    vchtextEnd = amtMatches[0].index ?? line.length
  }

  // pdfLayout.ts estimates a single median character width per PAGE, so the
  // reconstructed gap in front of a given marker (the "To"/"By" prefix,
  // "(as per details)") can land inside col0 on one page's occurrence of a
  // voucher and spill into its own 2+-space column on another page's
  // occurrence of the exact same voucher (same row content, different
  // page-level width estimate). A column-position-dependent parse (only
  // ever looking at col0) misses these markers unpredictably -- on a real
  // export that silently drops most journal entries from voucher
  // reconstruction, or (worse) misreads vch_type/vch_no often enough that
  // the same voucher's occurrences fail to de-dup into one group and get
  // double-counted. Scan the whole pre-amount text instead.
  const headText = line.slice(0, vchtextEnd)
  const dateMatch = DATE_RE.exec(headText)
  const date = dateMatch ? dateMatch[1] : null
  const drcr = /\bTo\b/.test(headText) ? 'To' : /\bBy\b/.test(headText) ? 'By' : null
  const isDetail = headText.includes('(as per details)')
  const isBank = /Bank A\/c/.test(headText)

  // vch_type/vch_no are whatever comes after '(as per details)' -- not
  // "whatever's left after removing known markers", because the fixture's
  // (and some real exports') Particulars text can carry a ledger-name prefix
  // before '(as per details)' (e.g. "To Purchase A/c (as per details)")
  // that must stay excluded rather than being misread as vch_type.
  let vchType: string | null = null
  let vchNo: string | null = null
  const detailIdx = headText.indexOf('(as per details)')
  const rest =
    detailIdx !== -1
      ? headText.slice(detailIdx + '(as per details)'.length)
      : headText.slice(dateMatch ? dateMatch.index + dateMatch[0].length : 0).replace(/\bTo\b|\bBy\b/, '')
  const midTokens = rest.split(TWO_SPACE_SPLIT_RE).map((t) => t.trim()).filter((t) => t !== '')
  if (midTokens.length === 1) {
    vchType = midTokens[0]
  } else if (midTokens.length >= 2) {
    vchType = midTokens[0]
    vchNo = midTokens[1]
  }

  return {
    ledger: currentLedger,
    date,
    drcr,
    is_detail_entry: isDetail,
    is_bank: isBank,
    vch_type: vchType,
    vch_no: vchNo,
    entry_amount: entryAmount,
    balance,
    detail_lines: [] as string[],
  } satisfies RawEntry
}

const LEDGER_LINE_RE = /Ledger:\s*(.+?)(?:\s*:\s*\d{1,2}-[A-Za-z]{3}-\d{2,4}.*)?$/
const BANK_HEADER_TRIGGER_RE = /\bBank A\/c\b.*(PAYMENT|RECEIPT)/

export function parseRawEntries(text: string): RawEntry[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let currentLedger: string | null = null
  const entries: RawEntry[] = []
  let currentEntry: RawEntry | null = null

  for (const raw of lines) {
    const line = raw.replace(/\f/g, '')
    const stripped = line.trim()
    if (stripped === '') {
      currentEntry = null
      continue
    }

    const mled = LEDGER_LINE_RE.exec(stripped)
    if (mled && (stripped.startsWith('Ledger:') || stripped.includes('Ledger:'))) {
      currentLedger = mled[1].trim()
      currentEntry = null
      continue
    }

    const headerTrigger = stripped.includes('(as per details)') || BANK_HEADER_TRIGGER_RE.test(stripped)
    if (headerTrigger) {
      const hdr = parseHeader(stripped, currentLedger)
      entries.push(hdr)
      currentEntry = hdr
      continue
    }

    if (currentEntry !== null) {
      if (isTerminator(stripped)) {
        currentEntry = null
        continue
      }
      currentEntry.detail_lines.push(stripped)
    }
  }

  // forward-fill missing dates within each ledger's own sequence
  const lastDate = new Map<string, string>()
  for (const e of entries) {
    const led = e.ledger ?? ''
    if (e.date) {
      lastDate.set(led, e.date)
    } else {
      e.date = lastDate.get(led) ?? null
    }
  }

  return entries
}

// --------------------------------------------------------------------------
// Stage 2: reconstruct full-journal vouchers from raw entries
// --------------------------------------------------------------------------

function classifyTaxLine(name: string): { ttype: string; isRc: boolean; isPayable: boolean } | null {
  const n = name.trim()
  if (!/\b(CGST|SGST|IGST)\b/i.test(n)) return null
  const isRc = /Reverse Charge/i.test(n)
  const isPayable = /Payable/i.test(n)
  const m = /(CGST|SGST|IGST)/i.exec(n)
  return { ttype: m![1].toUpperCase(), isRc, isPayable }
}

function ledgerNameToTax(ledgername: string): { ttype: string | null; isRc: boolean } {
  const n = ledgername.trim()
  const isRc = /Reverse Charge/i.test(n)
  const m = /(CGST|SGST|IGST)/i.exec(n)
  return { ttype: m ? m[1].toUpperCase() : null, isRc }
}

interface RateHeadInfo {
  head: string
  taxType: string
  isReverseCharge: boolean
  rate: number
}

/** Mirrors ledger_name_to_rate_head() -- see extract_vouchers.py for the
 * full rationale on why SGST folds into the matching CGST head. */
function ledgerNameToRateHead(ledgername: string): RateHeadInfo | null {
  const n = ledgername.trim()
  const isRc = /Reverse Charge/i.test(n)
  const m = /(CGST|SGST|IGST)\s+([\d.]+)\s*%/i.exec(n)
  if (!m) return null
  const ttype = m[1].toUpperCase()
  const rate = parseFloat(m[2])
  const rateStr = formatRate(rate)
  const labelType = ttype === 'IGST' ? 'IGST' : 'CGST'
  let head = `${labelType} ${rateStr}%`
  if (isRc) head += ' RCM'
  return { head, taxType: ttype, isReverseCharge: isRc, rate }
}

/** Python's f"{rate:g}" -- shortest decimal representation, no trailing
 * zeros (9.0 -> "9", 2.5 -> "2.5"). GST rate magnitudes never need
 * scientific notation, so a plain Number->String conversion matches. */
function formatRate(rate: number): string {
  return String(rate)
}

const INTERNAL_BLOCKLIST = new RegExp(
  String.raw`^(TDS|Short & Excess|Expenses Payable|Prepaid Expenses|GST Refund Filed|` +
    String.raw`CGST|SGST|IGST|.*\bPayable$|` +
    String.raw`.*Imprest Account$|` +
    String.raw`(HDFC|ICICI|AXIS|SBI|KOTAK|YES BANK|IDFC).*(BANK|CC|CARD)|` +
    String.raw`Security Expenses$|Office Expenses$|Staff Welfare$|Rent Paid|` +
    String.raw`Repair & Maintenance|Conveyance Expenses$|Travelling|` +
    String.raw`Software Expenses|Software/Subscription$|Computer Rent$|` +
    String.raw`Telephone Exp|Internet Exp|Fire Prevention Expense$|` +
    String.raw`Recruitment Expenses$|Printing & Stationery$|Legal & Professional Fees$|` +
    String.raw`Marketing & Other Support Services$|Staff Event Expense$|` +
    String.raw`Computer Supplies$|Rental Printer$|Air Conditioner-Cost$|` +
    String.raw`Office Equipment - Cost$|Pest Control Expenses$|` +
    String.raw`Professional Assistance$|Professional Assistance \(.*\)$)`,
  'i',
)

function parseAmount(s: string | null): number | null {
  if (s === null) return null
  const m = /^([\d.]+)\s*(Dr|Cr)?$/.exec(s.replace(/,/g, '').trim())
  if (!m) return null
  return parseFloat(m[1])
}

const TAX_LINE_VALUE_RE = /([\d,]+\.\d{2})\s*(Dr|Cr)?\s*$/
const NAMED_AMOUNT_LINE_RE = /^(.*?)\s{1,}([\d,]+\.\d{2})\s*(Dr|Cr)\s*$/

export function buildVouchers(entries: RawEntry[]): Voucher[] {
  const records: VoucherPre[] = []

  for (const e of entries) {
    if (!e.is_detail_entry) continue
    const { ttype, isRc } = ledgerNameToTax(e.ledger ?? '')
    const amt = parseAmount(e.entry_amount)
    const taxAmounts = new Map<string, number>()
    const headAmounts = new Map<string, number>()
    const addTax = (k: string, v: number) => taxAmounts.set(k, (taxAmounts.get(k) ?? 0) + v)
    const addHead = (k: string, v: number) => headAmounts.set(k, (headAmounts.get(k) ?? 0) + v)

    if (ttype && amt !== null) {
      addTax(`${ttype}${isRc ? '_RC' : ''}`, amt)
    }
    const headInfo = ledgerNameToRateHead(e.ledger ?? '')
    if (headInfo && amt !== null) {
      // Sum (not max) within one occurrence: the header CGST leg and a
      // matching SGST detail leg at the same rate are genuinely two
      // different legs that both belong to this head. Cross-occurrence
      // de-dup (the same voucher reprinted under a second ledger page)
      // happens later, via Math.max() at the grouping stage.
      addHead(headInfo.head, amt)
    }

    const vendorLines: [string, number][] = []
    const taxableLines: [string, number][] = []
    const narrationParts: string[] = []
    let inNarration = false

    for (const dl of e.detail_lines) {
      const cls = classifyTaxLine(dl)
      if (cls) {
        if (cls.isPayable) continue
        const mval = TAX_LINE_VALUE_RE.exec(dl)
        if (mval) {
          const val = parseFloat(mval[1].replace(/,/g, ''))
          addTax(`${cls.ttype}${cls.isRc ? '_RC' : ''}`, val)
          const dlHeadInfo = ledgerNameToRateHead(dl)
          if (dlHeadInfo) addHead(dlHeadInfo.head, val)
        }
        continue
      }
      if (dl.startsWith('Being') || inNarration) {
        inNarration = true
        narrationParts.push(dl)
        continue
      }
      const mline = NAMED_AMOUNT_LINE_RE.exec(dl)
      if (mline) {
        const name = mline[1].trim()
        const val = parseFloat(mline[2].replace(/,/g, ''))
        const drcr2 = mline[3]
        if (INTERNAL_BLOCKLIST.test(name)) continue
        ;(drcr2 === 'Cr' ? vendorLines : taxableLines).push([name, val])
      } else {
        narrationParts.push(dl)
        inNarration = true
      }
    }

    const narration = narrationParts.join(' ').replace(/\s+/g, ' ').trim()
    records.push({
      ledger: e.ledger ?? '',
      date: e.date,
      drcr: e.drcr,
      vch_type: (e.vch_type ?? '').trim(),
      vch_no: (e.vch_no ?? '').trim(),
      tax_amounts: Object.fromEntries(taxAmounts),
      head_amounts: Object.fromEntries(headAmounts),
      vendor_candidates: vendorLines,
      taxable_candidates: taxableLines,
      narration,
    })
  }

  const groups = new Map<string, VoucherPre[]>()
  for (const r of records) {
    const key = JSON.stringify([r.vch_type, r.vch_no, r.date, r.narration])
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }

  const vouchers: Voucher[] = []
  for (const [key, rs] of groups) {
    const [vchType, vchNo, date, narration] = JSON.parse(key) as [string, string, string | null, string]
    const mergedTax = new Map<string, number>()
    const mergedHeads = new Map<string, number>()
    const ledgersSeen = new Set<string>()
    let vendorCandidatesRaw: [string, number][] = []
    let taxableCandidatesRaw: [string, number][] = []

    for (const r of rs) {
      ledgersSeen.add(r.ledger)
      for (const [k, v] of Object.entries(r.tax_amounts)) {
        mergedTax.set(k, Math.max(mergedTax.get(k) ?? 0, v))
      }
      for (const [k, v] of Object.entries(r.head_amounts)) {
        mergedHeads.set(k, Math.max(mergedHeads.get(k) ?? 0, v))
      }
      vendorCandidatesRaw = vendorCandidatesRaw.concat(r.vendor_candidates)
      taxableCandidatesRaw = taxableCandidatesRaw.concat(r.taxable_candidates)
    }

    vouchers.push({
      vch_type: vchType,
      vch_no: vchNo,
      date,
      drcr: rs[0].drcr,
      narration,
      tax_amounts: Object.fromEntries(mergedTax),
      head_amounts: Object.fromEntries(mergedHeads),
      vendor_candidates: dedupeTuples(vendorCandidatesRaw),
      taxable_candidates: dedupeTuples(taxableCandidatesRaw),
      ledgers_seen: [...ledgersSeen].sort(),
      n_occurrences: rs.length,
    })
  }
  return vouchers
}

function dedupeTuples(list: [string, number][]): [string, number][] {
  const seen = new Set<string>()
  const out: [string, number][] = []
  for (const t of list) {
    const key = JSON.stringify(t)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(t)
    }
  }
  return out
}

/** Mirrors verify_head_totals() -- see its Python docstring for the full
 * explanation of what a mismatch means and how to diagnose it. This is the
 * self-check whose PASS/FAIL result gates whether the register is safe to
 * build; the UI must show a FAILED result prominently, not bury it. */
export function verifyHeadTotals(entries: RawEntry[], vouchers: Voucher[], tolerance = 0.02): HeadMismatch[] {
  const rawByHead = new Map<string, number>()
  for (const e of entries) {
    if (!e.is_detail_entry || e.entry_amount === null) continue
    const headInfo = ledgerNameToRateHead(e.ledger ?? '')
    if (!headInfo) continue
    const amt = parseAmount(e.entry_amount)
    if (amt === null) continue
    rawByHead.set(headInfo.head, (rawByHead.get(headInfo.head) ?? 0) + amt)
  }

  const reconByHead = new Map<string, number>()
  for (const v of vouchers) {
    for (const [h, a] of Object.entries(v.head_amounts)) {
      reconByHead.set(h, (reconByHead.get(h) ?? 0) + a)
    }
  }

  const heads = new Set<string>([...rawByHead.keys(), ...reconByHead.keys()])
  const mismatches: HeadMismatch[] = []
  for (const head of [...heads].sort()) {
    const rawTotal = rawByHead.get(head) ?? 0
    const reconTotal = reconByHead.get(head) ?? 0
    const diff = reconTotal - rawTotal
    if (Math.abs(diff) > tolerance) {
      mismatches.push({ head, raw_total: rawTotal, reconstructed_total: reconTotal, diff })
    }
  }
  return mismatches
}

// --------------------------------------------------------------------------
// Stage 3: classify, extract vendor/invoice fields, tabulate
// --------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

const INV_PATTERNS: RegExp[] = [
  String.raw`(?:Invoice|Inv|Bill)\.?\s*(?:No\.?|Number|#)\s*[:\s\-–—]*([A-Za-z0-9][A-Za-z0-9/\-.]{1,30})`,
  String.raw`vide\s+(?:Inv|Invoice|Bill)\.?\s*(?:No\.?)?\s*:?\s*([A-Za-z0-9][A-Za-z0-9/\-.]{1,30})`,
  String.raw`via\s+(?:invoice|inv|bill)\s*(?:no\.?)?\s*:?\s*([A-Za-z0-9][A-Za-z0-9/\-.]{1,30})`,
  String.raw`against\s+(?:the\s+)?(?:inv|invoice|bill)\s*(?:no\.?)?\s*:?\s*([A-Za-z0-9][A-Za-z0-9/\-.]{1,30})`,
  String.raw`agst\s+(?:the\s+)?(?:inv|invoice|bill)\s*(?:no\.?)?\s*:?\s*([A-Za-z0-9][A-Za-z0-9/\-.]{1,30})`,
  String.raw`invoice\s+no\s*[:.]?\s*([A-Za-z0-9][A-Za-z0-9/\-.]{1,30})`,
  String.raw`inv\s+no\s*[:.]?\s*([A-Za-z0-9][A-Za-z0-9/\-.]{1,30})`,
  String.raw`Invoices?\s+(?:No|number)\s*[:.]?\s*([A-Za-z0-9][A-Za-z0-9/\-.]{1,30})`,
  String.raw`Invn\.?\s*(?:No\.?)?\s*:?\s*([A-Za-z0-9][A-Za-z0-9/\-.]{1,30})`,
  String.raw`as\s+per\s+Invoice\s+([A-Za-z0-9][A-Za-z0-9/\-.]{1,30})`,
  // Generic fallback: "Invoice <code>" with no "No"/"Number" in between --
  // kept last (lowest priority) so more specific patterns above win first.
  String.raw`\bInvoice\s+(?!No\b|Number\b)([A-Za-z0-9][A-Za-z0-9/\-.]{1,30})`,
].map((p) => new RegExp(p, 'i'))

// pdfLayout.ts's per-page character-width estimate occasionally inserts a
// spurious space inside what was one contiguous run in the source PDF (seen
// in practice inside a narration date, e.g. "dated : 04-05-26" reconstructed
// as "04 -05-26") -- \s* around each separator tolerates that; extractInvoiceDate
// below strips it back out of the captured value via tightenDateSeparators.
const DATE_PATTERNS: RegExp[] = [
  String.raw`[Dd]ated?\s*:?\s*(\d{1,2}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{2,4})`,
  String.raw`[Dd]ated?\s*:?\s*(\d{1,2}\s*-\s*[A-Za-z]{3,9}\s*-\s*\d{2,4})`,
  String.raw`[Dd]ated?\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})`,
  String.raw`[Dd]t\.?\s*(\d{1,2}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{2,4})`,
  String.raw`dt\s+(\d{1,2}\s*-\s*\d{1,2}\s*-\s*\d{2,4})`,
].map((p) => new RegExp(p))

function tightenDateSeparators(s: string): string {
  return s.replace(/\s*([.\-/])\s*/g, '$1')
}

const NARRATION_VENDOR_PATTERNS: RegExp[] = [
  String.raw`(?:amount\s+)?(?:paid|payable)\s+to\s+([A-Z][A-Za-z0-9&,.'/ \-]+?)\s+(?:agst|towards|for|vide|via|against|Vide|Invoice)`,
  String.raw`to\s+([A-Z][A-Za-z0-9&,.'/ \-]{3,40}?)\s+(?:agst|towards|for)\s`,
  // Credit notes flip the Dr/Cr sign on the vendor ledger line, so the
  // line-based heuristic above often finds nothing -- fall back to the
  // narration's own "received from X" / "issued by X" phrasing.
  String.raw`received\s+from\s+([A-Z][A-Za-z0-9&,.'/ \-]+?)\s+(?:against|agst|vide|via|towards|dated)`,
  String.raw`(?:credit\s+note|debit\s+note)\s+(?:received\s+)?from\s+([A-Z][A-Za-z0-9&,.'/ \-]{3,40}?)\b`,
].map((p) => new RegExp(p, 'i'))

const REFUND_RE = /GST Refund Filed/i
const CREDIT_NOTE_RE = /Credit Note/i
const RCM_FOREIGN_RE = /\bUSD\b/i

// GSTIN: 2-digit state code + 10-char PAN (5 letters, 4 digits, 1 letter) +
// 1-digit entity code + literal "Z" + 1 alphanumeric checksum = 15 chars.
const GSTIN_RE = /\b(\d{2}[A-Za-z]{5}\d{4}[A-Za-z]{1}[A-Za-z\d]{1}Z[A-Za-z\d]{1})\b/

const INV_NO_BLOCKLIST = new Set([
  'the', 'a', 'of', 'no', 'number', 'dated', 'date', 'for', 'via', 'vide',
  'against', 'agst', 'from', 'on', 'and', 'to', 'is', 'was', 'as', 'per',
])

function extractGstin(text: string | null): string | null {
  if (!text) return null
  const m = GSTIN_RE.exec(text)
  return m ? m[1].toUpperCase() : null
}

function parseTallyDate(d: string | null): string | null {
  if (!d) return null
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/.exec(d)
  if (!m) return null
  const [, dd, mon, yy] = m
  const yyyy = yy.length === 4 ? yy : '20' + yy
  const mm = MONTHS[mon] ?? '01'
  return `${yyyy}-${mm}-${String(parseInt(dd, 10)).padStart(2, '0')}`
}

export function extractInvoiceNo(narration: string): string | null {
  for (const re of INV_PATTERNS) {
    const m = re.exec(narration)
    if (m) {
      let val = m[1].trim().replace(/[.,]+$/, '')
      // PDF line-wrap sometimes glues the next word onto the captured code
      // with no space (e.g. "...FDINR106461Invoice\nDate-- Jul 03" becomes
      // "FDINR106461Invoice" once dehyphenated). Strip a trailing glued
      // "Invoice"/"Date" only when at least 3 chars of code remain, so real
      // codes aren't truncated.
      const stripped = val.replace(/(invoice|date)$/i, '')
      if (stripped.length >= 3) val = stripped
      if (!INV_NO_BLOCKLIST.has(val.toLowerCase())) return val
    }
  }
  return null
}

export function extractInvoiceDate(narration: string): string | null {
  for (const re of DATE_PATTERNS) {
    const m = re.exec(narration)
    if (m) return tightenDateSeparators(m[1])
  }
  return null
}

function extractVendorFromNarration(narration: string): string | null {
  for (const re of NARRATION_VENDOR_PATTERNS) {
    const m = re.exec(narration)
    if (m) {
      const v = m[1].trim().replace(/[.,]+$/, '')
      if (v.length >= 3 && v.length <= 45) return v
    }
  }
  return null
}

export function normaliseInvNo(s: string | null): string | null {
  return s ? s.replace(/[\s/.-]/g, '').toUpperCase() : null
}

function pickVendor(vlist: [string, number][], narration: string): [string | null, number | null] {
  if (vlist.length > 0) {
    return [...vlist].sort((a, b) => b[1] - a[1])[0]
  }
  const v = extractVendorFromNarration(narration)
  return v ? [v, null] : [null, null]
}

function pickTaxable(tlist: [string, number][]): number | null {
  if (tlist.length === 0) return null
  return [...tlist].sort((a, b) => b[1] - a[1])[0][1]
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function classifyAndTabulate(vouchers: Voucher[]): VoucherRow[] {
  const rows: VoucherRow[] = []
  for (const v of vouchers) {
    const narration = v.narration
    const tax = v.tax_amounts
    const cgst = (tax['CGST'] ?? 0) + (tax['CGST_RC'] ?? 0)
    const sgst = (tax['SGST'] ?? 0) + (tax['SGST_RC'] ?? 0)
    const igst = (tax['IGST'] ?? 0) + (tax['IGST_RC'] ?? 0)
    const isRcm = Object.keys(tax).some((k) => k.endsWith('_RC'))

    const [vendor, vendorAmt] = pickVendor(v.vendor_candidates, narration)
    const taxable = pickTaxable(v.taxable_candidates)

    const gstinSearchText = [
      narration,
      v.vendor_candidates.map(([n]) => n).join(' '),
      v.taxable_candidates.map(([n]) => n).join(' '),
    ].join(' ')
    const gstin = extractGstin(gstinSearchText)

    let txnType: TxnType
    if (REFUND_RE.test(narration)) txnType = 'GST_REFUND_EXCLUDED'
    else if (CREDIT_NOTE_RE.test(narration) || v.drcr === 'By') txnType = 'CREDIT_NOTE'
    else if (RCM_FOREIGN_RE.test(narration) || isRcm) txnType = 'RCM_PURCHASE'
    else txnType = 'PURCHASE_INVOICE'

    const invNo = extractInvoiceNo(narration)
    const headAmounts: Record<string, number> = {}
    for (const [h, a] of Object.entries(v.head_amounts)) {
      const r = round2(a)
      if (r !== 0) headAmounts[h] = r
    }

    rows.push({
      txn_type: txnType,
      tally_date: parseTallyDate(v.date),
      tally_date_raw: v.date,
      vch_type: v.vch_type,
      vch_no: v.vch_no,
      drcr: v.drcr,
      vendor_name_tally: vendor,
      vendor_credit_amount: vendorAmt,
      taxable_value_tally: taxable,
      cgst_tally: round2(cgst),
      sgst_tally: round2(sgst),
      igst_tally: round2(igst),
      total_tax_tally: round2(cgst + sgst + igst),
      gst_head_amounts_json: JSON.stringify(headAmounts),
      gst_heads: Object.keys(headAmounts).sort().join(';'),
      tally_invoice_no_raw: invNo,
      tally_invoice_no_norm: normaliseInvNo(invNo),
      tally_invoice_date_raw: extractInvoiceDate(narration),
      tally_gstin: gstin,
      narration,
      ledgers_seen: v.ledgers_seen.join(';'),
      n_occurrences: v.n_occurrences,
    })
  }
  return rows
}

// --------------------------------------------------------------------------
// Top-level orchestrator + CSV serialisation (for the audit-trail CSV that
// mirrors extract_vouchers.py's tally_vouchers.csv output)
// --------------------------------------------------------------------------

// XML 1.0's Char production excludes every C0 control code other than
// tab/LF/CR, plus the C1 range up to 0x9F. A stray byte from a PDF font's
// encoding table (mis-mapped glyphs, a bad cmap) can land in extracted
// narration/vendor text as one of these; exceljs writes cell text straight
// into the workbook's XML without stripping them, so the resulting .xlsx has
// invalid XML inside it. Excel still opens it, but only after showing "we
// found a problem with some content, do you want us to recover" -- which
// reads as "this file is broken" even though the recovered data is correct.
// Stripping them here (once, before any of the text-shape parsing below)
// fixes both the .xlsx and the audit CSV, since both are built from these
// same extracted strings.
const XML_INVALID_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g

export function extractVouchers(rawLayoutText: string): ExtractionResult {
  const layoutText = rawLayoutText.replace(XML_INVALID_CHARS_RE, '')
  const entries = parseRawEntries(layoutText)
  const vouchers = buildVouchers(entries)
  const rows = classifyAndTabulate(vouchers)
  const mismatches = verifyHeadTotals(entries, vouchers)

  const txnTypeCounts: Record<string, number> = {}
  for (const r of rows) {
    txnTypeCounts[r.txn_type] = (txnTypeCounts[r.txn_type] ?? 0) + 1
  }
  const purchaseRows = rows.filter((r) => r.txn_type === 'PURCHASE_INVOICE')
  const missingVendorCount = purchaseRows.filter((r) => !r.vendor_name_tally).length
  const missingInvoiceNoCount = purchaseRows.filter((r) => !r.tally_invoice_no_raw).length
  const gstinFoundCount = purchaseRows.filter((r) => !!r.tally_gstin).length

  return {
    rows,
    mismatches,
    rawEntryCount: entries.length,
    voucherCount: vouchers.length,
    txnTypeCounts,
    purchaseInvoiceCount: purchaseRows.length,
    missingVendorCount,
    missingInvoiceNoCount,
    gstinFoundCount,
  }
}

const CSV_COLUMNS: (keyof VoucherRow)[] = [
  'txn_type', 'tally_date', 'tally_date_raw', 'vch_type', 'vch_no', 'drcr',
  'vendor_name_tally', 'vendor_credit_amount', 'taxable_value_tally',
  'cgst_tally', 'sgst_tally', 'igst_tally', 'total_tax_tally',
  'gst_head_amounts_json', 'gst_heads', 'tally_invoice_no_raw',
  'tally_invoice_no_norm', 'tally_invoice_date_raw', 'tally_gstin',
  'narration', 'ledgers_seen', 'n_occurrences',
]

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export function rowsToCsv(rows: VoucherRow[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((c) => csvEscape(row[c])).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

// --------------------------------------------------------------------------
// Header metadata (company / state / period) for browser-local mode
// --------------------------------------------------------------------------

export interface LedgerMeta {
  company: string | null
  state: string | null
  periodStartRaw: string | null
  periodEndRaw: string | null
}

const PERIOD_RE = /(\d{1,2}-[A-Za-z]{3}-\d{2,4})\s+to\s+(\d{1,2}-[A-Za-z]{3}-\d{2,4})/
const GROUP_STATE_RE = /^Group:\s*GST[-\s]+(.+?)\s*$/i

/**
 * Best-effort read of the printout's own header. Anything not found comes
 * back null so callers can show "(not detected)" instead of a guess.
 *   - company: first non-blank line that isn't a Group:/Ledger:/Date/Page line
 *   - state:   from a "Group: GST-<State>" line
 *   - period:  first "<d-Mon-yy> to <d-Mon-yy>" range in the text
 */
export function extractLedgerMeta(rawLayoutText: string): LedgerMeta {
  const lines = rawLayoutText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let company: string | null = null
  let state: string | null = null
  let periodStartRaw: string | null = null
  let periodEndRaw: string | null = null

  for (const line of lines) {
    if (!state) {
      const g = GROUP_STATE_RE.exec(line)
      if (g) state = g[1]
    }
    if (!periodStartRaw) {
      const p = PERIOD_RE.exec(line)
      if (p) [, periodStartRaw, periodEndRaw] = p
    }
    if (!company && !/^(Group:|Ledger:|Date\b|Page\b|CIN:|continued)/i.test(line) && !DATE_RE.test(line)) {
      company = line.split(TWO_SPACE_SPLIT_RE)[0]
    }
    if (company && state && periodStartRaw) break
  }
  return { company, state, periodStartRaw, periodEndRaw }
}
