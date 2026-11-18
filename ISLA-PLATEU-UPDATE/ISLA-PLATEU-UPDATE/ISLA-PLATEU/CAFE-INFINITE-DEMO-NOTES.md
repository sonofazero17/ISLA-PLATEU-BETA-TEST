# The Cafe Infinite demo setup

The existing `the-cafe-infinite` restaurant record is reused; no duplicate restaurant is created.

- The supplied logo is stored in `assets/cafe-infinite/the-cafe-infinite-logo.jpg` and copied to the public upload store during the one-time demo migration.
- The Cafe Infinite receives eight sample menu items with sample PHP prices and illustrative food photographs. These are demonstration content only, not the restaurant's verified current menu.
- A separate non-scannable demonstration payment image is stored privately and clearly says `DEMO PAYMENT ONLY` / `NOT A REAL QR CODE`.
- The demo restaurant can accept sample orders and reservation requests using the existing customer and staff workflows.
- Staff assigned to The Cafe Infinite can edit its profile identity/address fields, menu items, prices, availability, and images. Map coordinates remain administrator-controlled.
- The verified Google Maps listing is **Cafe Infinite - Siquijor**, at Wiggle Gas, San Juan, Siquijor (Plus Code **4GR7+R2**; marker 9.1421151, 123.5126152). Its phone number matches the existing profile, and its photos show Cafe Infinite branding at the storefront/truck. Google place ID: `0x33ab170398973433:0xddddde2b0472e797`. The listing does not provide a numbered street address.

The migration is additive and idempotent. It will not duplicate the menu on later restarts and does not overwrite existing staff-edited menu records once the migration has run.
