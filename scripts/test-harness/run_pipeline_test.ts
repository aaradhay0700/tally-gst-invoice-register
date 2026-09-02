// Local sanity check for the TypeScript port of extract_vouchers.py +
// build_invoice_register.py. This is NOT a substitute for running the real
// pipeline against an actual client Tally PDF once deployed (see
// DEPLOYMENT.md "Smoke-test the pipeline") -- pdfjs-dist isn't exercised
// here at all (see pdf_layout_test.ts for that). What this checks is that
// the hand-ported regex/merge/verification logic in voucherParser.ts and
// the xlsx-building logic in registerBuilder.ts behave the way the Python
// originals' docstrings say they should, using fixture text shaped like
// real pdftotext -layout output (see fixtures/*.ts).
import ExcelJS from 'exceljs'
import { extractVouchers } from '../../supabase/functions/process-ledger/shared/voucherParser.ts'
import { loadRecords, buildWorkbook, summarizeRecords } from '../../supabase/functions/process-ledger/shared/registerBuilder.ts'
import { SAMPLE_LEDGER_LAYOUT } from './fixtures/sample_ledger_layout.ts'
import { BROKEN_LEDGER_LAYOUT } from './fixtures/broken_ledger_layout.ts'

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok  - ${label}`)
  } else {
    failures++
    console.log(`FAIL  - ${label}`, detail !== undefined ? JSON.stringify(detail) : '')
  }
}

async function main() {
  console.log('== extractVouchers: happy-path fixture ==')
  const happy = extractVouchers(SAMPLE_LEDGER_LAYOUT)
  check('GST rate verification PASSES', happy.mismatches.length === 0, happy.mismatches)
  check('3 vouchers reconstructed', happy.rows.length === 3, happy.rows.length)

  const v1 = happy.rows.find((r) => r.vch_no === '1234')
  check('V1 found', !!v1)
  if (v1) {
    check('V1 txn_type PURCHASE_INVOICE', v1.txn_type === 'PURCHASE_INVOICE', v1.txn_type)
    check('V1 invoice no extracted as INV-2026-0451', v1.tally_invoice_no_raw === 'INV-2026-0451', v1.tally_invoice_no_raw)
    check('V1 invoice date extracted as 02-Apr-2026', v1.tally_invoice_date_raw === '02-Apr-2026', v1.tally_invoice_date_raw)
    check('V1 vendor extracted as XYZ Traders Pvt Ltd', v1.vendor_name_tally === 'XYZ Traders Pvt Ltd', v1.vendor_name_tally)
    check('V1 CGST leg = 862.2', v1.cgst_tally === 862.2, v1.cgst_tally)
    check('V1 SGST leg = 862.2', v1.sgst_tally === 862.2, v1.sgst_tally)
    check('V1 total tax = 1724.4 (CGST+SGST folded)', v1.total_tax_tally === 1724.4, v1.total_tax_tally)
    check('V1 gst_heads is "CGST 9%" (SGST folded in)', v1.gst_heads === 'CGST 9%', v1.gst_heads)
    check('V1 n_occurrences = 2 (reprinted under both ledger pages)', v1.n_occurrences === 2, v1.n_occurrences)
  }

  const v2 = happy.rows.find((r) => r.vch_no === '1250')
  check('V2 found', !!v2)
  if (v2) {
    check('V2 txn_type PURCHASE_INVOICE', v2.txn_type === 'PURCHASE_INVOICE', v2.txn_type)
    check('V2 has no invoice number in narration -> null (never guessed)', v2.tally_invoice_no_raw === null, v2.tally_invoice_no_raw)
    check('V2 gst_heads is "IGST 18%" (no SGST fold for interstate)', v2.gst_heads === 'IGST 18%', v2.gst_heads)
    check('V2 total tax = 1800', v2.total_tax_tally === 1800, v2.total_tax_tally)
  }

  const v3 = happy.rows.find((r) => r.vch_no === '88')
  check('V3 found', !!v3)
  if (v3) {
    check('V3 classified as CREDIT_NOTE (drcr=By)', v3.txn_type === 'CREDIT_NOTE', v3.txn_type)
  }

  console.log('\n== extractVouchers: deliberately broken fixture (regression check on verify_head_totals itself) ==')
  const broken = extractVouchers(BROKEN_LEDGER_LAYOUT)
  check('GST rate verification correctly FAILS on a single-occurrence voucher', broken.mismatches.length > 0, broken.mismatches)
  if (broken.mismatches.length > 0) {
    const m = broken.mismatches[0]
    check('flagged head is CGST 9%', m.head === 'CGST 9%', m.head)
    check('overcount diff is +862.2 (double-counted SGST leg, no 2nd page to balance it)', Math.abs(m.diff - 862.2) < 0.001, m.diff)
  }

  console.log('\n== registerBuilder: build workbook from happy-path fixture ==')
  const records = loadRecords(happy.rows, false, false)
  check('3 records loaded (refunds excluded by default, none present here anyway)', records.length === 3, records.length)
  const summary = summarizeRecords(records)
  check(
    'sheet list is Master, CGST 9%, IGST 18%, Notes (accountant ordering: local rate before interstate)',
    JSON.stringify(summary.sheets) === JSON.stringify(['Master', 'CGST 9%', 'IGST 18%', 'Notes']),
    summary.sheets,
  )
  check('1 credit note counted', summary.creditNoteCount === 1, summary.creditNoteCount)
  // V2's narration has no invoice reference at all, and V3's credit-note
  // narration ("vide Credit Note No CN-77") doesn't match any INV_PATTERNS
  // entry (they all require "Invoice"/"Inv"/"Bill", not "Note") -- both
  // correctly fall back to the placeholder rather than a guessed value.
  check('2 rows with no invoice number stated (V2, V3)', summary.noInvoiceCount === 2, summary.noInvoiceCount)

  const wb = buildWorkbook({ records, company: 'Test Co Pvt Ltd', state: 'Uttar Pradesh', period: '1-Apr-2026 to 30-Apr-2026', notesExtra: [] })
  const outPath = new URL('./out_test_register.xlsx', import.meta.url)
  await wb.xlsx.writeFile(outPath.pathname)
  console.log(`  wrote ${outPath.pathname}`)

  // Re-open with a fresh ExcelJS instance, the way a human opening the file
  // in Excel/LibreOffice would see it, to sanity-check what actually landed
  // on disk (not just what's still in memory).
  const reopened = new ExcelJS.Workbook()
  await reopened.xlsx.readFile(outPath.pathname)
  const sheetNames = reopened.worksheets.map((ws) => ws.name)
  check('sheet names on disk match', JSON.stringify(sheetNames) === JSON.stringify(['Master', 'CGST 9%', 'IGST 18%', 'Notes']), sheetNames)

  const master = reopened.getWorksheet('Master')!
  check('Master header row (row 4) has the right columns', master.getCell(4, 1).value === 'Voucher Date' && master.getCell(4, 8).value === 'GST Amount Payable (Rs.)')
  // 3 data rows (rows 5-7) + grand total row (row 8)
  const grandTotalFormula = master.getCell(8, 8).value as ExcelJS.CellFormulaValue
  check('Master grand total is a SUM formula over the data rows', grandTotalFormula?.formula === 'SUM(H5:H7)', grandTotalFormula)
  const dataSum = [5, 6, 7].reduce((s, r) => s + (Number(master.getCell(r, 8).value) || 0), 0)
  check('Master data rows sum to 1724.4 + 1800 + 400 = 3924.4 (V1 total + V2 total + V3 total)', Math.abs(dataSum - 3924.4) < 0.001, dataSum)

  const cgstSheet = reopened.getWorksheet('CGST 9%')!
  check('CGST 9% sheet has 2 data rows (V1 purchase + V3 credit note)', cgstSheet.getCell(6, 8).value !== undefined)
  const creditRowFill = cgstSheet.getCell(6, 1).fill as ExcelJS.FillPattern
  check(
    'the credit-note row is highlighted peach (FCE4D6)',
    creditRowFill?.fgColor?.argb === 'FFFCE4D6',
    creditRowFill,
  )

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
