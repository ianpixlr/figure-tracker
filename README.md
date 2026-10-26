# Figure Cap

A phone-friendly collection log for figures, with a simple ringgit-left bar. Purchases, the wishlist, and figures for sale stay in this browser. The cap starts at **RM 400.00** and always uses ringgit, even when you type a price in another currency.

The site is published from the `main` branch at <https://ianpixlr.github.io/figure-tracker/>.

## Put it on your phone

1. Open the site in Safari or Chrome.
2. Add it to the home screen.

### iPhone (Safari)

1. Open the site in Safari.
2. Tap the Share button.
3. Tap **Add to Home Screen**, then **Add**.

### Android (Chrome)

1. Open the site in Chrome.
2. Tap the menu.
3. Tap **Install app** or **Add to Home screen**, then confirm.

After the first load the shell also works offline. A sheet sync needs a connection.

## Using it

- **Home** shows what is left this month in Malaysia time as `RM 320 / 400` (left, then this month's cap) with `left this month` under it. Whole ringgit amounts on that line drop the `.00`. A bar sits under that, then the latest purchase, balances still due on open pre-orders, and the year to date. Figures with no type count as Other. When the cap is used up it says: "Month done, next purchase waits for the 1st". Going over the cap shows `RM 0 / 400` and, in the small line, `RM 60 over`.
- **Log** is the collection. The date defaults to today and can be changed for past buys. Name is required. Bought as and status come next, then the price, because bought as decides which price fields appear. Series, brand, type, condition, shop, and notes sit under More details. Search plus one Filter button narrows entries by month, year, brand, and series. Edit and delete are on each entry.
- A **pre-order** asks for an estimated full price, the deposit, and the deposit date. Balance due is the estimate minus the deposit. **Pay balance** records the amount you actually paid and the date. The deposit counts in the month it was paid. The balance counts in the month it was paid. Home adds up balances still due.
- **Wishlist** items need a name and a price. Priority starts at Really want. Each item shows whether it fits this month. Remove is one tap, with undo. **Plan the month** adds up the figures you pick against the adjusted cap.
- **Sell** lists a figure with its condition (MISB, MIB, BIB, or Loose), asking price, and notes. Mark it sold with the sold price and date. Each listing has **Search Carousell** and **Search RRP**, which open a new tab. The card shows the latest price check on one line, such as `Market RM 40 / 55 / 80 · RRP RM 90`, with the source and day underneath. The form for a new check is on the edit page: low, typical, and high in ringgit, plus an optional RRP and a source that starts as Carousell. It is saved on the phone with today's date and appended to the Price Checks tab. Until a check exists, the card says "No price check yet."
- **Settings** holds the cap, unused rollover (off by default), overspend payback (on by default), the sheet address, and JSON export / import. **Theme** is Light, Dark, or Match phone (the default). Match phone follows the phone's appearance, including a change while the app is open. The choice stays on this device and is not written to the sheet.

You can save a purchase that goes past the cap. Home will show that the month is over. With payback on, that overspend lowers only the next month's cap, and the cap does not go below RM 0.00. Home shows what is left over this month's cap, for example `RM 340 / 340` with `cap RM 340 · RM 60 from October` underneath. Turning payback off leaves later months at the base cap. Rollover, when on, adds only the previous month's unused amount. The two do not stack on the same previous month.

## Currencies

Every price can be MYR or another currency. The quick choices are JPY, USD, CNY, HKD, SGD, KRW, and EUR. The RM equivalent updates as you type. Purchases use the rate for the purchase date. Wishlist and sale prices use today's rate.

Rates come from the European Central Bank via [Frankfurter](https://www.frankfurter.app/). If that is unavailable, the app tries [open.er-api.com](https://www.exchangerate-api.com/). The last good rate is kept on the phone and marked "cached rate" when it is reused. **Use statement amount** appears once on each amount that is not already in ringgit. Tick it and enter the RM amount on your card statement. The cap, totals, and fits-this-month all use the ringgit value.

Headings use [Archivo Black](https://fonts.google.com/specimen/Archivo+Black) (Open Font License, see `fonts/OFL.txt`).

## Google Sheet

The spreadsheet is `1T6r59M_WNSqRt6nfQhOyVwyHVuQtlvi6JabgwLnfk60`, with tabs Purchases, Wishlist, For Sale, and Price Checks.

A GitHub Pages site cannot sign in to Sheets, so `apps-script/Code.gs` is the small web app in the middle.

1. Open [script.google.com](https://script.google.com) and create a project.
2. Paste in `apps-script/Code.gs`. Leave `SPREADSHEET_ID` as it is. `SYNC_TOKEN` must match `SYNC_TOKEN` in `js/sync.js`.
3. Deploy → New deployment → Web app. Execute as **Me**. Who has access: **Anyone**.
4. Copy the URL that ends in `/exec`.
5. `DEFAULT_SYNC_URL` in `js/sync.js` already points at the deployed web app, so sync is on without pasting anything. Paste a different `/exec` URL into Settings only if you deploy your own copy.

The script repairs a frozen bold header row on each tab, formats ringgit columns, and formats dates. The app posts with `Content-Type: text/plain` so the browser does not send a preflight. Random visitors cannot write without the token. A manual price check posts `action: "appendCheck"`. That action is new, so paste this file and deploy a new version before those rows can land on the sheet. Until then the check still stays on the phone.

The phone keeps the local copy. Each add, edit, and delete is queued and sent when you are online. **Sync all now** pushes every purchase, wishlist item, and listing. Price Checks are read-only: fill that tab yourself and the Sell cards pick up the latest row for each figure.

### Column headers

Purchases: `id`, `date`, `name`, `series`, `brand`, `type`, `bought_as`, `condition`, `original_amount`, `currency`, `fx_rate`, `fx_date`, `amount_rm`, `fx_overridden`, `fx_cached`, `shop`, `status`, `notes`, `est_full_original_amount`, `est_full_currency`, `est_full_fx_rate`, `est_full_fx_date`, `est_full_price`, `est_full_fx_overridden`, `est_full_fx_cached`, `deposit_original_amount`, `deposit_currency`, `deposit_fx_rate`, `deposit_fx_date`, `deposit_amount_rm`, `deposit_fx_overridden`, `deposit_fx_cached`, `deposit_date`, `balance_due_rm`, `balance_paid_original_amount`, `balance_paid_currency`, `balance_paid_fx_rate`, `balance_paid_fx_date`, `balance_paid_rm`, `balance_paid_fx_overridden`, `balance_paid_fx_cached`, `balance_paid_date`, `final_total_rm`, `preorder_status`, `created_at`, `updated_at`

`preorder_status` is `deposit paid` or `fully paid`. An older pre-order that only had one price is treated as fully paid on that date. The sheet no longer has a `mood` column; opening the script drops that column if it is still there.

The copy at `apps-script/Code.gs` is the script to paste. The live web app does not pick up this file until you paste it and deploy a new version (Execute as **Me**, Who has access: **Anyone**).

Wishlist: `id`, `name`, `original_amount`, `currency`, `fx_rate`, `fx_date`, `amount_rm`, `fx_overridden`, `fx_cached`, `priority`, `added_at`, `updated_at`

For Sale: `id`, `name`, `brand`, `series`, `condition`, `original_amount`, `currency`, `fx_rate`, `fx_date`, `amount_rm`, `fx_overridden`, `fx_cached`, `notes`, `status`, `sold_original_amount`, `sold_currency`, `sold_fx_rate`, `sold_fx_date`, `sold_amount_rm`, `sold_fx_overridden`, `sold_fx_cached`, `sold_date`, `created_at`, `updated_at`

Price Checks: `for_sale_id`, `figure`, `rrp`, `rrp_source`, `condition`, `low_rm`, `typical_rm`, `high_rm`, `listing_count`, `sample_links`, `sources`, `checked_at`

`amount_rm` is the ringgit value the cap uses. `original_amount` and `currency` are what you typed. `fx_overridden` is `yes` when the statement amount replaced the converted estimate.

## Backup

Export the JSON file from Settings and keep it somewhere safe. Import replaces the data on that device. Older backups, which only had a name, price, date, and bought/pre-order flag, still load. Those prices are treated as ringgit.
