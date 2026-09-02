/**
 * pdfLayout.ts
 *
 * The Python skill shells out to `pdftotext -layout` (poppler), which is
 * essential precisely because "-layout" mode preserves the original column
 * alignment of the ledger table -- voucherParser.ts's column-splitting
 * logic (`re.split`-equivalent on runs of 2+ spaces) depends on that
 * alignment surviving extraction. Neither a Supabase Edge Function (Deno)
 * nor Netlify's browser runtime has poppler/pdftotext available (it's a
 * native system binary, not an npm package), so this module reimplements
 * layout-mode text extraction in pure TypeScript on top of pdfjs-dist,
 * which both Deno (via an npm: import-map entry) and Node can load.
 *
 * ALGORITHM
 * ---------
 * pdftotext -layout's real algorithm is more elaborate (per-page column
 * detection, whitespace-width heuristics tuned per font). This is a
 * practical approximation that is known to work well for text extracted
 * from *table-like, left-to-right, non-rotated* PDF pages such as Tally's
 * own ledger export -- which is the only input shape this skill supports
 * (see SKILL.md Step 1: "confirm the file is the right shape" before
 * running any of this).
 *
 *   1. Pull every text run on a page from pdf.js's getTextContent(), each
 *      with its baseline (x, y) position in PDF points.
 *   2. Group runs into visual lines by clustering y-coordinates within a
 *      small tolerance (glyphs on the same printed line rarely differ by
 *      more than a point or two).
 *   3. Within a line, sort runs left-to-right by x and re-emit them with
 *      padding spaces computed from each run's x position divided by an
 *      estimated character width -- this reconstructs the same "columns
 *      separated by 2+ spaces" shape that voucherParser.ts's regexes are
 *      written against, without needing a real monospace font.
 *
 * If a future client's Tally export doesn't parse cleanly, the fix belongs
 * in the column-width estimate or the y-clustering tolerance below, not in
 * voucherParser.ts (same principle as extract_vouchers.py's own "where to
 * adjust" guidance -- keep the layout-reconstruction and the
 * voucher-reconstruction concerns separate).
 */
// See the module docstring above and deno.json / scripts/test-harness's
// package.json for how this bare specifier resolves in each runtime.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

interface TextRun {
  x: number
  y: number
  str: string
  width: number
}

// pdfjs-dist's own TextItem type lives at an internal path
// ('pdfjs-dist/types/src/display/api') that isn't re-exported from the
// 'pdfjs-dist/legacy/build/pdf.mjs' entry point this file imports (and
// isn't covered by the deno.json import map either) -- depending on it
// would be one broken type-check away from every pdfjs-dist version bump.
// This is the minimal shape actually used below; a runtime 'str' in it
// check (see the filter in getTextContentItems) is what really guards
// against pdf.js's other getTextContent() member, TextMarkedContent,
// which doesn't have these fields at all.
interface PdfTextItem {
  str: string
  transform: number[]
  width: number
}

const Y_TOLERANCE = 2.0 // PDF points; same visual line if baselines differ by less than this

export async function pdfBufferToLayoutText(pdfBytes: Uint8Array): Promise<string> {
  // pdf.js normally offloads parsing to a Web Worker. Neither the Deno
  // Edge Runtime nor a plain Node script has a worker script available at
  // a resolvable URL here, so we deliberately leave GlobalWorkerOptions
  // unset -- pdf.js's documented fallback is a same-thread "fake worker"
  // (it logs a harmless "Setting up fake worker" warning once) which is
  // exactly what a short-lived server-side extraction needs.
  const loadingTask = pdfjsLib.getDocument({
    data: pdfBytes,
    isEvalSupported: false,
    useSystemFonts: true,
  })
  const doc = await loadingTask.promise
  try {
    const pageTexts: string[] = []
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum)
      try {
        const textContent = await page.getTextContent()
        pageTexts.push(renderPageLayout(textContent.items as unknown as PdfTextItem[]))
      } finally {
        page.cleanup()
      }
    }
    // Join with a form-feed, mirroring pdftotext's own page separator.
    // parseRawEntries() strips '\f' characters outright, so this is purely
    // for fidelity with real pdftotext output (useful if you ever diff
    // this against a poppler run while debugging a new client's export).
    return pageTexts.join('\n\f\n')
  } finally {
    await doc.destroy()
  }
}

function renderPageLayout(items: PdfTextItem[]): string {
  const runs: TextRun[] = []
  for (const it of items) {
    if (!('str' in it) || it.str.trim() === '') continue
    // transform is [scaleX, skewX, skewY, scaleY, translateX, translateY];
    // (transform[4], transform[5]) is the glyph run's baseline origin.
    runs.push({ x: it.transform[4], y: it.transform[5], str: it.str, width: it.width })
  }
  if (runs.length === 0) return ''

  // --- group into lines by y ---
  const rows: { y: number; runs: TextRun[] }[] = []
  for (const run of runs) {
    let row = rows.find((r) => Math.abs(r.y - run.y) <= Y_TOLERANCE)
    if (!row) {
      row = { y: run.y, runs: [] }
      rows.push(row)
    }
    row.runs.push(run)
  }
  // PDF y grows upward -- descending y is top-to-bottom reading order.
  rows.sort((a, b) => b.y - a.y)

  // --- estimate a page-wide character width from the median glyph run ---
  const perCharWidths: number[] = []
  for (const run of runs) {
    if (run.str.length > 0 && run.width > 0) perCharWidths.push(run.width / run.str.length)
  }
  perCharWidths.sort((a, b) => a - b)
  const charWidth = perCharWidths.length > 0 ? perCharWidths[Math.floor(perCharWidths.length / 2)] : 4.5

  const lines: string[] = []
  for (const row of rows) {
    row.runs.sort((a, b) => a.x - b.x)
    let line = ''
    for (const run of row.runs) {
      const targetCol = Math.max(line.length, Math.round(run.x / charWidth))
      if (targetCol > line.length) line += ' '.repeat(targetCol - line.length)
      line += run.str
    }
    lines.push(line.replace(/\s+$/, ''))
  }
  return lines.join('\n')
}
