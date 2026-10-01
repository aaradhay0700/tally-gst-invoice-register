/**
 * registerBuilder.ts
 *
 * TypeScript port of the skill's `scripts/build_invoice_register.py`. Turns
 * the VoucherRow[] produced by voucherParser.ts into a formatted Excel
 * workbook: a 'Master' tab listing every voucher, plus one tab per GST
 * rate/type actually present in the data, plus a 'Notes' tab -- exactly
 * matching the Python script's sheet layout, styling and formulas.
 *
 * Import note: this file imports 'exceljs' as a bare specifier so the exact
 * same source runs under both the Supabase Edge Function (Deno, via the
 * import map in supabase/functions/process-ledger/deno.json which points
 * "exceljs" at npm:exceljs) and the local Node test harness in
 * scripts/test-harness/ (via a normal node_modules install). Don't switch
 * this to an `npm:` specifier -- that only works under Deno and would break
 * the Node test harness.
 */
import ExcelJS from 'exceljs'
import type { VoucherRow } from './voucherParser.ts'

const FONT_NAME = 'Calibri'

export interface RegisterRecord {
  vch_date: string
  sort_date: string
  inv_date: string
  party: string
  vch_type: string
  vch_no: string
  doc_type: string
  inv_no: string
  description: string
  heads: Record<string, number>
}

// --------------------------------------------------------------------------
// Record loading / filtering (mirrors load_records())
// --------------------------------------------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** tally_date_raw looks like '3-Apr-26' or '18-May-2026'; normalise to
 * DD-MMM-YYYY for display. Falls back to the raw string if unparsed. */
export function fmtDate(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw).trim()
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(s)
  if (!m) return s
  const [, ddStr, monStr, yyStr] = m
  const monIdx = MONTH_NAMES.findIndex((mn) => mn.toLowerCase() === monStr.toLowerCase())
  const dd = parseInt(ddStr, 10)
  if (monIdx === -1 || dd < 1 || dd > 31) return s
  const yyyy = yyStr.length === 4 ? parseInt(yyStr, 10) : 2000 + parseInt(yyStr, 10)
  return `${String(dd).padStart(2, '0')}-${MONTH_NAMES[monIdx]}-${yyyy}`
}

function docTypeFor(row: VoucherRow): string {
  if (row.txn_type === 'CREDIT_NOTE') return 'Credit Note'
  const narration = (row.narration ?? '').toLowerCase()
  if (narration.includes('bill no') || narration.includes('vide bill')) return 'Bill'
  return 'Invoice'
}

export function loadRecords(
  rows: VoucherRow[],
  includeRefunds: boolean,
  requireReference: boolean,
): RegisterRecord[] {
  const records: RegisterRecord[] = []
  for (const row of rows) {
    if (row.txn_type === 'GST_REFUND_EXCLUDED' && !includeRefunds) continue

    let heads: Record<string, number> = {}
    try {
      const parsed = JSON.parse(row.gst_head_amounts_json || '{}') as Record<string, unknown>
      for (const [h, a] of Object.entries(parsed)) {
        const num = Number(a)
        if (num !== 0) heads[h] = num
      }
    } catch {
      heads = {}
    }
    if (Object.keys(heads).length === 0) continue // nothing to attribute to any sheet

    const invNo = row.tally_invoice_no_raw || ''
    const vendor = row.vendor_name_tally || ''
    if (requireReference && !invNo && !vendor) continue

    records.push({
      vch_date: fmtDate(row.tally_date_raw),
      sort_date: row.tally_date || '1900-01-01',
      inv_date: row.tally_invoice_date_raw || '(not specified)',
      party: vendor || '(vendor not identified in narration)',
      vch_type: row.vch_type || '',
      vch_no: row.vch_no || '',
      doc_type: docTypeFor(row),
      inv_no: invNo || '(no inv. no. stated)',
      description: row.narration || '',
      heads,
    })
  }
  return records
}

// --------------------------------------------------------------------------
// Sheet ordering (mirrors head_sort_key())
// --------------------------------------------------------------------------

/** Order sheets the way an accountant would scan them: local (CGST-
 * labelled) rates ascending, then their RCM variant, then interstate (IGST)
 * rates ascending, then their RCM variant. */
