Gearly — Equipment Rental Platform (Server)
This repository contains the backend API for Gearly, an equipment rental marketplace. It provides the data and business rules used by the Next.js client, including equipment discovery, booking and availability validation, authentication middleware, role-based access control, dashboard data, and Stripe Checkout verification.
<p align="center">
  <a href="https://gearly-equipment-server.vercel.app"><strong>Live API</strong></a>
  ·
  <a href="https://gearly-equipment-client.vercel.app"><strong>Live Client</strong></a>
</p>Table of Contents
- Project Overview
- Live Links
- Core Responsibilities
- API Overview
- Authentication and Authorization
- Booking Availability
- Payment Verification
- Automated Booking Completion
- Technology Stack
- Getting Started
- Environment Variables
- Available Scripts and Checks
- Deployment
- Security Notes
- Related Repository
Project Overview
Gearly connects customers who need equipment for a limited period with owners who list equipment for rent. This server is the authoritative layer for application data and business rules.

The API uses Express.js and the MongoDB Native Driver. It is consumed by the separate Next.js client and is deployed on Vercel.
Live Links
Resource	URL
Backend API	https://gearly-equipment-server.vercel.app
Client Application	https://gearly-equipment-client.vercel.app


The backend root endpoint currently returns:
{
  "message": "Gearly API is running"
}
Core Responsibilities
- Connect to MongoDB and read/write application data using the Native Driver.
- Provide equipment listing, detail, search, filter, sort, and featured-listing endpoints.
- Provide monthly equipment availability summaries for the booking calendar.
- Validate booking date ranges and requested quantities on the server.
- Enforce authenticated access and role-based permissions.
- Provide customer, owner, and admin dashboard data.
- Create Stripe Checkout sessions and verify completed Checkout Sessions server-side.
- Run the scheduled booking-completion task through the configured local or Vercel schedule.
API Overview
The API is organized around the following resource groups. Route access depends on the endpoint's authentication and role requirements.
Method	Endpoint	Purpose
GET	/	Basic API status response.
GET	/api/health	Health-check endpoint.
GET	/api/equipment	Browse equipment with supported search, filters, sorting, and pagination.
GET	/api/equipment/featured	Retrieve featured approved equipment.
GET	/api/equipment/:id	Retrieve equipment details.
GET	/api/equipment/:id/monthly-availability?month=YYYY-MM	Retrieve daily booked and available quantities for a month.
GET	/api/reviews	Retrieve public reviews supported by the current API.
GET, PATCH	/api/profile	Read or update the authenticated user's profile.
GET, POST, PATCH, DELETE	Owner equipment routes	Manage equipment owned by the authenticated owner.
GET, POST, DELETE	Favorites routes	Read and manage the authenticated customer's favorites.
POST	Booking creation route	Validate and create a customer booking.
GET	/api/bookings/my	Retrieve the authenticated customer's booking history.
GET	/api/customer/analytics	Retrieve customer dashboard analytics.
GET	/api/owner/bookings	Retrieve rentals associated with the authenticated owner's equipment.
GET	/api/owner/analytics	Retrieve owner dashboard analytics.
GET	/api/admin/analytics	Retrieve platform-level admin analytics.
GET	/api/admin/bookings	Retrieve booking records for authorized administrators.
POST	/api/payments/checkout/:bookingId	Create a Stripe Checkout session for an eligible booking.
POST	/api/payments/verify-session	Verify a Stripe Checkout Session and update payment/booking state.
GET	/api/cron/complete-bookings	Protected scheduled endpoint for completing eligible bookings.


Some resource routes are grouped above to keep this overview readable. Refer to index.js for the exact route paths, request payloads, response structures, and authorization requirements. Do not assume that every route is public.
Authentication and Authorization
The API uses JWT verification and role-specific Express middleware. The main roles are:
Role	Access scope
Customer	Own profile, favorites, bookings, and customer dashboard data.
Owner	Own profile, own equipment, rentals associated with own equipment, and owner dashboard data.
Admin	Authorized platform-wide management and analytics.


The backend derives the authenticated identity from the verified token. It must not trust a customer or owner ID supplied by the browser as proof of identity.

Role checks and ownership filters are enforced at the API layer. A frontend route guard alone is not sufficient protection.
Booking Availability
The booking system supports quantity-aware equipment availability.
- The monthly availability endpoint returns aggregated daily quantity information for the requested equipment and month.
- It does not need to expose customer names, email addresses, booking IDs, or complete booking documents to the client.
- Availability is calculated from the equipment inventory and relevant overlapping bookings using the existing booking eligibility rules.
- Cancelled and rejected bookings are excluded according to those rules.
- The final booking-creation request validates availability again on the backend. A calendar response is only a preview because availability can change before submission.
- Date comparisons must follow the project's existing date-boundary convention and use consistent UTC handling where required.
Payment Verification
Gearly uses Stripe Checkout for hosted payment collection.
1. The client requests checkout for an eligible booking.
2. The server creates a Stripe Checkout Session using the server-side Stripe secret key.
3. The customer completes checkout on Stripe's hosted page.
4. The client returns with the Checkout Session reference and asks the backend to verify it.
5. The backend retrieves the session directly from Stripe and validates the relevant session, booking, customer, amount, and payment information.
6. Only a successfully verified paid session can transition the booking to the confirmed/paid state.
The backend is authoritative for payment status. A client-side success URL or query parameter is not proof of payment.

