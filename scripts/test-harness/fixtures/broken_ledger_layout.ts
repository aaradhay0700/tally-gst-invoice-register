// Deliberately mismatched fixture: a local CGST 9%/SGST 9% voucher printed
// under ONLY its CGST ledger page (the real Tally export would also print
// it under the SGST page -- see sample_ledger_layout.ts's V1 for the
// correct two-occurrence shape). Because head_amounts sums both legs
// within a single occurrence, this makes the reconstructed "CGST 9%" head
// total (862.20 + 862.20) exceed the raw ledger total (862.20, since there
// is no second ledger page here to contribute its own entry_amount) --
// i.e. exactly the "reconstructed > raw" overcount case verify_head_totals
// exists to catch. run_pipeline_test.ts asserts this fixture FAILS
// verification, as a regression check on that self-check itself.
export const BROKEN_LEDGER_LAYOUT = `
Group: GST-Uttar Pradesh
Ledger: UP CGST 9% ( 18% )
Date        Particulars                              Vch Type     Vch No   Debit         Credit        Balance

3-Apr-26 To Purchase A/c (as per details)    Purchase      9001        862.20 Dr        862.20 Dr
SGST 9%                                862.20 Dr
XYZ Traders Pvt Ltd                  9,586.42 Cr
Purchase - Trading Goods              8,600.00 Dr
Being amount paid to XYZ Traders Pvt Ltd agst the purchase of Trading Goods vide Invoice No INV-9001 dated 02-Apr-2026

                                                                              862.20 Dr
                            By      Closing Balance                                                     862.20 Dr
`
