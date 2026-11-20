import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';

// Authorization, data scope, and validation helpers. Kept here with the API.

export function isRoleAllowed(role, allowedRoles) {
  return allowedRoles.includes(role);
}

export function ownedEquipmentFilter(ownerId, equipmentId) {
  return {
    ...(equipmentId ? { _id: new ObjectId(equipmentId) } : {}),
    ownerId: new ObjectId(ownerId),
  };
}

export function customerBookingFilter(customerId) {
  return { customerId: new ObjectId(customerId) };
}

export function ownerBookingFilter(ownerId) {
  return { ownerId: new ObjectId(ownerId) };
}

export function adminEquipmentPipeline() {
  return [
    { $sort: { createdAt: -1 } },
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

export function canRetryBookingPayment(booking) {
  return Boolean(
    booking &&
    ['pending', 'failed', 'cancelled'].includes(booking.paymentStatus) &&
    ['pending', 'pending_payment', 'payment_failed'].includes(booking.bookingStatus),
  );
}

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

const isObjectId = (value) =>
  typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) && ObjectId.isValid(value);

const paymentIntentId = (paymentIntent) =>
  typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id || null;

export function isTestStripeSecretKey(secretKey) {
  return typeof secretKey === 'string' && /^(sk|rk)_test_/.test(secretKey);
}

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
  const booking = await bookingsCollection.findOne(bookingFilter);
  if (!booking)
    return res.status(404).send({ message: 'Booking for this Checkout Session was not found' });

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

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }));

let usersCollection,
  equipmentCollection,
  bookingsCollection,
  favoritesCollection,
  paymentsCollection,
  reviewsCollection;

let databaseInitialization;
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
        equipmentCollection.createIndex({ status: 1, category: 1, createdAt: -1 }),
        paymentsCollection.createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true }),
        paymentsCollection.createIndex({ transactionId: 1 }, { unique: true, sparse: true }),
        reviewsCollection.createIndex(
          { bookingId: 1 },
          { unique: true, partialFilterExpression: { bookingId: { $exists: true } } },
        ),
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

function myLogger(req, res, next) {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
}
app.use(myLogger);

app.use(express.json({ limit: '2mb' }));

