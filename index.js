import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';

// অনুমোদিত Role-এর তালিকায় ব্যবহারকারীর Role আছে কি না যাচাই করে।
export function isRoleAllowed(role, allowedRoles) {
  return allowedRoles.includes(role);
}

// Owner-এর Equipment অনুযায়ী নিরাপদ MongoDB filter তৈরি করে।
export function ownedEquipmentFilter(ownerId, equipmentId) {
  return {
    ...(equipmentId ? { _id: new ObjectId(equipmentId) } : {}),
    ownerId: new ObjectId(ownerId),
  };
}

// Customer-এর Booking-গুলো খুঁজতে MongoDB filter তৈরি করে।
export function customerBookingFilter(customerId) {
  return { customerId: new ObjectId(customerId) };
}

// Owner-এর Booking-গুলো খুঁজতে MongoDB filter তৈরি করে।
export function ownerBookingFilter(ownerId) {
  return { ownerId: new ObjectId(ownerId) };
}

// Owner-এর নামসহ Admin Equipment তালিকার aggregation তৈরি করে।
export function adminEquipmentPipeline() {
  return [
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $lookup: {
        from: 'user',
        let: {
          ownerKey: { $convert: { input: '$ownerId', to: 'string', onError: '', onNull: '' } },
        },
        pipeline: [
          { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$ownerKey'] } } },
          { $project: { _id: 0, name: 1 } },
        ],
        as: 'ownerRecord',
      },
    },
    {
      $addFields: {
        ownerName: { $ifNull: [{ $arrayElemAt: ['$ownerRecord.name', 0] }, 'Unknown Owner'] },
      },
    },
    { $project: { ownerRecord: 0 } },
  ];
}

// Booking-এর বর্তমান অবস্থা দেখে Payment আবার শুরু করা যাবে কি না জানায়।
export function canRetryBookingPayment(booking) {
  return Boolean(
    booking &&
    ['pending', 'failed', 'cancelled'].includes(booking.paymentStatus) &&
    ['pending', 'pending_payment', 'payment_failed'].includes(booking.bookingStatus),
  );
}

// Equipment update-এর অনুমোদিত field বেছে নিয়ে মান যাচাই করে।
export function parseEquipmentUpdate(input = {}) {
  const fields = [
    'title',
    'description',
    'category',
    'location',
    'price',
    'rentalType',
    'availableQuantity',
    'condition',
    'brand',
    'model',
    'image',
    'terms',
  ];
  const update = {};
  for (const field of fields) if (input[field] !== undefined) update[field] = input[field];
  for (const field of [
    'title',
    'description',
    'category',
    'location',
    'image',
    'terms',
    'condition',
    'brand',
    'model',
  ]) {
    if (update[field] !== undefined && typeof update[field] !== 'string')
      return { error: `Invalid ${field}` };
  }
  for (const field of [
    'title',
    'description',
    'category',
    'location',
    'image',
    'terms',
    'condition',
    'brand',
    'model',
  ]) {
    if (typeof update[field] === 'string') update[field] = update[field].trim();
  }
  if (update.price !== undefined) update.price = Number(update.price);
  if (update.availableQuantity !== undefined)
    update.availableQuantity = Number(update.availableQuantity);
  if (
    update.rentalType !== undefined &&
    !['Daily', 'Weekly', 'Monthly'].includes(update.rentalType)
  ) {
    return { error: 'Invalid rental type' };
  }
  if (update.price !== undefined && (!Number.isFinite(update.price) || update.price <= 0)) {
    return { error: 'Price must be greater than zero' };
  }
  if (
    update.availableQuantity !== undefined &&
    (!Number.isInteger(update.availableQuantity) || update.availableQuantity < 0)
  ) {
    return { error: 'Available quantity must be a non-negative whole number' };
  }
  for (const field of ['title', 'description', 'category', 'location', 'image']) {
    if (update[field] !== undefined && !update[field]) return { error: `${field} is required` };
  }
  if (Object.keys(update).length === 0) return { error: 'No editable equipment fields provided' };
  return { update };
}

// ID-টি বৈধ MongoDB ObjectId কি না যাচাই করে।
const isObjectId = (value) =>
  typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) && ObjectId.isValid(value);

// Stripe Payment Intent থেকে তার ID বের করে।
const paymentIntentId = (paymentIntent) =>
  typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id || null;

// Stripe key Test Mode-এর কি না যাচাই করে।
export function isTestStripeSecretKey(secretKey) {
  return typeof secretKey === 'string' && /^(sk|rk)_test_/.test(secretKey);
}

