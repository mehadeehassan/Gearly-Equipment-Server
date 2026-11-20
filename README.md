# Gearly — Equipment Rental Platform (Server)

Standalone Express API for the Gearly equipment rental marketplace. Uses the MongoDB Native Driver (no Mongoose).

## Run locally

1. Copy `.env.example` to `.env` and fill in MongoDB and Stripe server credentials.
2. Run `npm install`.
3. Run `npm run dev`.
4. Check `http://localhost:5000/api/health`.

## Environment variables

- `PORT`, `CLIENT_URL`: API port and allowed frontend origin.
- `MONGODB_URI`, `DB_NAME`: MongoDB connection and database.
- `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`: must exactly match the Next.js client values. The client signs a short-lived HS256 service token on the server after checking the Better Auth session.
- `STRIPE_SECRET_KEY`: a Stripe Test Mode secret or restricted key for local Checkout. Keep it server-side.
- `CRON_SECRET`: a long random secret used by Vercel Cron to authorize booking completion. Configure it as a server-side Vercel environment variable; never add it to the frontend.

Never commit `.env`.

## Automatic booking completion

Bookings are marked `completed` when their `endDate` is earlier than the current UTC time, their `paymentStatus` is `paid`, and their `bookingStatus` is `confirmed`, `active`, or `ongoing`. The update query only matches those eligible states, so rerunning it leaves unpaid, pending-payment, cancelled, rejected, and already completed bookings unchanged.

For local development or a persistent Node.js server, `node-cron` runs the update once each hour at minute 0 in UTC. On Vercel, the in-process schedule is disabled; `vercel.json` invokes the protected `GET /api/cron/complete-bookings` endpoint daily at 00:00 UTC, which is compatible with Hobby plan scheduling. If the Vercel project is on Pro or Enterprise and hourly updates are preferred, change the schedule to `0 * * * *`. Set `CRON_SECRET` in the Vercel project environment before enabling the deployment cron. Vercel sends `Authorization: Bearer <CRON_SECRET>`; requests without the matching header are rejected.

## API features

- Public equipment listing, search, category, rental type, availability, price range, sorting and pagination.
- Equipment detail endpoint.
- Public customer reviews endpoint reads published reviews from the MongoDB `reviews` collection (no fabricated testimonials).
- `npm run seed:demo-reviews` idempotently inserts or updates 12 clearly labeled demo-only reviews (`status: "demo"`); the public reviews endpoint returns them with `demoOnly: true` so the UI can label them accurately.
- Profile read/update.
- Owner equipment create/read/update/delete.
- Customer favorites and rental booking with overlapping-date quantity availability checks.
- Stripe-hosted Checkout and authenticated server-side Checkout Session verification.
- Admin user role management, equipment approval/rejection/update/delete and rental listing.
- Admin and owner analytics using MongoDB aggregation.

### Equipment list query parameters

`GET /api/equipment?search=drill&category=Construction%20Equipment&rentalType=Daily&availability=available&minPrice=100&maxPrice=5000&sort=price_asc&page=1&limit=12`

Supported sort values: `recent`, `price_asc`, `price_desc`.

## Authentication and roles

Private endpoints require `Authorization: Bearer <JWT>`. The API verifies signature, issuer, audience and expiry, then applies `verifyRenter`, `verifyOwner` or `verifyAdmin` middleware. Supported roles are `customer` (also accepts `renter` for renter routes), `owner` and `admin`.

The user ID in the service token must be a 24-character MongoDB ObjectId-compatible ID because the API queries user, booking, favorite and equipment ownership records with `ObjectId`.

## Stripe notes

Checkout is hosted by Stripe; the client redirects to the returned Checkout URL. After Stripe redirects to the success page, the authenticated client submits only the Checkout Session ID to `POST /api/payments/verify-session`. The server retrieves the Session with `STRIPE_SECRET_KEY` and verifies Test Mode, customer and booking linkage, amount, currency, and `payment_status` before updating MongoDB. No webhook secret, Stripe CLI forwarding, or Dashboard webhook is needed for this localhost flow.

This return-page verification is intended for local synchronous Test Mode card payments. A customer who pays but never returns to Gearly will not trigger a database update. Use signed webhooks before production or enabling delayed/asynchronous payment methods. The Checkout implementation currently uses BDT and verifies that currency against the booking.
