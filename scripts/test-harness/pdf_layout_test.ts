// Sanity check for pdfLayout.ts's pdftotext -layout emulation: builds a
// tiny synthetic PDF with pdf-lib, placing text runs at known x positions
// to simulate a table row (the way Tally's own PDF export lays out its
// Date / Particulars / .../ Debit / Credit / Balance columns), then checks
// that pdfBufferToLayoutText() reconstructs the same "columns separated by
// runs of 2+ spaces" shape that voucherParser.ts's regexes depend on.
//
// This does NOT prove the algorithm matches poppler's pdftotext -layout
// byte-for-byte on a real client PDF -- see DEPLOYMENT.md's "Smoke-test
// the pipeline" section for that. It proves the coordinate -> spacing
// reconstruction is directionally correct on a controlled input.
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { pdfBufferToLayoutText } from '../../supabase/functions/process-ledger/shared/pdfLayout.ts'

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
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([612, 300]) // US letter width, short height
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const size = 10

  // A "Ledger:" header line, alone on its own row.
  page.drawText('Ledger: UP CGST 9% ( 18% )', { x: 40, y: 260, size, font })

  // A simulated table row: four separate text runs (as pdf.js would
  // extract them as separate items) at increasing x, wide gaps between
  // the last two to simulate the Debit/Credit money columns.
  page.drawText('3-Apr-26', { x: 40, y: 220, size, font })
  page.drawText('To Purchase A/c (as per details)', { x: 110, y: 220, size, font })
  page.drawText('862.20 Dr', { x: 420, y: 220, size, font })
  page.drawText('862.20 Dr', { x: 510, y: 220, size, font })

  const bytes = await pdfDoc.save()
  const layoutText = await pdfBufferToLayoutText(bytes)
  console.log('--- reconstructed layout text ---')
  console.log(layoutText)
  console.log('--- end ---')

  const lines = layoutText.split('\n').map((l) => l.trimEnd())
  const ledgerLine = lines.find((l) => l.includes('Ledger:'))
  check('Ledger: header line reconstructed on its own line', !!ledgerLine, lines)

  const rowLine = lines.find((l) => l.includes('3-Apr-26'))
  check('table row line reconstructed', !!rowLine, lines)
  if (rowLine) {
    const cols = rowLine.split(/\s{2,}/).filter((c) => c.trim() !== '')
    check(
      'row splits into >= 3 columns on runs of 2+ spaces (date+particulars, and 2 money columns)',
      cols.length >= 3,
      cols,
    )
    check('first column starts with the date', cols[0].trim().startsWith('3-Apr-26'), cols[0])
    check('a later column contains the particulars text', cols.some((c) => c.includes('Purchase A/c')), cols)
    check(
      'the two money tokens land in separate columns (wide x gap preserved)',
      cols.filter((c) => c.includes('862.20')).length === 2 || cols.some((c) => (c.match(/862\.20/g) || []).length === 2),
      cols,
    )
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