function headSortKey(head: string): [number, number, number] {
  const isRcm = head.endsWith('RCM')
  const base = (isRcm ? head.slice(0, -4) : head).trim()
  const spaceIdx = base.indexOf(' ')
  const kind = base.slice(0, spaceIdx)
  const rate = parseFloat(base.slice(spaceIdx + 1).replace('%', ''))
  const kindRank = kind === 'CGST' ? 0 : 1
  return [kindRank, rate, isRcm ? 1 : 0]
}

function compareHeads(a: string, b: string): number {
  const ka = headSortKey(a)
  const kb = headSortKey(b)
  for (let i = 0; i < 3; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i]
  }
  return 0
}

export function headsPresent(records: RegisterRecord[]): string[] {
  const set = new Set<string>()
  for (const rec of records) for (const h of Object.keys(rec.heads)) set.add(h)
  return [...set].sort(compareHeads)
}

// --------------------------------------------------------------------------
// Styling constants
// --------------------------------------------------------------------------

const argb = (hex: string) => `FF${hex}`

const headerFont: Partial<ExcelJS.Font> = { name: FONT_NAME, size: 11, bold: true, color: { argb: argb('FFFFFF') } }
const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('1F4E78') } }
const titleFont: Partial<ExcelJS.Font> = { name: FONT_NAME, size: 15, bold: true, color: { argb: argb('1F4E78') } }
const subFont: Partial<ExcelJS.Font> = { name: FONT_NAME, size: 10, italic: true, color: { argb: argb('595959') } }
const bodyFont: Partial<ExcelJS.Font> = { name: FONT_NAME, size: 11 }
const boldFont: Partial<ExcelJS.Font> = { name: FONT_NAME, size: 11, bold: true }
const creditNoteFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('FCE4D6') } }
const noInvFont: Partial<ExcelJS.Font> = { name: FONT_NAME, size: 11, italic: true, color: { argb: argb('808080') } }
const totalFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('D9E1F2') } }
const thinBorderSide: ExcelJS.Border = { style: 'thin', color: { argb: argb('D9D9D9') } }
const cellBorder: Partial<ExcelJS.Borders> = {
  top: thinBorderSide,
  left: thinBorderSide,
  right: thinBorderSide,
  bottom: thinBorderSide,
}

const MASTER_COLS = [
  'Voucher Date', 'Invoice Date (as stated)', 'Party / Vendor Name', 'Voucher Type',
  'Voucher No', 'Document Type', 'Invoice / Bill No', 'GST Amount Payable (Rs.)',
  'Description (narration gist)', 'GST Head(s)',
]
const SHEET_COLS = [
  'Voucher Date', 'Invoice Date (as stated)', 'Party / Vendor Name', 'Voucher Type',
  'Voucher No', 'Document Type', 'Invoice / Bill No', 'GST Amount Payable (Rs.)',
  'Description (narration gist)',
]

function colLetter(idx1based: number): string {
  return String.fromCharCode(64 + idx1based) // 1 -> A ... 26 -> Z (columns here never exceed 10)
}

function writeTitle(ws: ExcelJS.Worksheet, ncols: number, title: string, subtitle: string) {
  ws.mergeCells(1, 1, 1, ncols)
  const titleCell = ws.getCell(1, 1)
  titleCell.value = title
  titleCell.font = titleFont
  ws.mergeCells(2, 1, 2, ncols)
  const subCell = ws.getCell(2, 1)
  subCell.value = subtitle
  subCell.font = subFont
}

function styleHeader(ws: ExcelJS.Worksheet, row: number, cols: string[]) {
  cols.forEach((name, i) => {
    const c = ws.getCell(row, i + 1)
    c.value = name
    c.font = headerFont
    c.fill = headerFill
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    c.border = cellBorder
  })
}