The current implementation uses the Checkout Session verification flow; this README does not describe a Stripe webhook integration. Do not expose STRIPE_SECRET_KEY to the frontend.
Automated Booking Completion
The backend includes an automated task that marks eligible bookings as completed after their rental end date has passed.

A booking is eligible only when it satisfies the existing completion rules, including:
- Its rental end date has passed.
- Its payment status is paid.
- Its booking status is one of the eligible active/confirmed states (confirmed, active, or ongoing).
Cancelled, rejected, unpaid, pending-payment, future, and already completed bookings are not changed by the task.
Local / Persistent Node.js Runtime
- node-cron runs the completion task hourly when the backend runs as a persistent Node.js process.
- The scheduled job uses the same booking-completion logic as the protected endpoint.
Vercel Runtime
Vercel Functions are serverless and should not rely on an in-process node-cron timer for production scheduling.
- The Vercel Cron configuration calls GET /api/cron/complete-bookings on the configured schedule.
- The endpoint checks the server-side CRON_SECRET authorization before accessing the completion operation.
- The current project configuration is reported as a daily schedule at 00:00 UTC; confirm the deployed vercel.json and Vercel plan before relying on a different frequency.
- Configure CRON_SECRET in the Vercel project environment before enabling the scheduled endpoint.
The task is designed to be safe to run repeatedly: only eligible records are matched for an update, so already completed bookings are not repeatedly changed.
Technology Stack
Area	Technology
Runtime	Node.js
API framework	Express.js
Database	MongoDB Native Driver
Authentication	JWT verification and role-based Express middleware
Payments	Stripe Checkout and server-side session verification
Local scheduling	node-cron
Production scheduling	Vercel Cron (through the protected endpoint)
Deployment	Vercel


Core backend packages include express, mongodb, cors, dotenv, jsonwebtoken, stripe, and node-cron. The exact installed packages and versions are defined in package.json and package-lock.json; use those files as the source of truth for the complete list. The codebase uses the MongoDB Native Driver; Mongoose is not used.
Getting Started
Prerequisites
- Node.js and npm.
- A MongoDB database and connection access.
- Stripe test-mode credentials for local payment testing.
- The environment variables required by the backend.
Installation
npm install
Configure Environment Variables
Create a local .env file using the exact variable names from the backend .env.example.

The backend configuration includes sensitive settings for:
- MongoDB connection credentials.
- JWT verification/signing configuration used by the existing authentication integration.
- Stripe secret key (STRIPE_SECRET_KEY).
- Cron authorization secret (CRON_SECRET).
- Frontend origin/CORS configuration and any other existing runtime settings.
Use Stripe test-mode credentials for local test payments. Never commit .env, expose secret values in logs, or place backend secrets in frontend variables.
Run Locally
npm run dev
The deployed API is available at https://gearly-equipment-server.vercel.app. For local development, use the local backend URL configured in the client environment.
Available Scripts and Checks
The exact scripts are defined in package.json. Common project checks include:
node --check index.js
npm test
If the project defines a dedicated test script, run it before changes are merged. A successful npm test command that reports zero tests means the test runner executed, but it does not mean automated test cases were run.
Deployment
The backend is deployed on Vercel.

Before production deployment, verify:
1. All required environment variables are configured in the Vercel project.
2. MongoDB network access allows the deployed backend to connect.
3. CORS allows the deployed client origin.
4. Stripe is configured with the intended test or live credentials.
5. The CRON_SECRET is configured and kept private.
6. vercel.json contains the intended Cron schedule and the schedule is supported by the selected Vercel plan.
7. The client can reach the deployed API and protected routes continue enforcing role/ownership checks.
Do not rely on a local node-cron timer as the production scheduler for Vercel Serverless Functions.
Security Notes
- Keep MongoDB credentials, JWT secrets, Stripe secret keys, and CRON_SECRET on the server only.
- Validate request data on the backend.
- Derive user identity from a verified token, not from arbitrary request-body fields.
- Enforce role and resource ownership checks for private data and mutations.
- Recheck availability during booking creation to avoid trusting stale calendar data.
- Verify Stripe Checkout Sessions on the server before marking a booking paid.
- Do not expose private booking/customer information through the monthly availability response.
Related Repository
The Next.js client is maintained separately:
- Client live URL: https://gearly-equipment-client.vercel.app
- Client README: See the client repository's README.md for UI, authentication integration, user workflows, and frontend setup.
<p align="center"><strong>Gearly API — powering smarter equipment rentals.</strong></p>