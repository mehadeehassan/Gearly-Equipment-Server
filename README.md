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
- `STRIPE_SECRET_KEY`: Stripe secret API key; keep it server-side.
- `STRIPE_WEBHOOK_SECRET`: webhook signing secret from Stripe CLI or Dashboard. It is not a publishable key.

Never commit `.env`.

## API features

- Public equipment listing, search, category, rental type, availability, price range, sorting and pagination.
- Equipment detail endpoint.
- Public customer reviews endpoint reads published reviews from the MongoDB `reviews` collection (no fabricated testimonials).
- `npm run seed:demo-reviews` idempotently inserts or updates 12 clearly labeled demo-only reviews (`status: "demo"`); the public reviews endpoint returns them with `demoOnly: true` so the UI can label them accurately.
- Profile read/update.
- Owner equipment create/read/update/delete.
- Customer favorites and rental booking with overlapping-date quantity availability checks.
- Stripe-hosted Checkout and verified webhook payment record.
- Admin user role management, equipment approval/rejection/update/delete and rental listing.
- Admin and owner analytics using MongoDB aggregation.

### Equipment list query parameters

`GET /api/equipment?search=drill&category=Construction%20Equipment&rentalType=Daily&availability=available&minPrice=100&maxPrice=5000&sort=price_asc&page=1&limit=12`

Supported sort values: `recent`, `price_asc`, `price_desc`.

## Authentication and roles

Private endpoints require `Authorization: Bearer <JWT>`. The API verifies signature, issuer, audience and expiry, then applies `verifyRenter`, `verifyOwner` or `verifyAdmin` middleware. Supported roles are `customer` (also accepts `renter` for renter routes), `owner` and `admin`.

The user ID in the service token must be a 24-character MongoDB ObjectId-compatible ID because the API queries user, booking, favorite and equipment ownership records with `ObjectId`.

## Stripe notes

Checkout is hosted by Stripe; the client redirects to the returned Checkout URL. The webhook endpoint is `POST /api/payments/webhook` and must be registered with Stripe (or forwarded locally with Stripe CLI). Stripe cannot send events directly to a `localhost` URL. For local testing, install and authenticate Stripe CLI, then run `stripe listen --forward-to localhost:5000/api/payments/webhook`. Copy the listener's `whsec_...` value into `STRIPE_WEBHOOK_SECRET` and restart the server. The listener must remain running during checkout testing.

Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`. For a deployed API, create a Stripe Dashboard webhook endpoint pointing to its public `/api/payments/webhook` URL and set that endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`. The endpoint verifies the untouched request body and signature. Only a session confirmed as paid changes the booking to `paid`; repeated events are deduplicated.

The Checkout implementation currently uses BDT. Confirm your Stripe account supports the intended currency before going live. Production inventory reservation and webhook processing should be made transaction-safe/idempotent with a MongoDB replica set.