function writeRow(
  ws: ExcelJS.Worksheet,
  r: number,
  values: (string | number)[],
  docType: string,
  invNo: string,
  amountColIdx: number,
  invNoColIdx: number,
) {
  values.forEach((val, i) => {
    const idx = i + 1
    const c = ws.getCell(r, idx)
    c.value = val
    c.border = cellBorder
    if (idx === amountColIdx) {
      c.numFmt = '#,##0.00'
      c.alignment = { horizontal: 'right', vertical: 'top' }
    } else {
      c.alignment = { horizontal: 'left', vertical: 'top', wrapText: true }
    }
    c.font = bodyFont
  })
  if (docType === 'Credit Note') {
    for (let idx = 1; idx <= values.length; idx++) {
      ws.getCell(r, idx).fill = creditNoteFill
    }
  }
  if (invNo === '(no inv. no. stated)') {
    ws.getCell(r, invNoColIdx).font = noInvFont
  }
}

export interface BuildWorkbookParams {
  records: RegisterRecord[]
  company: string
  state: string
  period: string
  notesExtra: string[]
}

export function buildWorkbook(params: BuildWorkbookParams): ExcelJS.Workbook {
  const { records, company, state, period, notesExtra } = params
  const heads = headsPresent(records)

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Tally GST Invoice Register'
  wb.created = new Date()
  // Without an explicit <bookViews>, ExcelJS omits it from workbook.xml and
  // Excel opens a blank grey window with no active sheet or tabs.
  wb.views = [{ x: 0, y: 0, width: 28800, height: 17000, firstSheet: 0, activeTab: 0, visibility: 'visible' }]

  // ---- Master ----
  const wsMaster = wb.addWorksheet('Master')
  writeTitle(
    wsMaster,
    MASTER_COLS.length,
    `${company} — GST ${state}: Invoice/Bill Register (Master)`,
    `Period: ${period}. Refund vouchers excluded by default. Credit notes highlighted.`,
  )
  const headerRow = 4
  styleHeader(wsMaster, headerRow, MASTER_COLS)
  const recordsSorted = [...records].sort((a, b) => (a.sort_date < b.sort_date ? -1 : a.sort_date > b.sort_date ? 1 : 0))
  let r = headerRow + 1
  for (const rec of recordsSorted) {
    const totalGst = Object.values(rec.heads).reduce((s, v) => s + v, 0)
    const headsStr = Object.entries(rec.heads)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([h, a]) => `${h} (${a.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`)
      .join(', ')
    const values = [
      rec.vch_date, rec.inv_date, rec.party, rec.vch_type, rec.vch_no,
      rec.doc_type, rec.inv_no, totalGst, rec.description, headsStr,
    ]
    writeRow(wsMaster, r, values, rec.doc_type, rec.inv_no, 8, 7)
    r += 1
  }
  const masterLastDataRow = r - 1
  wsMaster.getCell(r, 7).value = 'Grand Total'
  wsMaster.getCell(r, 7).font = boldFont
  const masterTotalCell = wsMaster.getCell(r, 8)
  masterTotalCell.value = { formula: `SUM(H${headerRow + 1}:H${masterLastDataRow})` } as ExcelJS.CellFormulaValue
  masterTotalCell.font = boldFont
  masterTotalCell.numFmt = '#,##0.00'
  for (let idx = 1; idx <= MASTER_COLS.length; idx++) {
    wsMaster.getCell(r, idx).fill = totalFill
    wsMaster.getCell(r, idx).border = cellBorder
  }
  const masterWidths = [13, 22, 30, 12, 13, 12, 20, 16, 44, 30]
  masterWidths.forEach((w, i) => (wsMaster.getColumn(i + 1).width = w))
  wsMaster.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRow, showGridLines: false }]
  wsMaster.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: masterLastDataRow, column: MASTER_COLS.length },
  }

  // ---- Per-head sheets ----
  for (const head of heads) {
    const ws = wb.addWorksheet(head)
    const headRecords = records
      .filter((rec) => head in rec.heads)
      .map((rec) => ({ rec, amt: rec.heads[head] }))
      .sort((a, b) => (a.rec.sort_date < b.rec.sort_date ? -1 : a.rec.sort_date > b.rec.sort_date ? 1 : 0))

    writeTitle(
      ws,
      SHEET_COLS.length,
      `${company} — GST ${state}: ${head} Ledger`,
      `Period: ${period}. Refund vouchers excluded by default. Credit notes highlighted.`,
    )
    const hHeaderRow = 4
    styleHeader(ws, hHeaderRow, SHEET_COLS)
    let hr = hHeaderRow + 1
    for (const { rec, amt } of headRecords) {
      const values = [
        rec.vch_date, rec.inv_date, rec.party, rec.vch_type, rec.vch_no,
        rec.doc_type, rec.inv_no, amt, rec.description,
      ]
      writeRow(ws, hr, values, rec.doc_type, rec.inv_no, 8, 7)
      hr += 1
    }
    const headLastDataRow = hr - 1
    if (headRecords.length > 0) {
      ws.getCell(hr, 7).value = 'Total'
      ws.getCell(hr, 7).font = boldFont
      const totCell = ws.getCell(hr, 8)
      totCell.value = { formula: `SUM(H${hHeaderRow + 1}:H${headLastDataRow})` } as ExcelJS.CellFormulaValue
      totCell.font = boldFont
      totCell.numFmt = '#,##0.00'
      for (let idx = 1; idx <= SHEET_COLS.length; idx++) {
        ws.getCell(hr, idx).fill = totalFill
        ws.getCell(hr, idx).border = cellBorder
      }
    }
    const headWidths = [13, 22, 30, 12, 13, 12, 20, 16, 50]
    headWidths.forEach((w, i) => (ws.getColumn(i + 1).width = w))
    ws.views = [{ state: 'frozen', xSplit: 0, ySplit: hHeaderRow, showGridLines: false }]
    if (headRecords.length > 0) {
      ws.autoFilter = { from: { row: hHeaderRow, column: 1 }, to: { row: headLastDataRow, column: SHEET_COLS.length } }
    }
  }

  // ---- Notes ----
  const wsNotes = wb.addWorksheet('Notes')
  wsNotes.getCell(1, 1).value = 'Notes on this workbook'
  wsNotes.getCell(1, 1).font = { name: FONT_NAME, size: 13, bold: true }
  const notes = [
    '',
    `1. Source: Tally GST-ledger vouchers PDF for ${company}, GST-${state}, period ${period}.`,
    "2. 'Master' lists every voucher once. The remaining tabs split the same vouchers out by the specific GST rate/head they were booked to. Rate heads with zero rows after filtering are not shown as tabs.",
    '3. Tally prints the same voucher once under every GST ledger it touches (e.g. a local purchase appears under both its CGST and SGST ledger pages). These duplicate print-outs are reconstructed into a single voucher, keyed on voucher type + number + date + narration text.',
    "4. 'GST Amount Payable' is CGST+SGST combined for local (intra-state) heads (the sheet is labelled 'CGST X%' but the amount includes the matching SGST leg), or the IGST amount alone for interstate/RCM heads. On the Master tab it is the total across every head a voucher touches.",
    '5. A voucher taxed at two different rates on different line items appears once on each rate’s tab (with only that rate’s amount) and once on Master with the combined total.',
    '6. GST refund vouchers are excluded by default (they reference a return period, not an invoice).',
    '7. Credit notes are highlighted peach.',
    "8. Rows with no invoice/bill number found in the narration show '(no inv. no. stated)' in italics -- they are still included by default (see the skill's docstring for why) unless the run used --require-reference.",
    '9. Invoice numbers, dates and vendor names are extracted from free-text narration by pattern matching; a narration phrased unusually may leave a field blank rather than a guessed value.',
    ...notesExtra,
  ]
  notes.forEach((n, i) => {
    const cell = wsNotes.getCell(i + 2, 1)
    cell.value = n
    cell.font = { name: FONT_NAME, size: 11 }
    cell.alignment = { wrapText: true, vertical: 'top' }
  })
  wsNotes.getColumn(1).width = 140
  wsNotes.views = [{ state: 'frozen', xSplit: 0, ySplit: 0, showGridLines: false }]

  return wb
}

export function summarizeRecords(records: RegisterRecord[]) {
  const creditNoteCount = records.filter((r) => r.doc_type === 'Credit Note').length
  const noInvoiceCount = records.filter((r) => r.inv_no === '(no inv. no. stated)').length
  const sheets = ['Master', ...headsPresent(records), 'Notes']
  return { creditNoteCount, noInvoiceCount, sheets }
}