// Stripe Checkout Session যাচাই করে Booking ও Payment-এর অবস্থা হালনাগাদ করে।
export async function verifyCheckoutSession(
  req,
  res,
  { stripe, stripeSecretKey, bookingsCollection, paymentsCollection },
) {
  if (!stripe || !isTestStripeSecretKey(stripeSecretKey)) {
    return res.status(503).send({ message: 'Stripe Test Mode is not configured' });
  }

  const { sessionId } = req.body || {};
  const customerId = String(req.user?.id || '');
  if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_') || sessionId.length > 128) {
    return res.status(400).send({ message: 'A valid Checkout Session ID is required' });
  }
  if (!isObjectId(customerId)) {
    return res.status(401).send({ message: 'A valid customer session is required' });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
  } catch (error) {
    if (error?.code === 'resource_missing' || error?.statusCode === 404) {
      return res.status(404).send({ message: 'Checkout Session not found' });
    }
    return res.status(502).send({ message: 'Unable to verify the Checkout Session with Stripe' });
  }

  if (!session || session.id !== sessionId || session.object !== 'checkout.session') {
    return res.status(404).send({ message: 'Checkout Session not found' });
  }
  if (session.livemode !== false || session.mode !== 'payment') {
    return res.status(409).send({ message: 'Checkout Session is not a Test Mode payment session' });
  }

  const bookingId = session.metadata?.bookingId;
  const sessionCustomerId = session.metadata?.customerId;
  if (
    !isObjectId(bookingId) ||
    sessionCustomerId !== customerId ||
    session.client_reference_id !== bookingId
  ) {
    return res.status(404).send({ message: 'Checkout Session does not belong to this customer' });
  }

  const bookingFilter = {
    _id: new ObjectId(bookingId),
    customerId: new ObjectId(customerId),
    stripeSessionId: session.id,
  };
  // Session-এর Booking কেবল সংশ্লিষ্ট Customer-এর জন্য খোঁজা হয়।
  const booking = await bookingsCollection.findOne(bookingFilter);
  if (!booking)
    return res.status(404).send({ message: 'Booking for this Checkout Session was not found' });

  // Stripe-এর ক্ষুদ্রতম মুদ্রা এককে Booking-এর প্রত্যাশিত অর্থ মেলায়।
  const expectedAmount = Math.round(Number(booking.totalAmount) * 100);
  const expectedCurrency = String(booking.currency || 'bdt').toLowerCase();
  if (
    !Number.isSafeInteger(expectedAmount) ||
    session.amount_total !== expectedAmount ||
    String(session.currency || '').toLowerCase() !== expectedCurrency
  ) {
    return res
      .status(409)
      .send({ message: 'Checkout Session amount or currency does not match the booking' });
  }

  if (session.status === 'expired') {
    return markUnpaidStatus(bookingFilter, bookingsCollection, res, 'expired', 'payment_expired');
  }

  if (session.payment_status !== 'paid') {
    if (session.payment_status === 'no_payment_required') {
      return res.send({ status: 'unpaid', bookingId: String(booking._id) });
    }

    let intent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
    if (session.status === 'complete' && !intent && session.payment_intent) {
      try {
        intent = await stripe.paymentIntents.retrieve(session.payment_intent);
      } catch {
        return res.status(502).send({ message: 'Unable to verify the Checkout payment status' });
      }
    }

    if (
      session.status === 'complete' &&
      ['requires_payment_method', 'canceled'].includes(intent?.status)
    ) {
      return markUnpaidStatus(bookingFilter, bookingsCollection, res, 'failed', 'payment_failed');
    }
    return res.send({ status: 'pending', bookingId: String(booking._id) });
  }

  // Stripe-এর যাচাইকৃত Session থেকেই Payment Intent ID নেওয়া হয়।
  const intentId = paymentIntentId(session.payment_intent);
  if (!intentId) {
    return res.status(409).send({ message: 'Paid Checkout Session is missing its Payment Intent' });
  }

  const existingPayment = await paymentsCollection.findOne({ stripeSessionId: session.id });
  if (
    existingPayment &&
    (String(existingPayment.bookingId) !== String(booking._id) ||
      String(existingPayment.customerId) !== customerId ||
      existingPayment.paymentIntentId !== intentId)
  ) {
    return res
      .status(409)
      .send({ message: 'Checkout Session is already linked to a different payment' });
  }

  if (booking.paymentStatus !== 'paid') {
    await bookingsCollection.updateOne(
      { ...bookingFilter, paymentStatus: { $ne: 'paid' } },
      {
        $set: {
          paymentStatus: 'paid',
          bookingStatus: 'confirmed',
          stripeCheckoutStatus: 'complete',
          stripePaymentIntentId: intentId,
          transactionId: intentId,
          paidAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );
  }

  const currentBooking = await bookingsCollection.findOne(bookingFilter);
  if (
    !currentBooking ||
    currentBooking.paymentStatus !== 'paid' ||
    currentBooking.stripeSessionId !== session.id ||
    (currentBooking.stripePaymentIntentId && currentBooking.stripePaymentIntentId !== intentId)
  ) {
    return res.status(409).send({ message: 'Booking changed while payment was being verified' });
  }

  // একই Session একাধিকবার যাচাই হলেও Payment record একটিই রাখে।
  try {
    await paymentsCollection.updateOne(
      { stripeSessionId: session.id },
      {
        $set: {
          paymentIntentId: intentId,
          transactionId: intentId,
          bookingId: currentBooking._id,
          customerId: currentBooking.customerId,
          ownerId: currentBooking.ownerId,
          amount: currentBooking.totalAmount,
          currency: expectedCurrency,
          status: 'paid',
          verifiedAt: new Date(),
        },
        $setOnInsert: { stripeSessionId: session.id, createdAt: new Date() },
      },
      { upsert: true },
    );
  } catch (error) {
    // Concurrent idempotent verifications can race on the unique session index.
    if (error?.code !== 11000) throw error;
    const racedPayment = await paymentsCollection.findOne({ stripeSessionId: session.id });
    if (
      !racedPayment ||
      String(racedPayment.bookingId) !== String(currentBooking._id) ||
      String(racedPayment.customerId) !== customerId ||
      racedPayment.paymentIntentId !== intentId
    ) {
      return res
        .status(409)
        .send({ message: 'Checkout Session is already linked to a different payment' });
    }
  }

  return res.send({ status: 'paid', bookingId: String(currentBooking._id) });
}

// Booking ইতিমধ্যে paid না হলে Payment ও Booking status হালনাগাদ করে।
async function markUnpaidStatus(
  bookingFilter,
  bookingsCollection,
  res,
  paymentStatus,
  bookingStatus,
) {
  await bookingsCollection.updateOne(
    { ...bookingFilter, paymentStatus: { $ne: 'paid' } },
    { $set: { paymentStatus, bookingStatus, updatedAt: new Date() } },
  );
  const booking = await bookingsCollection.findOne(bookingFilter);
  if (!booking)
    return res.status(404).send({ message: 'Booking for this Checkout Session was not found' });
  if (booking.paymentStatus === 'paid') {
    return res.send({ status: 'paid', bookingId: String(booking._id) });
  }
  return res.send({ status: paymentStatus, bookingId: String(booking._id) });
}

// Customer-এর Booking-এর জন্য Stripe Checkout Session তৈরি করে।
export async function startCheckoutSession(
  req,
  res,
  { stripe, stripeSecretKey, clientUrl, bookingsCollection, paymentsCollection },
) {
  if (!stripe || !isTestStripeSecretKey(stripeSecretKey)) {
    return res.status(503).send({ message: 'Stripe Test Mode is not configured' });
  }
  const { bookingId } = req.params || {};
  const customerId = String(req.user?.id || '');
  if (
    typeof bookingId !== 'string' ||
    !/^[a-f\d]{24}$/i.test(bookingId) ||
    !ObjectId.isValid(bookingId)
  ) {
    return res.status(400).send({ message: 'Invalid booking id' });
  }

  try {
    // Customer ID ও Payment status মিলিয়ে Booking খোঁজা হয়।
    const bookingFilter = {
      _id: new ObjectId(bookingId),
      ...customerBookingFilter(customerId),
      paymentStatus: { $in: ['pending', 'failed', 'cancelled'] },
    };
    let booking = await bookingsCollection.findOne(bookingFilter);
    if (!canRetryBookingPayment(booking))
      return res.status(404).send({ message: 'Booking is not eligible for payment' });

    let previousSession;
    if (booking.stripeSessionId) {
      try {
        previousSession = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);
      } catch {
        return res.status(502).send({ message: 'Unable to check the previous Checkout Session' });
      }
      if (previousSession.status === 'complete') {
        const verificationResponse = {
          statusCode: 200,
          status(code) {
            this.statusCode = code;
            return this;
          },
          send(body) {
            this.body = body;
            return this;
          },
        };
        await verifyCheckoutSession(
          { body: { sessionId: booking.stripeSessionId }, user: req.user },
          verificationResponse,
          { stripe, stripeSecretKey, bookingsCollection, paymentsCollection },
        );
        if (verificationResponse.body?.status === 'paid') {
          return res.status(409).send({
            message:
              'This booking is already paid. Refresh My Rentals to see the confirmed booking.',
          });
        }
        if (verificationResponse.body?.status === 'pending') {
          return res.status(409).send({
            message:
              'The previous payment is still processing. Wait for verification before retrying.',
          });
        }
        if (verificationResponse.statusCode !== 200) {
          return res.status(verificationResponse.statusCode).send(verificationResponse.body);
        }
        booking = await bookingsCollection.findOne(bookingFilter);
        if (!canRetryBookingPayment(booking))
          return res.status(409).send({ message: 'Booking is no longer eligible for payment' });
      }
    }

    const checkoutAttemptId = randomUUID();
    // একই Booking-এর জন্য একসঙ্গে একাধিক Checkout শুরু হওয়া ঠেকায়।
    const lock = await bookingsCollection.updateOne(
      {
        ...bookingFilter,
        bookingStatus: booking.bookingStatus,
        $or: [
          { checkoutAttemptAt: { $exists: false } },
          { checkoutAttemptAt: { $lt: new Date(Date.now() - 120000) } },
        ],
      },
      { $set: { checkoutAttemptId, checkoutAttemptAt: new Date() } },
    );
    if (!lock.matchedCount)
      return res.status(409).send({ message: 'Checkout is already starting for this booking' });

    let session;
    try {
      if (booking.stripeSessionId && previousSession?.status === 'open') {
        await stripe.checkout.sessions.expire(booking.stripeSessionId);
      }
      // Client পাঠানো amount নয়, Database-এর Booking amount ব্যবহার হয়।
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'bdt',
              product_data: { name: booking.equipmentTitle },
              unit_amount: Math.round(booking.totalAmount * 100),
            },
            quantity: 1,
          },
        ],
        success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/payment/cancel?booking_id=${booking._id}`,
        client_reference_id: String(booking._id),
        metadata: { bookingId: String(booking._id), customerId },
      });
    } catch {
      await bookingsCollection.updateOne(
        { _id: booking._id, checkoutAttemptId },
        { $unset: { checkoutAttemptId: '', checkoutAttemptAt: '' } },
      );
      return res
        .status(502)
        .send({ message: 'Unable to safely start Checkout. Please try again.' });
    }

    const linked = await bookingsCollection.updateOne(
      { ...bookingFilter, _id: booking._id, checkoutAttemptId },
      {
        $set: {
          stripeSessionId: session.id,
          paymentStatus: 'pending',
          bookingStatus: 'pending_payment',
          stripeCheckoutStatus: 'open',
          updatedAt: new Date(),
        },
        $unset: {
          failedAt: '',
          stripePaymentIntentId: '',
          checkoutAttemptId: '',
          checkoutAttemptAt: '',
        },
      },
    );
    if (!linked.matchedCount) {
      await stripe.checkout.sessions.expire(session.id).catch(() => {});
      return res
        .status(409)
        .send({ message: 'Booking status changed. Please refresh and try again.' });
    }
    return res.send({ url: session.url });
  } catch {
    return res.status(500).send({ message: 'Unable to start checkout' });
  }
}

const app = express();
const port = process.env.PORT || 5000;
const client = new MongoClient(process.env.MONGODB_URI);
// MongoDB-তে সংযোগ করে সফল হলে Client ফেরত দেয়।
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log('You successfully connected to MongoDB!');
    return client;
  } catch {
    console.error('Unable to connect to MongoDB.');
    throw new Error('Unable to connect to MongoDB.');
  }
}

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// নির্ধারিত Client origin থেকে API অনুরোধ গ্রহণের অনুমতি দেয়।
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }));

let usersCollection,
  equipmentCollection,
  bookingsCollection,
  favoritesCollection,
  paymentsCollection,
  reviewsCollection;

let databaseInitialization;
// Database সংযোগ, Collection ও প্রয়োজনীয় Index একবারে প্রস্তুত করে।
async function initializeDatabase() {
  if (!databaseInitialization) {
    databaseInitialization = (async () => {
      await connectToMongoDB();
      const db = client.db(process.env.DB_NAME || 'equipment_rental');
      usersCollection = db.collection('user');
      equipmentCollection = db.collection('equipment');
      bookingsCollection = db.collection('bookings');
      favoritesCollection = db.collection('favorites');
      paymentsCollection = db.collection('payments');
      reviewsCollection = db.collection('reviews');
      await Promise.all([
        favoritesCollection.createIndex({ userId: 1, equipmentId: 1 }, { unique: true }),
        bookingsCollection.createIndex({ customerId: 1, bookingDate: -1 }),
        bookingsCollection.createIndex({ ownerId: 1, bookingDate: -1 }),
        bookingsCollection.createIndex({ equipmentId: 1, startDate: 1, endDate: 1, bookingStatus: 1 }),
        equipmentCollection.createIndex({ status: 1, category: 1, createdAt: -1 }),
        paymentsCollection.createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true }),
        paymentsCollection.createIndex({ transactionId: 1 }, { unique: true, sparse: true }),
        reviewsCollection.createIndex(
          { bookingId: 1 },
          { unique: true, partialFilterExpression: { bookingId: { $exists: true } } },
        ),
        reviewsCollection.createIndex({ status: 1, isFeatured: 1, createdAt: -1 }),
      ]);
    })();
  }
  try {
    await databaseInitialization;
  } catch (error) {
    databaseInitialization = null;
    throw error;
  }
}

// নির্ধারিত তারিখ পেরোনো paid Booking-গুলো completed করে।
async function completeExpiredBookings() {
  const result = await bookingsCollection.updateMany(
    {
      endDate: { $lt: new Date() },
      paymentStatus: 'paid',
      bookingStatus: { $in: ['confirmed', 'active', 'ongoing'] },
    },
    { $set: { bookingStatus: 'completed' } },
  );
  console.log(`Automated booking status update completed: ${result.modifiedCount} booking(s) updated (UTC).`);
  return result.modifiedCount;
}

// প্রতিটি অনুরোধের সময়, method ও URL log করে।
function myLogger(req, res, next) {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
}
app.use(myLogger);

// JSON request body সর্বোচ্চ 2 MB পর্যন্ত parse করে।
app.use(express.json({ limit: '2mb' }));

if (process.env.VERCEL === '1') {
  // Vercel অনুরোধে Database প্রস্তুত করে; Cron route নিজে সংযোগ সামলায়।
  app.use(async (req, res, next) => {
    if (req.path === '/api/cron/complete-bookings') return next();
    try {
      await initializeDatabase();
      next();
    } catch {
      res.status(503).send({ message: 'Service temporarily unavailable' });
    }
  });
}

// GET /api/cron/complete-bookings - মেয়াদোত্তীর্ণ paid Booking সম্পন্ন করে।
app.get('/api/cron/complete-bookings', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).send({ message: 'Scheduled task is not configured' });
  if (req.headers.authorization !== `Bearer ${secret}`)
    return res.status(401).send({ message: 'Unauthorized' });
  if (process.env.VERCEL === '1') {
    try {
      await initializeDatabase();
    } catch {
      return res.status(503).send({ message: 'Service temporarily unavailable' });
    }
  }
  try {
    const updated = await completeExpiredBookings();
    return res.send({ updated });
  } catch {
    return res.status(500).send({ message: 'Unable to update completed bookings' });
  }
});

// Bearer JWT যাচাই করে ব্যবহারকারীর পরিচয় request-এ যোগ করে।
function verifyToken(req, res, next) {
  const authorization = req.headers.authorization;
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return res.status(401).send({ message: 'Unauthorized access' });
  }
  const token = authorization.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE,
    });
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).send({ message: 'Invalid or expired token' });
  }
}

// Renter বা Customer Role অনুমোদন করে।
const verifyRenter = (req, res, next) => {
  if (!isRoleAllowed(req.user?.role, ['customer', 'renter']))
    return res.status(403).send({ message: 'Renter access required' });
  next();
};
// Verified session role দিয়ে Customer এবং legacy Renter অনুমোদন করে।
const verifyCustomer = (req, res, next) => {
  const role = typeof req.user?.role === 'string' ? req.user.role.trim().toLowerCase() : '';
  if (!isRoleAllowed(role, ['customer', 'renter']))
    return res.status(403).send({ message: 'Customer access required' });
  next();
};
// Owner Role অনুমোদন করে।
const verifyOwner = (req, res, next) => {
  if (!isRoleAllowed(req.user?.role, ['owner']))
    return res.status(403).send({ message: 'Owner access required' });
  next();
};
// Admin Role অনুমোদন করে।
const verifyAdmin = (req, res, next) => {
  if (!isRoleAllowed(req.user?.role, ['admin']))
    return res.status(403).send({ message: 'Admin access required' });
  next();
};

// ID বৈধ কি না এবং ObjectId-তে রূপান্তর—দুই কাজের helper।
const validId = (id) => ObjectId.isValid(id);
// ID-কে MongoDB ObjectId-তে রূপান্তর করে।
const toObjectId = (id) => new ObjectId(id);
// Regular Expression-এ বিশেষ অর্থ থাকা অক্ষর escape করে।
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pagination-এর জন্য skip, limit ও pagination তথ্য তৈরি করে।
function getPagination(pageValue, totalRecords, limitValue) {
  const requestedPage = Number(pageValue);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const requestedLimit = Number(limitValue);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 10)
    : 10;
  const totalPages = Math.ceil(totalRecords / limit);
  const currentPage = totalPages ? Math.min(page, totalPages) : 1;
  return {
    skip: (currentPage - 1) * limit,
    limit,
    pagination: {
      currentPage,
      limit,
      totalRecords,
      totalPages,
      hasNextPage: currentPage < totalPages,
      hasPreviousPage: currentPage > 1,
    },
  };
}

// Payment API: Checkout Session যাচাই করে Payment status নিশ্চিত করে।
// POST /api/payments/verify-session - Stripe Session যাচাই করে।
app.post('/api/payments/verify-session', verifyToken, verifyRenter, (req, res) =>
  verifyCheckoutSession(req, res, {
    stripe,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    bookingsCollection,
    paymentsCollection,
  }),
);

// সাধারণ API ও Health endpoint।
// GET / - API চালু আছে কি না জানায়।
app.get('/', (req, res) => res.send({ message: 'Gearly API is running' }));
// GET /api/health - API-এর Health status জানায়।
app.get('/api/health', (req, res) => res.send({ status: 'ok' }));

// Public Equipment API।
// GET /api/equipment - Search, filter, sort ও pagination অনুযায়ী Equipment দেখায়।
app.get('/api/equipment', async (req, res) => {
  try {
    const {
      search,
      category,
      rentalType,
      availability,
      minPrice,
      maxPrice,
      sort = 'recent',
      page = '1',
      limit = '12',
    } = req.query;
    const query = { status: 'approved' };
    if (category) query.category = category;
    if (rentalType) query.rentalType = rentalType;
    if (availability === 'available') query.availableQuantity = { $gt: 0 };
    if (availability === 'unavailable') query.availableQuantity = { $lte: 0 };
    if (minPrice !== undefined || maxPrice !== undefined) {
      query.price = {};
      if (minPrice !== undefined && Number.isFinite(Number(minPrice)))
        query.price.$gte = Math.max(0, Number(minPrice));
      if (maxPrice !== undefined && Number.isFinite(Number(maxPrice)))
        query.price.$lte = Math.max(0, Number(maxPrice));
      if (!Object.keys(query.price).length) delete query.price;
    }
    if (search) {
      const safeSearch = new RegExp(escapeRegex(String(search)), 'i');
      query.$or = [{ title: safeSearch }, { category: safeSearch }, { location: safeSearch }];
    }
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(30, Math.max(1, Number(limit) || 12));
    const sortOptions =
      sort === 'price_asc'
        ? { price: 1 }
        : sort === 'price_desc'
          ? { price: -1 }
          : { createdAt: -1 };
    const [equipment, total] = await Promise.all([
      equipmentCollection
        .find(query)
        .sort(sortOptions)
        .skip((pageNumber - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      equipmentCollection.countDocuments(query),
    ]);
    res.send({ equipment, total, page: pageNumber, totalPages: Math.ceil(total / pageSize) });
  } catch (error) {
    res.status(500).send({ message: 'Failed to load equipment' });
  }
});

// GET /api/equipment/featured - সাম্প্রতিক ছয়টি অনুমোদিত Equipment দেখায়।
app.get('/api/equipment/featured', async (req, res) => {
  try {
    const equipment = await equipmentCollection
      .find({ status: 'approved' })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();
    res.send({ equipment });
  } catch {
    res.status(500).send({ message: 'Failed to load featured equipment' });
  }
});

// Review API: Booking সম্পন্ন হওয়ার পরের Review দেখায় ও জমা নেয়।
// GET /api/reviews - Booking-সংশ্লিষ্ট অনুমোদিত Review দেখায়।
app.get('/api/reviews', async (req, res) => {
  try {
    const reviews = await reviewsCollection
      .find(
        { status: 'approved', isFeatured: true, bookingId: { $type: 'objectId' } },
        { projection: { customerName: 1, customerImage: 1, equipmentTitle: 1, rating: 1, comment: 1, createdAt: 1 } },
      )
      .sort({ createdAt: -1 })
      .limit(15)
      .toArray();
    res.send({ reviews });
  } catch {
    res.status(500).send({ message: 'Failed to load reviews' });
  }
});

// POST /api/reviews - সম্পন্ন paid Booking-এর Review জমা নেয়।
app.post('/api/reviews', verifyToken, verifyCustomer, async (req, res) => {
  const fieldErrors = {};
  const bookingId = validId(req.body?.bookingId) ? toObjectId(req.body.bookingId) : null;
  const rating = Number(req.body?.rating);
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
  if (!bookingId) fieldErrors.bookingId = 'Select a valid booking.';
  if (!Number.isInteger(rating) || rating < 1 || rating > 5)
    fieldErrors.rating = 'Choose a rating from 1 to 5 stars.';
  if (!comment) fieldErrors.comment = 'Write a comment before submitting.';
  else if (comment.length > 1000) fieldErrors.comment = 'Keep your comment under 1000 characters.';
  if (Object.keys(fieldErrors).length)
    return res.status(400).send({ message: 'Please correct the review details.', fieldErrors });

  try {
    const customerId = toObjectId(req.user.id);
    const customer = await findReviewUser(req.user.id);
    const accountRole = typeof customer?.role === 'string' ? customer.role.trim().toLowerCase() : '';
    if (!customer || (customer.role != null && !isRoleAllowed(accountRole, ['customer', 'renter'])))
      return res.status(403).send({ message: 'Customer access required' });

    const booking = await bookingsCollection.findOne({
      _id: bookingId,
      customerId,
      paymentStatus: 'paid',
      bookingStatus: 'completed',
    });
    if (!booking)
      return res.status(403).send({ message: 'A review is available after your paid rental is completed.' });

    const review = {
      customerId,
      customerName: customer.name || req.user.name || 'Gearly customer',
      customerImage: customer.image || '',
      bookingId: booking._id,
      equipmentId: booking.equipmentId,
      equipmentTitle: booking.equipmentTitle || '',
      rating,
      comment,
      status: 'approved',
      isFeatured: false,
      createdAt: new Date(),
    };
    const result = await reviewsCollection.insertOne(review);
    return res.status(201).send({ review: { ...review, _id: result.insertedId } });
  } catch (error) {
    if (error?.code === 11000)
      return res.status(409).send({ message: 'You have already reviewed this rental.' });
    return res.status(500).send({ message: 'Unable to submit your review. Please try again.' });
  }
});

// User record IDs are strings in Better Auth and ObjectIds in older project records.
async function findReviewUser(userId, includeEmail = false) {
  const id = String(userId || '');
  const projection = { projection: { name: 1, image: 1, role: 1, ...(includeEmail ? { email: 1 } : {}) } };
  const user = await usersCollection.findOne({ _id: id }, projection);
  return user || (validId(id) ? usersCollection.findOne({ _id: toObjectId(id) }, projection) : null);
}

async function getReviewDetails(review, includePrivateInfo = false) {
  const equipmentId = review.equipmentId;
  const equipmentIdText = String(equipmentId || '');
  const equipment =
    (equipmentId ? await equipmentCollection.findOne({ _id: equipmentId }) : null) ||
    (validId(equipmentIdText) ? await equipmentCollection.findOne({ _id: toObjectId(equipmentIdText) }) : null);
  const [customer, owner] = await Promise.all([
    findReviewUser(review.customerId, includePrivateInfo),
    equipment?.ownerId ? findReviewUser(equipment.ownerId, includePrivateInfo) : null,
  ]);
  const safeReview = { ...review };
  delete safeReview.customerId;
  delete safeReview.bookingId;
  return {
    ...safeReview,
    _id: String(review._id),
    equipmentId: equipment ? String(equipment._id) : equipmentIdText,
    customerName: customer?.name || review.customerName || 'Gearly customer',
    customerImage: customer?.image || review.customerImage || '',
    ...(includePrivateInfo ? { customerEmail: customer?.email || '' } : {}),
    equipmentTitle: equipment?.title || review.equipmentTitle || 'Equipment',
    equipmentImage: equipment?.image || '',
    ownerName: owner?.name || 'Equipment owner',
    ...(includePrivateInfo ? { ownerEmail: owner?.email || '' } : {}),
  };
}

// GET /api/admin/reviews - Admin সব Customer Review এবং সংশ্লিষ্ট তথ্য দেখেন।
app.get('/api/admin/reviews', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const filter = req.query.filter === 'featured'
      ? { isFeatured: true }
      : req.query.filter === 'hidden'
        ? { $or: [{ isFeatured: false }, { isFeatured: { $exists: false } }] }
        : {};
    const search = String(req.query.search || '').trim();
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      const searchMatches = [
        { customerName: pattern },
        { equipmentTitle: pattern },
        { comment: pattern },
      ];
      const [users, equipment] = await Promise.all([
        usersCollection.find({ $or: [{ name: pattern }, { email: pattern }] }, { projection: { _id: 1 } }).toArray(),
        equipmentCollection.find({ title: pattern }, { projection: { _id: 1 } }).toArray(),
      ]);
      const userIds = users.flatMap(({ _id }) => [_id, validId(String(_id)) ? toObjectId(String(_id)) : String(_id)]);
      const equipmentIds = equipment.flatMap(({ _id }) => [_id, String(_id)]);
      if (userIds.length) searchMatches.push({ customerId: { $in: userIds } });
      if (equipmentIds.length) searchMatches.push({ equipmentId: { $in: equipmentIds } });
      filter.$and = [{ $or: searchMatches }];
    }
    const totalRecords = await reviewsCollection.countDocuments(filter);
    const { skip, limit, pagination } = getPagination(req.query.page, totalRecords, req.query.limit);
    const rows = await reviewsCollection.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).toArray();
    const reviews = await Promise.all(rows.map((review) => getReviewDetails(review, true)));
    const [allReviews, featuredReviews] = await Promise.all([
      reviewsCollection.countDocuments({}),
      reviewsCollection.countDocuments({ isFeatured: true }),
    ]);
    return res.send({ reviews, pagination, counts: { totalReviews: allReviews, featuredReviews } });
  } catch {
    return res.status(500).send({ message: 'Failed to load reviews' });
  }
});

// PATCH /api/admin/reviews/:id/featured - Admin Homepage review নির্বাচন করেন।
app.patch('/api/admin/reviews/:id/featured', verifyToken, verifyAdmin, async (req, res) => {
  if (!validId(req.params.id) || typeof req.body?.isFeatured !== 'boolean')
    return res.status(400).send({ message: 'A valid review and homepage selection are required.' });
  try {
    const result = await reviewsCollection.updateOne(
      { _id: toObjectId(req.params.id), status: 'approved' },
      { $set: { isFeatured: req.body.isFeatured } },
    );
    if (!result.matchedCount)
      return res.status(404).send({ message: 'Eligible review not found' });
    return res.send({ message: 'Homepage selection updated', isFeatured: req.body.isFeatured });
  } catch {
    return res.status(500).send({ message: 'Failed to update homepage selection' });
  }
});

// DELETE /api/admin/reviews/:id - Admin যেকোনো Review মুছে ফেলেন।
app.delete('/api/admin/reviews/:id', verifyToken, verifyAdmin, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid review id' });
  try {
    const result = await reviewsCollection.deleteOne({ _id: toObjectId(req.params.id) });
    if (!result.deletedCount) return res.status(404).send({ message: 'Review not found' });
    return res.send({ message: 'Review deleted' });
  } catch {
    return res.status(500).send({ message: 'Failed to delete review' });
  }
});

// GET /api/owner/reviews - Owner শুধু নিজের Equipment-এর Review দেখেন।
app.get('/api/owner/reviews', verifyToken, verifyOwner, async (req, res) => {
  try {
    const ownerId = toObjectId(req.user.id);
    const equipment = await equipmentCollection
      .find({ ownerId }, { projection: { _id: 1 } })
      .toArray();
    const equipmentIds = equipment.flatMap(({ _id }) => [_id, String(_id)]);
    if (!equipmentIds.length) {
      const { pagination } = getPagination(req.query.page, 0, req.query.limit);
      return res.send({ reviews: [], pagination });
    }
    const query = { equipmentId: { $in: equipmentIds } };
    const search = String(req.query.search || '').trim();
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      const searchMatches = [{ customerName: pattern }, { equipmentTitle: pattern }, { comment: pattern }];
      const [users, matchingEquipment] = await Promise.all([
        usersCollection.find({ $or: [{ name: pattern }, { email: pattern }] }, { projection: { _id: 1 } }).toArray(),
        equipmentCollection.find({ _id: { $in: equipmentIds }, title: pattern }, { projection: { _id: 1 } }).toArray(),
      ]);
      const userIds = users.flatMap(({ _id }) => [_id, validId(String(_id)) ? toObjectId(String(_id)) : String(_id)]);
      const matchingEquipmentIds = matchingEquipment.flatMap(({ _id }) => [_id, String(_id)]);
      if (userIds.length) searchMatches.push({ customerId: { $in: userIds } });
      if (matchingEquipmentIds.length) searchMatches.push({ equipmentId: { $in: matchingEquipmentIds } });
      query.$and = [{ $or: searchMatches }];
    }
    const totalRecords = await reviewsCollection.countDocuments(query);
    const { skip, limit, pagination } = getPagination(req.query.page, totalRecords, req.query.limit);
    const rows = await reviewsCollection
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    const reviews = await Promise.all(rows.map((review) => getReviewDetails(review)));
    return res.send({ reviews, pagination });
  } catch {
    return res.status(500).send({ message: 'Failed to load equipment reviews' });
  }
});

// DELETE /api/owner/reviews/:id - Owner-এর Equipment-এর Review মুছে ফেলেন।
app.delete('/api/owner/reviews/:id', verifyToken, verifyOwner, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid review id' });
  try {
    const review = await reviewsCollection.findOne({ _id: toObjectId(req.params.id) });
    if (!review) return res.status(404).send({ message: 'Review not found' });
    const equipmentId = String(review.equipmentId || '');
    const equipment = await equipmentCollection.findOne({
      _id: validId(equipmentId) ? toObjectId(equipmentId) : review.equipmentId,
      ownerId: toObjectId(req.user.id),
    });
    if (!equipment) return res.status(403).send({ message: 'You can only delete reviews for your equipment.' });
    await reviewsCollection.deleteOne({ _id: review._id });
    return res.send({ message: 'Review deleted' });
  } catch {
    return res.status(500).send({ message: 'Failed to delete review' });
  }
});

// GET /api/equipment/:id - একটি অনুমোদিত Equipment-এর বিস্তারিত দেখায়।
app.get('/api/equipment/:id', async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid equipment id' });
    const equipment = await equipmentCollection.findOne({
      _id: toObjectId(req.params.id),
      status: 'approved',
    });
    if (!equipment) return res.status(404).send({ message: 'Equipment not found' });
    res.send({ equipment });
  } catch {
    res.status(500).send({ message: 'Failed to load equipment details' });
  }
});

// GET /api/equipment/:id/availability - নির্ধারিত তারিখে Equipment-এর প্রাপ্যতা দেখায়।
app.get('/api/equipment/:id/availability', verifyToken, verifyRenter, async (req, res) => {
  const start = new Date(String(req.query.startDate || ''));
  const end = new Date(String(req.query.endDate || ''));
  const quantity = Number(req.query.quantity);
  const now = new Date();
  if (
    !validId(req.params.id) ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start < new Date(now.toDateString()) ||
    end <= start ||
    !Number.isInteger(quantity) ||
    quantity < 1
  ) {
    return res.status(400).send({ message: 'Please choose valid rental dates and quantity.' });
  }

  try {
    const equipment = await equipmentCollection.findOne(
      { _id: toObjectId(req.params.id), status: 'approved' },
      { projection: { availableQuantity: 1 } },
    );
    if (!equipment) return res.status(404).send({ message: 'Equipment not found' });
    const remainingQuantity = await getRemainingEquipmentQuantity(
      equipment._id,
      start,
      end,
      equipment.availableQuantity,
    );
    return res.send({
      available: remainingQuantity >= quantity,
      remainingQuantity: Math.max(0, remainingQuantity),
    });
  } catch {
    return res.status(500).send({ message: 'Unable to check date availability' });
  }
});

// GET /api/equipment/:id/monthly-availability - নির্ধারিত মাসে Equipment-এর দৈনিক প্রাপ্যতা দেখায়।
app.get('/api/equipment/:id/monthly-availability', verifyToken, verifyRenter, async (req, res) => {
  const month = String(req.query.month || '');
  if (!validId(req.params.id) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    return res.status(400).send({ message: 'A valid equipment id and month are required.' });

  try {
    const [year, monthNumber] = month.split('-').map(Number);
    const monthStart = new Date(Date.UTC(year, monthNumber - 1, 1));
    const monthEnd = new Date(Date.UTC(year, monthNumber, 1));
    const equipment = await equipmentCollection.findOne(
      { _id: toObjectId(req.params.id), status: 'approved' },
      { projection: { availableQuantity: 1 } },
    );
    if (!equipment) return res.status(404).send({ message: 'Equipment not found' });

    const overlappingBookings = await getOverlappingEquipmentBookings(
      equipment._id,
      monthStart,
      monthEnd,
      { quantity: 1, startDate: 1, endDate: 1 },
    );
    const totalQuantity = Number(equipment.availableQuantity) || 0;
    const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const days = [];

    for (let day = 1; day <= dayCount; day++) {
      const dayStart = new Date(Date.UTC(year, monthNumber - 1, day));
      const dayEnd = new Date(Date.UTC(year, monthNumber - 1, day + 1));
      const bookedQuantity = overlappingBookings.reduce((total, booking) => {
        return booking.startDate < dayEnd && booking.endDate > dayStart
          ? total + Number(booking.quantity || 0)
          : total;
      }, 0);
      const date = dayStart.toISOString().slice(0, 10);
      days.push({
        date,
        bookedQuantity,
        availableQuantity: Math.max(0, totalQuantity - bookedQuantity),
      });
    }

    return res.send({ month, totalQuantity, days });
  } catch {
    return res.status(500).send({ message: 'Unable to load monthly availability' });
  }
});

// Profile API: পরিচয় JWT থেকে নেওয়া হয়।
// GET /api/profile - লগইন করা ব্যবহারকারীর Profile দেখায়।
app.get('/api/profile', verifyToken, async (req, res) => {
  try {
    const user = await usersCollection.findOne(
      { _id: req.user.id },
      { projection: { password: 0 } },
    );
    if (!user) return res.status(404).send({ message: 'User not found' });
    const { _id, ...profile } = user;
    res.send({ user: { ...profile, id: _id } });
  } catch {
    res.status(500).send({ message: 'Failed to load profile' });
  }
});

// PATCH /api/profile - লগইন করা ব্যবহারকারীর Profile হালনাগাদ করে।
app.patch('/api/profile', verifyToken, async (req, res) => {
  try {
    const { name, image, phone, address } = req.body || {};
    const update = {};
    if (typeof name === 'string') update.name = name.trim();
    if (typeof image === 'string') update.image = image.trim();
    if (typeof phone === 'string') update.phone = phone.trim();
    if (typeof address === 'string') update.address = address.trim();
    if (!Object.keys(update).length) {
      return res.status(400).send({
        message: 'Provide at least one editable profile field: name, image, phone, or address',
      });
    }

    const result = await usersCollection.updateOne(
      { _id: req.user.id },
      { $set: { ...update, updatedAt: new Date() } },
    );
    if (!result.matchedCount) return res.status(404).send({ message: 'User not found' });

    const user = await usersCollection.findOne(
      { _id: req.user.id },
      { projection: { password: 0 } },
    );
    const { _id, ...profile } = user;
    res.send({ message: 'Profile updated', user: { ...profile, id: _id } });
  } catch (error) {
    console.error('Failed to update profile', error);
    res.status(500).send({ message: 'Failed to update profile' });
  }
});

// Owner Equipment API।
// POST /api/owner/equipment - নতুন Equipment অনুমোদনের জন্য জমা দেয়।
app.post('/api/owner/equipment', verifyToken, verifyOwner, async (req, res) => {
  try {
    const parsed = parseEquipmentUpdate(req.body);
    if (parsed.error) return res.status(400).send({ message: parsed.error });
    const required = [
      'title',
      'description',
      'category',
      'location',
      'price',
      'rentalType',
      'availableQuantity',
      'image',
    ];
    if (required.some((field) => parsed.update[field] === undefined)) {
      return res.status(400).send({ message: 'Please provide all required equipment fields' });
    }
    const doc = {
      ...parsed.update,
      ownerId: toObjectId(req.user.id),
      ownerName: req.user.name || '',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await equipmentCollection.insertOne(doc);
    res
      .status(201)
      .send({ message: 'Equipment submitted for approval', insertedId: result.insertedId });
  } catch {
    res.status(500).send({ message: 'Failed to add equipment' });
  }
});

// GET /api/owner/equipment - Owner-এর সব Equipment দেখায়।
app.get('/api/owner/equipment', verifyToken, verifyOwner, async (req, res) => {
  try {
    const query = ownedEquipmentFilter(req.user.id);
    const totalRecords = await equipmentCollection.countDocuments(query);
    const { skip, limit, pagination } = getPagination(req.query.page, totalRecords, req.query.limit);
    const equipment = await equipmentCollection
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    res.send({ equipment, pagination });
  } catch {
    res.status(500).send({ message: 'Failed to load your equipment' });
  }
});

// GET /api/owner/equipment/:id - Owner-এর একটি Equipment দেখায়।
app.get('/api/owner/equipment/:id', verifyToken, verifyOwner, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid equipment id' });
    const equipment = await equipmentCollection.findOne(
      ownedEquipmentFilter(req.user.id, req.params.id),
    );
    if (!equipment) return res.status(404).send({ message: 'Equipment not found' });
    res.send({ equipment });
  } catch {
    res.status(500).send({ message: 'Failed to load equipment' });
  }
});

// PATCH /api/owner/equipment/:id - Owner-এর Equipment বদলে পুনরায় review-তে পাঠায়।
app.patch('/api/owner/equipment/:id', verifyToken, verifyOwner, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid equipment id' });
    const parsed = parseEquipmentUpdate(req.body);
    if (parsed.error) return res.status(400).send({ message: parsed.error });
    const result = await equipmentCollection.updateOne(
      ownedEquipmentFilter(req.user.id, req.params.id),
      { $set: { ...parsed.update, status: 'pending', updatedAt: new Date() } },
    );
    if (!result.matchedCount) return res.status(404).send({ message: 'Equipment not found' });
    res.send({ message: 'Equipment updated and sent for review' });
  } catch {
    res.status(500).send({ message: 'Failed to update equipment' });
  }
});

// DELETE /api/owner/equipment/:id - Owner-এর Equipment মুছে দেয়।
app.delete('/api/owner/equipment/:id', verifyToken, verifyOwner, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid equipment id' });
    const result = await equipmentCollection.deleteOne(
      ownedEquipmentFilter(req.user.id, req.params.id),
    );
    if (!result.deletedCount) return res.status(404).send({ message: 'Equipment not found' });
    res.send({ message: 'Equipment deleted' });
  } catch {
    res.status(500).send({ message: 'Failed to delete equipment' });
  }
});

// Favorites API: ব্যবহারকারীর পছন্দের Equipment পরিচালনা করে।
// GET /api/favorites - পছন্দের Equipment তালিকা দেখায়।
app.get('/api/favorites', verifyToken, verifyRenter, async (req, res) => {
  try {
    const query = { userId: toObjectId(req.user.id) };
    const countResult = await favoritesCollection.aggregate([
      { $match: query },
      { $lookup: { from: 'equipment', localField: 'equipmentId', foreignField: '_id', as: 'equipment' } },
      { $unwind: '$equipment' },
      { $count: 'total' },
    ]).toArray();
    const totalRecords = countResult[0]?.total || 0;
    const { skip, limit, pagination } = getPagination(req.query.page, totalRecords, req.query.limit);
    const favorites = await favoritesCollection
      .aggregate([
        { $match: query },
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: 'equipment',
            localField: 'equipmentId',
            foreignField: '_id',
            as: 'equipment',
          },
        },
        { $unwind: '$equipment' },
      ])
      .toArray();
    res.send({ favorites, pagination });
  } catch {
    res.status(500).send({ message: 'Failed to load favorites' });
  }
});
// POST /api/favorites/:equipmentId - Equipment-টি Favorites-এ যোগ করে।
app.post('/api/favorites/:equipmentId', verifyToken, verifyRenter, async (req, res) => {
  try {
    if (!validId(req.params.equipmentId))
      return res.status(400).send({ message: 'Invalid equipment id' });
    const equipment = await equipmentCollection.findOne({
      _id: toObjectId(req.params.equipmentId),
      status: 'approved',
    });
    if (!equipment) return res.status(404).send({ message: 'Equipment not found' });
    await favoritesCollection.updateOne(
      { userId: toObjectId(req.user.id), equipmentId: equipment._id },
      {
        $setOnInsert: {
          userId: toObjectId(req.user.id),
          equipmentId: equipment._id,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    res.status(201).send({ message: 'Added to favorites' });
  } catch {
    res.status(500).send({ message: 'Failed to add favorite' });
  }
});
// DELETE /api/favorites/:equipmentId - Equipment-টি Favorites থেকে সরায়।
app.delete('/api/favorites/:equipmentId', verifyToken, verifyRenter, async (req, res) => {
  try {
    if (!validId(req.params.equipmentId))
      return res.status(400).send({ message: 'Invalid equipment id' });
    await favoritesCollection.deleteOne({
      userId: toObjectId(req.user.id),
      equipmentId: toObjectId(req.params.equipmentId),
    });
    res.send({ message: 'Favorite removed' });
  } catch {
    res.status(500).send({ message: 'Failed to remove favorite' });
  }
});

// Booking API: তারিখ, মজুত ও সার্ভারে ভাড়া যাচাই করে।
// POST /api/bookings - নতুন Booking তৈরি করে।
async function getOverlappingEquipmentBookings(equipmentId, start, end, projection = { quantity: 1 }) {
  return bookingsCollection
    .find(
      {
        equipmentId,
        bookingStatus: { $nin: ['cancelled', 'rejected'] },
        startDate: { $lt: end },
        endDate: { $gt: start },
      },
      { projection },
    )
    .toArray();
}

// নির্ধারিত তারিখে Equipment-এর প্রাপ্যতা যাচাই করে।
async function getRemainingEquipmentQuantity(equipmentId, start, end, availableQuantity) {
  const overlappingBookings = await getOverlappingEquipmentBookings(equipmentId, start, end);
  const reservedQuantity = overlappingBookings.reduce(
    (total, booking) => total + Number(booking.quantity || 0),
    0,
  );
  return Number(availableQuantity || 0) - reservedQuantity;
}

// POST /api/bookings - নতুন Booking তৈরি করে।
app.post('/api/bookings', verifyToken, verifyRenter, async (req, res) => {
  const { equipmentId, startDate, endDate, quantity, contactNumber, deliveryAddress, notes } =
    req.body;
  if (!validId(equipmentId) || !startDate || !endDate || !contactNumber || !deliveryAddress) {
    return res.status(400).send({ message: 'Missing booking information' });
  }
  const start = new Date(startDate),
    end = new Date(endDate),
    now = new Date();
  const requestedQuantity = Number(quantity);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start < new Date(now.toDateString()) ||
    end <= start ||
    !Number.isInteger(requestedQuantity) ||
    requestedQuantity < 1
  ) {
    return res.status(400).send({ message: 'Invalid rental dates or quantity' });
  }
  try {
    const equipment = await equipmentCollection.findOne({
      _id: toObjectId(equipmentId),
      status: 'approved',
    });
    if (!equipment) return res.status(404).send({ message: 'Equipment not found' });
    // Availability check এবং final booking validation একই overlap ও quantity logic ব্যবহার করে।
    const remainingQuantity = await getRemainingEquipmentQuantity(
      equipment._id,
      start,
      end,
      equipment.availableQuantity,
    );
    if (remainingQuantity < requestedQuantity)
      return res.status(409).send({
        message: `Only ${Math.max(0, remainingQuantity)} item(s) are available for these dates`,
      });
    const duration = Math.ceil((end - start) / 86400000);
    const multiplier =
      equipment.rentalType === 'Weekly'
        ? Math.ceil(duration / 7)
        : equipment.rentalType === 'Monthly'
          ? Math.ceil(duration / 30)
          : duration;
    const totalAmount = Number(equipment.price) * multiplier * requestedQuantity;
    const booking = {
      equipmentId: equipment._id,
      equipmentTitle: equipment.title,
      ownerId: equipment.ownerId,
      customerId: toObjectId(req.user.id),
      customerName: req.user.name || '',
      startDate: start,
      endDate: end,
      bookingDate: new Date(),
      duration,
      quantity: requestedQuantity,
      contactNumber,
      deliveryAddress,
      notes: notes || '',
      totalAmount,
      paymentStatus: 'pending',
      bookingStatus: 'pending_payment',
      createdAt: new Date(),
    };
    const result = await bookingsCollection.insertOne(booking);
    res.status(201).send({ message: 'Booking created', bookingId: result.insertedId, totalAmount });
  } catch {
    res.status(500).send({ message: 'Failed to create booking' });
  }
});

// GET /api/bookings/my - লগইন করা Customer-এর Booking ও Review অবস্থা দেখায়।
app.get('/api/bookings/my', verifyToken, verifyRenter, async (req, res) => {
  try {
    const query = customerBookingFilter(req.user.id);
    const totalRecords = await bookingsCollection.countDocuments(query);
    const { skip, limit, pagination } = getPagination(req.query.page, totalRecords, req.query.limit);
    const bookings = await bookingsCollection
      .aggregate([
        { $match: query },
        { $sort: { bookingDate: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: 'equipment',
            localField: 'equipmentId',
            foreignField: '_id',
            as: 'equipment',
          },
        },
        { $unwind: { path: '$equipment', preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            equipmentTitle: { $ifNull: ['$equipment.title', '$equipmentTitle'] },
            equipmentImage: '$equipment.image',
          },
        },
        { $project: { equipment: 0 } },
      ])
      .toArray();
    const reviewedBookingIds = bookings.length
      ? new Set(
          (await reviewsCollection
            .find(
              {
                customerId: toObjectId(req.user.id),
                bookingId: { $in: bookings.map((booking) => booking._id) },
              },
              { projection: { bookingId: 1 } },
            )
            .toArray()).map((review) => String(review.bookingId)),
        )
      : new Set();
    res.send({ bookings: bookings.map((booking) => ({ ...booking, reviewed: reviewedBookingIds.has(String(booking._id)) })), pagination });
  } catch {
    res.status(500).send({ message: 'Failed to load bookings' });
  }
});
// Customer Analytics API।
// GET /api/customer/analytics - Customer-এর Booking ও খরচের সারাংশ দেখায়।
app.get('/api/customer/analytics', verifyToken, verifyRenter, async (req, res) => {
  try {
    const customerId = toObjectId(req.user.id);
    const bookingQuery = customerBookingFilter(req.user.id);
    const totalBookings = await bookingsCollection.countDocuments(bookingQuery);
    const { skip: recentSkip, limit: recentLimit, pagination: recentBookingsPagination } = getPagination(req.query.page, totalBookings, req.query.limit);
    const [
      activeRentals,
      completedRentals,
      pendingBookings,
      spending,
      monthlyRentals,
      recentBookings,
    ] = await Promise.all([
      bookingsCollection.countDocuments({
        ...customerBookingFilter(req.user.id),
        bookingStatus: { $in: ['confirmed', 'active', 'ongoing'] },
      }),
      bookingsCollection.countDocuments({
        ...customerBookingFilter(req.user.id),
        bookingStatus: 'completed',
      }),
      bookingsCollection.countDocuments({
        ...customerBookingFilter(req.user.id),
        bookingStatus: { $in: ['pending', 'pending_payment', 'pending_approval'] },
      }),
      paymentsCollection
        .aggregate([
          { $match: { customerId, status: 'paid' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ])
        .toArray(),
      bookingsCollection
        .aggregate([
          { $match: bookingQuery },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m', date: '$bookingDate' } },
              total: { $sum: 1 },
            },
          },
          { $sort: { _id: -1 } },
          { $limit: 12 },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      bookingsCollection
        .aggregate([
          { $match: bookingQuery },
          { $sort: { bookingDate: -1, _id: -1 } },
          { $skip: recentSkip },
          { $limit: recentLimit },
          {
            $lookup: {
              from: 'equipment',
              localField: 'equipmentId',
              foreignField: '_id',
              as: 'equipment',
            },
          },
          { $unwind: { path: '$equipment', preserveNullAndEmptyArrays: true } },
          {
            $addFields: {
              equipmentTitle: { $ifNull: ['$equipment.title', '$equipmentTitle'] },
              equipmentImage: '$equipment.image',
            },
          },
          { $project: { equipment: 0 } },
        ])
        .toArray(),
    ]);
    res.send({
      totalBookings,
      activeRentals,
      completedRentals,
      pendingBookings,
      totalSpending: spending[0]?.total || 0,
      monthlyRentals,
      recentBookings,
      recentBookingsPagination,
    });
  } catch {
    res.status(500).send({ message: 'Failed to calculate customer overview' });
  }
});

// GET /api/owner/bookings - Owner-এর Booking তালিকা দেখায়।
app.get('/api/owner/bookings', verifyToken, verifyOwner, async (req, res) => {
  try {
    const query = ownerBookingFilter(req.user.id);
    const totalRecords = await bookingsCollection.countDocuments(query);
    const { skip, limit, pagination } = getPagination(req.query.page, totalRecords, req.query.limit);
    const bookings = await bookingsCollection
      .aggregate([
        { $match: query },
        { $sort: { bookingDate: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: 'equipment',
            localField: 'equipmentId',
            foreignField: '_id',
            as: 'equipment',
          },
        },
        { $unwind: { path: '$equipment', preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            equipmentTitle: { $ifNull: ['$equipment.title', '$equipmentTitle'] },
            equipmentImage: '$equipment.image',
          },
        },
        { $project: { equipment: 0 } },
      ])
      .toArray();
    res.send({ bookings, pagination });
  } catch {
    res.status(500).send({ message: 'Failed to load owner rentals' });
  }
});

// Stripe Checkout API: অর্থের পরিমাণ সার্ভারের Booking থেকে নেওয়া হয়।
// POST /api/payments/checkout/:bookingId - Booking-এর জন্য Checkout শুরু করে।
app.post('/api/payments/checkout/:bookingId', verifyToken, verifyRenter, (req, res) =>
  startCheckoutSession(req, res, {
    stripe,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
    bookingsCollection,
    paymentsCollection,
  }),
);

// Admin User ও Equipment পরিচালনা API।
// GET /api/admin/users - সব User-এর তালিকা দেখায়।
app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const totalRecords = await usersCollection.countDocuments({});
    const { skip, limit, pagination } = getPagination(req.query.page, totalRecords, req.query.limit);
    const users = await usersCollection
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    res.send({ users, pagination });
  } catch {
    res.status(500).send({ message: 'Failed to load users' });
  }
});
// PATCH /api/admin/users/:id/role - User-এর Role বদলায়।
app.patch('/api/admin/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid user id' });
    if (!['customer', 'owner', 'admin'].includes(req.body.role))
      return res.status(400).send({ message: 'Invalid role' });
    if (String(req.user.id) === req.params.id && req.body.role !== 'admin')
      return res.status(400).send({ message: 'You cannot remove your own admin role' });
    const result = await usersCollection.updateOne(
      { _id: req.params.id },
      { $set: { role: req.body.role, updatedAt: new Date() } },
    );
    if (!result.matchedCount) return res.status(404).send({ message: 'User not found' });
    res.send({ message: 'User role updated' });
  } catch {
    res.status(500).send({ message: 'Failed to update user role' });
  }
});
// GET /api/admin/equipment - Owner-এর নামসহ সব Equipment দেখায়।
app.get('/api/admin/equipment', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const totalRecords = await equipmentCollection.countDocuments({});
    const { skip, limit, pagination } = getPagination(req.query.page, totalRecords, req.query.limit);
    const equipment = await equipmentCollection.aggregate([
      ...adminEquipmentPipeline(),
      { $skip: skip },
      { $limit: limit },
    ]).toArray();
    res.send({ equipment, pagination });
  } catch {
    res.status(500).send({ message: 'Failed to load equipment' });
  }
});
// PATCH /api/admin/equipment/:id/status - Equipment-এর অনুমোদন অবস্থা বদলায়।
app.patch('/api/admin/equipment/:id/status', verifyToken, verifyAdmin, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid equipment id' });
    if (!['approved', 'rejected', 'pending'].includes(req.body.status))
      return res.status(400).send({ message: 'Invalid status' });
    const result = await equipmentCollection.updateOne(
      { _id: toObjectId(req.params.id) },
      { $set: { status: req.body.status, updatedAt: new Date() } },
    );
    if (!result.matchedCount) return res.status(404).send({ message: 'Equipment not found' });
    res.send({ message: 'Equipment status updated' });
  } catch {
    res.status(500).send({ message: 'Failed to update equipment status' });
  }
});
// PATCH /api/admin/equipment/:id - Admin-এর মাধ্যমে Equipment তথ্য বদলায়।
app.patch('/api/admin/equipment/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid equipment id' });
    const parsed = parseEquipmentUpdate(req.body);
    if (parsed.error) return res.status(400).send({ message: parsed.error });
    const result = await equipmentCollection.updateOne(
      { _id: toObjectId(req.params.id) },
      { $set: { ...parsed.update, updatedAt: new Date() } },
    );
    if (!result.matchedCount) return res.status(404).send({ message: 'Equipment not found' });
    res.send({ message: 'Equipment updated' });
  } catch {
    res.status(500).send({ message: 'Failed to update equipment' });
  }
});

// DELETE /api/admin/equipment/:id - Equipment মুছে দেয়।
app.delete('/api/admin/equipment/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid equipment id' });
    const result = await equipmentCollection.deleteOne({ _id: toObjectId(req.params.id) });
    if (!result.deletedCount) return res.status(404).send({ message: 'Equipment not found' });
    res.send({ message: 'Equipment deleted' });
  } catch {
    res.status(500).send({ message: 'Failed to delete equipment' });
  }
});
// Admin Booking ও Analytics API।
// GET /api/admin/bookings - Customer ও Owner তথ্যসহ সব Booking দেখায়।
app.get('/api/admin/bookings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const totalRecords = await bookingsCollection.countDocuments({});
    const { skip, limit, pagination } = getPagination(req.query.page, totalRecords, req.query.limit);
    const bookings = await bookingsCollection
      .aggregate([
        { $sort: { bookingDate: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: { from: 'user', localField: 'customerId', foreignField: '_id', as: 'customer' },
        },
        { $lookup: { from: 'user', localField: 'ownerId', foreignField: '_id', as: 'owner' } },
        {
          $lookup: {
            from: 'equipment',
            localField: 'equipmentId',
            foreignField: '_id',
            as: 'equipment',
          },
        },
        { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
        { $unwind: { path: '$owner', preserveNullAndEmptyArrays: true } },
        { $unwind: { path: '$equipment', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            equipmentId: 1,
            equipmentTitle: { $ifNull: ['$equipment.title', '$equipmentTitle'] },
            equipmentImage: '$equipment.image',
            startDate: 1,
            endDate: 1,
            bookingDate: 1,
            quantity: 1,
            totalAmount: 1,
            paymentStatus: 1,
            transactionId: 1,
            bookingStatus: 1,
            customerName: { $ifNull: ['$customer.name', '$customerName'] },
            customerEmail: '$customer.email',
            ownerName: { $ifNull: ['$owner.name', ''] },
            ownerEmail: '$owner.email',
          },
        },
      ])
      .toArray();
    res.send({ bookings, pagination });
  } catch {
    res.status(500).send({ message: 'Failed to load bookings' });
  }
});

// MongoDB aggregation দিয়ে Admin-এর সামগ্রিক Analytics তৈরি করে।
// GET /api/admin/analytics - User, Booking ও আয়ের সারাংশ দেখায়।
app.get('/api/admin/analytics', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [
      totalUsers,
      totalEquipment,
      totalBookings,
      pendingApprovals,
      completedRentals,
      revenue,
      monthlyBookings,
      monthlyRevenue,
      totalReviews,
      homepageReviews,
    ] = await Promise.all([
      usersCollection.countDocuments({}),
      equipmentCollection.countDocuments({}),
      bookingsCollection.countDocuments({}),
      equipmentCollection.countDocuments({ status: 'pending' }),
      bookingsCollection.countDocuments({ bookingStatus: 'completed' }),
      paymentsCollection
        .aggregate([
          { $match: { status: 'paid' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ])
        .toArray(),
      bookingsCollection
        .aggregate([
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m', date: '$bookingDate' } },
              total: { $sum: 1 },
            },
          },
          { $sort: { _id: -1 } },
          { $limit: 12 },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      paymentsCollection
        .aggregate([
          { $match: { status: 'paid' } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
              total: { $sum: '$amount' },
            },
          },
          { $sort: { _id: -1 } },
          { $limit: 12 },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      reviewsCollection.countDocuments({}),
      reviewsCollection.countDocuments({ status: 'approved', isFeatured: true }),
    ]);
    res.send({
      totalUsers,
      totalEquipment,
      totalBookings,
      pendingApprovals,
      completedRentals,
      totalRevenue: revenue[0]?.total || 0,
      monthlyBookings,
      monthlyRevenue,
      totalReviews,
      homepageReviews,
    });
  } catch {
    res.status(500).send({ message: 'Failed to calculate analytics' });
  }
});
// GET /api/owner/analytics - Owner-এর Equipment, Booking ও আয়ের সারাংশ দেখায়।
app.get('/api/owner/analytics', verifyToken, verifyOwner, async (req, res) => {
  try {
    const ownerId = toObjectId(req.user.id);
    const ownedEquipment = await equipmentCollection
      .find({ ownerId }, { projection: { _id: 1 } })
      .toArray();
    const equipmentIds = ownedEquipment.flatMap(({ _id }) => [_id, String(_id)]);
    const [
      totalEquipment,
      approvedEquipment,
      pendingEquipment,
      totalBookings,
      activeRentals,
      completedRentals,
      earnings,
      monthlyEarnings,
      myEquipmentReviews,
    ] = await Promise.all([
      equipmentCollection.countDocuments({ ownerId }),
      equipmentCollection.countDocuments({ ownerId, status: 'approved' }),
      equipmentCollection.countDocuments({ ownerId, status: 'pending' }),
      bookingsCollection.countDocuments(ownerBookingFilter(req.user.id)),
      bookingsCollection.countDocuments({
        ...ownerBookingFilter(req.user.id),
        bookingStatus: { $in: ['confirmed', 'active', 'ongoing'] },
      }),
      bookingsCollection.countDocuments({
        ...ownerBookingFilter(req.user.id),
        bookingStatus: 'completed',
      }),
      paymentsCollection
        .aggregate([
          { $match: { ownerId, status: 'paid' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ])
        .toArray(),
      paymentsCollection
        .aggregate([
          { $match: { ownerId, status: 'paid' } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
              total: { $sum: '$amount' },
            },
          },
          { $sort: { _id: -1 } },
          { $limit: 12 },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      reviewsCollection.countDocuments({ equipmentId: { $in: equipmentIds } }),
    ]);
    res.send({
      totalEquipment,
      approvedEquipment,
      pendingEquipment,
      totalBookings,
      activeRentals,
      completedRentals,
      totalEarnings: earnings[0]?.total || 0,
      monthlyEarnings,
      myEquipmentReviews,
    });
  } catch {
    res.status(500).send({ message: 'Failed to calculate owner analytics' });
  }
});

// অচেনা endpoint-এর জন্য 404 response পাঠায়।
app.use((req, res) => res.status(404).send({ message: 'Route not found' }));
// ত্রুটি log করে সাধারণ 500 response পাঠায়।
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).send({ message: 'Internal server error' });
});

// Database-এ সংযোগ করে server ও স্থানীয় Cron schedule চালু করে।
async function startServer() {
  try {
    await initializeDatabase();
    if (process.env.VERCEL !== '1') {
      cron.schedule(
        '0 * * * *',
        async () => {
          try {
            await completeExpiredBookings();
          } catch {
            console.error('Automated booking status update failed.');
          }
        },
        { timezone: 'UTC' },
      );
      console.log('Local hourly booking status schedule enabled (UTC).');
    }
    app.listen(port, () => console.log(`Gearly API listening on port ${port}`));
  } catch {
    console.error('Failed to initialize the backend database.');
    process.exit(1);
  }
}
if (
  process.env.VERCEL !== '1' &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  startServer();
}

export { app };
export default app;
