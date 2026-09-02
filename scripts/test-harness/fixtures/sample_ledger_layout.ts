// A small, hand-built "pdftotext -layout" -shaped fixture standing in for a
// real Tally GST-ledger PDF export (see SKILL.md Step 1 for the real
// shape). It exercises the parts of voucherParser.ts that matter most:
//   - V1: a local purchase taxed at CGST 9% / SGST 9%, printed once under
//     each ledger's own page (two occurrences that must merge into one
//     voucher, and whose CGST+SGST legs must fold into a single
//     "CGST 9%" head) -- this is the main case verify_head_totals guards.
//   - V2: an interstate purchase at IGST 18%, single occurrence, with a
//     narration that has NO invoice number or date in it at all (exercises
//     the "(no inv. no. stated)" / "(not specified)" fallback path).
//   - V3: a credit note against the same CGST 9% head as V1, also printed
//     under both ledger pages, so the whole fixture's GST-rate
//     self-verification (raw ledger totals vs reconstructed voucher
//     totals) ties out to zero -- this is meant to be the clean/PASSING
//     fixture. See broken_ledger_layout.ts for a deliberately mismatched
//     one.
export const SAMPLE_LEDGER_LAYOUT = `
Group: GST-Uttar Pradesh
Ledger: UP CGST 9% ( 18% )
Date        Particulars                              Vch Type     Vch No   Debit         Credit        Balance

3-Apr-26 To Purchase A/c (as per details)    Purchase      1234        862.20 Dr        862.20 Dr
SGST 9%                                862.20 Dr
XYZ Traders Pvt Ltd                  9,586.42 Cr
Purchase - Trading Goods              8,600.00 Dr
Being amount paid to XYZ Traders Pvt Ltd agst the purchase of Trading Goods vide Invoice No INV-2026-0451 dated 02-Apr-2026

15-Apr-26 By Purchase Return A/c (as per details)    Credit Note   88        200.00 Cr        662.20 Dr
SGST 9%                                200.00 Cr
XYZ Traders Pvt Ltd                    236.00 Dr
Purchase - Trading Goods                200.00 Cr
Being credit note received from XYZ Traders Pvt Ltd against return of goods vide Credit Note No CN-77 dated 14-Apr-2026

                                                                              662.20 Dr
                            By      Closing Balance                                                     662.20 Dr

Ledger: UP SGST 9% ( 18% )
Date        Particulars                              Vch Type     Vch No   Debit         Credit        Balance

3-Apr-26 To Purchase A/c (as per details)    Purchase      1234        862.20 Dr        862.20 Dr
CGST 9%                                862.20 Dr
XYZ Traders Pvt Ltd                  9,586.42 Cr
Purchase - Trading Goods              8,600.00 Dr
Being amount paid to XYZ Traders Pvt Ltd agst the purchase of Trading Goods vide Invoice No INV-2026-0451 dated 02-Apr-2026

15-Apr-26 By Purchase Return A/c (as per details)    Credit Note   88        200.00 Cr        662.20 Dr
CGST 9%                                200.00 Cr
XYZ Traders Pvt Ltd                    236.00 Dr
Purchase - Trading Goods                200.00 Cr
Being credit note received from XYZ Traders Pvt Ltd against return of goods vide Credit Note No CN-77 dated 14-Apr-2026

                                                                              662.20 Dr
                            By      Closing Balance                                                     662.20 Dr

Ledger: MH IGST 18%
Date        Particulars                              Vch Type     Vch No   Debit         Credit        Balance

10-Apr-26 To Purchase A/c (as per details)    Purchase      1250       1,800.00 Dr      1,800.00 Dr
ABC Global Services                 11,800.00 Cr
Consulting Fees                     10,000.00 Dr
Being payment for consulting services rendered during March 2026

                                                                            1,800.00 Dr
                            By      Closing Balance                                                   1,800.00 Dr
`