if (process.env.VERCEL === '1') {
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

const verifyRenter = (req, res, next) => {
  if (!isRoleAllowed(req.user?.role, ['customer', 'renter']))
    return res.status(403).send({ message: 'Renter access required' });
  next();
};
const verifyCustomer = (req, res, next) => {
  if (!isRoleAllowed(req.user?.role, ['customer']))
    return res.status(403).send({ message: 'Customer access required' });
  next();
};
const verifyOwner = (req, res, next) => {
  if (!isRoleAllowed(req.user?.role, ['owner']))
    return res.status(403).send({ message: 'Owner access required' });
  next();
};
const verifyAdmin = (req, res, next) => {
  if (!isRoleAllowed(req.user?.role, ['admin']))
    return res.status(403).send({ message: 'Admin access required' });
  next();
};

const validId = (id) => ObjectId.isValid(id);
const toObjectId = (id) => new ObjectId(id);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

app.post('/api/payments/verify-session', verifyToken, verifyRenter, (req, res) =>
  verifyCheckoutSession(req, res, {
    stripe,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    bookingsCollection,
    paymentsCollection,
  }),
);

app.get('/', (req, res) => res.send({ message: 'Gearly API is running' }));
app.get('/api/health', (req, res) => res.send({ status: 'ok' }));

// Public equipment list with server-side search, filtering, sorting and pagination.
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

// Public reviews only include submissions linked to a booking.
app.get('/api/reviews', async (req, res) => {
  try {
    const reviews = await reviewsCollection
      .find(
        { status: 'approved', bookingId: { $type: 'objectId' } },
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
    const customer = await usersCollection.findOne(
      { _id: customerId },
      { projection: { name: 1, image: 1, role: 1 } },
    );
    if (!customer || customer.role !== 'customer')
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

// Profile is based on the verified token identity, never on a client-supplied user id.
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

// Owner equipment management.
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

app.get('/api/owner/equipment', verifyToken, verifyOwner, async (req, res) => {
  try {
    const equipment = await equipmentCollection
      .find(ownedEquipmentFilter(req.user.id))
      .sort({ createdAt: -1 })
      .toArray();
    res.send({ equipment });
  } catch {
    res.status(500).send({ message: 'Failed to load your equipment' });
  }
});

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

// Favorites.
app.get('/api/favorites', verifyToken, verifyRenter, async (req, res) => {
  try {
    const favorites = await favoritesCollection
      .aggregate([
        { $match: { userId: toObjectId(req.user.id) } },
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
    res.send({ favorites });
  } catch {
    res.status(500).send({ message: 'Failed to load favorites' });
  }
});
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

// Booking creation checks dates, quantities and calculates the amount on the server.
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
    const overlappingBookings = await bookingsCollection
      .find(
        {
          equipmentId: equipment._id,
          bookingStatus: { $nin: ['cancelled', 'rejected'] },
          startDate: { $lt: end },
          endDate: { $gt: start },
        },
        { projection: { quantity: 1 } },
      )
      .toArray();
    const reservedQuantity = overlappingBookings.reduce(
      (total, booking) => total + Number(booking.quantity || 0),
      0,
    );
    const remainingQuantity = Number(equipment.availableQuantity || 0) - reservedQuantity;
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

app.get('/api/bookings/my', verifyToken, verifyRenter, async (req, res) => {
  try {
    const bookings = await bookingsCollection
      .aggregate([
        { $match: customerBookingFilter(req.user.id) },
        { $sort: { bookingDate: -1 } },
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
    res.send({ bookings: bookings.map((booking) => ({ ...booking, reviewed: reviewedBookingIds.has(String(booking._id)) })) });
  } catch {
    res.status(500).send({ message: 'Failed to load bookings' });
  }
});
app.get('/api/customer/analytics', verifyToken, verifyRenter, async (req, res) => {
  try {
    const customerId = toObjectId(req.user.id);
    const [
      totalBookings,
      activeRentals,
      completedRentals,
      pendingBookings,
      spending,
      monthlyRentals,
      recentBookings,
    ] = await Promise.all([
      bookingsCollection.countDocuments(customerBookingFilter(req.user.id)),
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
          { $match: customerBookingFilter(req.user.id) },
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
          { $match: customerBookingFilter(req.user.id) },
          { $sort: { bookingDate: -1 } },
          { $limit: 5 },
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
    });
  } catch {
    res.status(500).send({ message: 'Failed to calculate customer overview' });
  }
});

app.get('/api/owner/bookings', verifyToken, verifyOwner, async (req, res) => {
  try {
    const bookings = await bookingsCollection
      .aggregate([
        { $match: ownerBookingFilter(req.user.id) },
        { $sort: { bookingDate: -1 } },
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
    res.send({ bookings });
  } catch {
    res.status(500).send({ message: 'Failed to load owner rentals' });
  }
});

// Stripe Checkout: only server-side booking amount is used.
app.post('/api/payments/checkout/:bookingId', verifyToken, verifyRenter, (req, res) =>
  startCheckoutSession(req, res, {
    stripe,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
    bookingsCollection,
    paymentsCollection,
  }),
);

// Admin management.
app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await usersCollection
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    res.send({ users });
  } catch {
    res.status(500).send({ message: 'Failed to load users' });
  }
});
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
app.get('/api/admin/equipment', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const equipment = await equipmentCollection.aggregate(adminEquipmentPipeline()).toArray();
    res.send({ equipment });
  } catch {
    res.status(500).send({ message: 'Failed to load equipment' });
  }
});
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
app.get('/api/admin/bookings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const bookings = await bookingsCollection
      .aggregate([
        { $sort: { bookingDate: -1 } },
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
    res.send({ bookings });
  } catch {
    res.status(500).send({ message: 'Failed to load bookings' });
  }
});

// Dynamic analytics using MongoDB aggregation.
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
    });
  } catch {
    res.status(500).send({ message: 'Failed to calculate analytics' });
  }
});
app.get('/api/owner/analytics', verifyToken, verifyOwner, async (req, res) => {
  try {
    const ownerId = toObjectId(req.user.id);
    const [
      totalEquipment,
      approvedEquipment,
      pendingEquipment,
      totalBookings,
      activeRentals,
      completedRentals,
      earnings,
      monthlyEarnings,
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
    });
  } catch {
    res.status(500).send({ message: 'Failed to calculate owner analytics' });
  }
});

app.use((req, res) => res.status(404).send({ message: 'Route not found' }));
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).send({ message: 'Internal server error' });
});

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
