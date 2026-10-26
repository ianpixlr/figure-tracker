# Figure Cap

A phone-friendly monthly cap for figure collecting. Purchases, the wishlist, and figures for sale stay in this browser. The cap starts at **RM 400.00** and always uses ringgit, even when you type a price in another currency.

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

- **Home** shows what is left this month in Malaysia time, what you have spent, and the year to date. The bar marks progress against the cap. When the cap is used up it says: "Month done, next purchase waits for the 1st".
- **Log** records a figure. The date defaults to today and can be changed for past buys. Name and price are required. Series, brand, type, condition, shop, status, and notes are optional. A pre-order counts in the month you pay, at the full ringgit price. Entries can be filtered by month, year, brand, and series, with a total for each type. Edit and delete are on each entry.
- **Wishlist** items need a name and a price. Priority starts at Really want. Each item shows whether it fits this month. Remove is one tap, with undo. **Plan the month** adds up the figures you pick.
- **Sell** lists a figure with its condition (MISB, MIB, BIB, or Loose), asking price, and notes. Mark it sold with the sold price and date. Price checks typed into the sheet show on the card. Until a check exists, the card says "No price check yet."
- **Settings** holds the cap, an optional rollover (off by default), an optional cooling-off wait (0 hours by default), the sheet address, and JSON export / import.

You can save a purchase that goes past the cap. Home will show that the month is over.

## Currencies

Every price can be MYR or another currency. The quick choices are JPY, USD, CNY, HKD, SGD, KRW, and EUR. The RM equivalent updates as you type. Purchases use the rate for the purchase date. Wishlist and sale prices use today's rate.

Rates come from the European Central Bank via [Frankfurter](https://www.frankfurter.app/). If that is unavailable, the app tries [open.er-api.com](https://www.exchangerate-api.com/). The last good rate is kept on the phone and marked "cached rate" when it is reused. If the card was charged a different ringgit amount, tick **Use statement amount** and enter that figure. The cap, totals, and fits-this-month all use the ringgit value.

Headings use [Archivo Black](https://fonts.google.com/specimen/Archivo+Black) (Open Font License, see `fonts/OFL.txt`).

## Google Sheet

The spreadsheet is `1T6r59M_WNSqRt6nfQhOyVwyHVuQtlvi6JabgwLnfk60`, with tabs Purchases, Wishlist, For Sale, and Price Checks.

A GitHub Pages site cannot sign in to Sheets, so `apps-script/Code.gs` is the small web app in the middle.

1. Open [script.google.com](https://script.google.com) and create a project.
2. Paste in `apps-script/Code.gs`. Leave `SPREADSHEET_ID` as it is. `SYNC_TOKEN` must match `SYNC_TOKEN` in `js/sync.js`.
3. Deploy → New deployment → Web app. Execute as **Me**. Who has access: **Anyone**.
4. Copy the URL that ends in `/exec`.
5. `DEFAULT_SYNC_URL` in `js/sync.js` already points at the deployed web app, so sync is on without pasting anything. Paste a different `/exec` URL into Settings only if you deploy your own copy.

The script repairs a frozen bold header row on each tab, formats ringgit columns, and formats dates. The app posts with `Content-Type: text/plain` so the browser does not send a preflight. Random visitors cannot write without the token.

The phone keeps the local copy. Each add, edit, and delete is queued and sent when you are online. **Sync all now** pushes every purchase, wishlist item, and listing. Price Checks are read-only: fill that tab yourself and the Sell cards pick up the latest row for each figure.

### Column headers

Purchases: `id`, `date`, `name`, `series`, `brand`, `type`, `bought_as`, `condition`, `original_amount`, `currency`, `fx_rate`, `fx_date`, `amount_rm`, `fx_overridden`, `fx_cached`, `shop`, `status`, `notes`, `mood`, `created_at`, `updated_at`

Wishlist: `id`, `name`, `original_amount`, `currency`, `fx_rate`, `fx_date`, `amount_rm`, `fx_overridden`, `fx_cached`, `priority`, `added_at`, `updated_at`

For Sale: `id`, `name`, `brand`, `series`, `condition`, `original_amount`, `currency`, `fx_rate`, `fx_date`, `amount_rm`, `fx_overridden`, `fx_cached`, `notes`, `status`, `sold_original_amount`, `sold_currency`, `sold_fx_rate`, `sold_fx_date`, `sold_amount_rm`, `sold_fx_overridden`, `sold_fx_cached`, `sold_date`, `created_at`, `updated_at`

Price Checks: `for_sale_id`, `figure`, `rrp`, `rrp_source`, `condition`, `low_rm`, `typical_rm`, `high_rm`, `listing_count`, `sample_links`, `sources`, `checked_at`

`amount_rm` is the ringgit value the cap uses. `original_amount` and `currency` are what you typed. `fx_overridden` is `yes` when the statement amount replaced the converted estimate.

## Backup

Export the JSON file from Settings and keep it somewhere safe. Import replaces the data on that device. Older backups, which only had a name, price, date, and bought/pre-order flag, still load. Those prices are treated as ringgit.
