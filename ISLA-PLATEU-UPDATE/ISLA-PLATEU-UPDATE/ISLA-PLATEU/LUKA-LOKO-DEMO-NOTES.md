# Luca Loko Restaurant — ISLA PLATEU demo setup

- The existing `luka-loko` database record is reused; no duplicate restaurant is created.
- The supplied `luka loko logo(1).jpg` image is used as the restaurant logo and cover image.
- The Google Maps listing **Luca Loko Restaurant** matches the existing Maite, San Juan, Siquijor record. Its listed Plus Code is **5F3W+MW**; the marker coordinates (9.1542172, 123.4972914) are taken from the listing URL. The listing has matching location details, extensive venue photos, and an owner post describing its food and atmosphere. Contact information is not listed; confirm hours directly.
- Location status is `verified` from the Google Maps business listing marker. The Google place ID is `0x33ab3e585f6482b3:0x59494518cce51505`. The listing identifies the business and building-level map location; it does not publish a street number or phone.
- Eight sample menu items, prices and generated food images are provided for system demonstration only. They are not represented as Luca Loko's verified current menu or prices.
- The restaurant has its own six demo reservation tables and a non-scannable payment placeholder labelled `NOT A REAL QR CODE` / `DO NOT SCAN • NO PAYMENT`.
- Orders, reservations and payments use the existing ISLA PLATEU workflows. Payments are simulated; no real financial transaction is made.
- The database migration is additive and idempotent. It preserves existing restaurant IDs, customer/staff accounts, existing orders, and staff-edited menu values; it does not change PagudFood Cafe or The Cafe Infinite.

## Public references used for the profile

- Tripadvisor: https://www.tripadvisor.com/Restaurant_Review-g664445-d13313726-Reviews-Luca_Loko_Restaurant-Siquijor_Island_Visayas.html
- Koobo: https://www.koobo.ph/siquijor/restaurants/guides/luca-loko-restaurant-siquijor
- Siquijor Directory: https://beta.siquijordirectory.com/lucaloko/
