import { ObjectId } from "mongodb";

const isObjectId = (value) =>
  typeof value === "string" && /^[a-f\d]{24}$/i.test(value) && ObjectId.isValid(value);

const paymentIntentId = (paymentIntent) =>
  typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id || null;

export function isTestStripeSecretKey(secretKey) {
  return typeof secretKey === "string" && /^(sk|rk)_test_/.test(secretKey);
}

export function createPaymentVerificationHandler({
  stripe,
  stripeSecretKey,
  bookingsCollection,
  paymentsCollection,
}) {
  return async function verifyCheckoutSession(req, res) {
    if (!stripe || !isTestStripeSecretKey(stripeSecretKey)) {
      return res.status(503).send({ message: "Stripe Test Mode is not configured" });
    }

    const { sessionId } = req.body || {};
    const customerId = String(req.user?.id || "");
    if (typeof sessionId !== "string" || !sessionId.startsWith("cs_") || sessionId.length > 128) {
      return res.status(400).send({ message: "A valid Checkout Session ID is required" });
    }
    if (!isObjectId(customerId)) {
      return res.status(401).send({ message: "A valid customer session is required" });
    }

    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
    } catch (error) {
      if (error?.code === "resource_missing" || error?.statusCode === 404) {
        return res.status(404).send({ message: "Checkout Session not found" });
      }
      return res.status(502).send({ message: "Unable to verify the Checkout Session with Stripe" });
    }

    if (!session || session.id !== sessionId || session.object !== "checkout.session") {
      return res.status(404).send({ message: "Checkout Session not found" });
    }
    if (session.livemode !== false || session.mode !== "payment") {
      return res.status(409).send({ message: "Checkout Session is not a Test Mode payment session" });
    }

    const bookingId = session.metadata?.bookingId;
    const sessionCustomerId = session.metadata?.customerId;
    if (
      !isObjectId(bookingId) ||
      sessionCustomerId !== customerId ||
      session.client_reference_id !== bookingId
    ) {
      return res.status(404).send({ message: "Checkout Session does not belong to this customer" });
    }

    const bookingFilter = {
      _id: new ObjectId(bookingId),
      customerId: new ObjectId(customerId),
      stripeSessionId: session.id,
    };
    const booking = await bookingsCollection.findOne(bookingFilter);
    if (!booking) return res.status(404).send({ message: "Booking for this Checkout Session was not found" });

    const expectedAmount = Math.round(Number(booking.totalAmount) * 100);
    const expectedCurrency = String(booking.currency || "bdt").toLowerCase();
    if (
      !Number.isSafeInteger(expectedAmount) ||
      session.amount_total !== expectedAmount ||
      String(session.currency || "").toLowerCase() !== expectedCurrency
    ) {
      return res.status(409).send({ message: "Checkout Session amount or currency does not match the booking" });
    }

    if (session.status === "expired") {
      return markUnpaidStatus(bookingFilter, bookingsCollection, res, "expired", "payment_expired");
    }

    if (session.payment_status !== "paid") {
      if (session.payment_status === "no_payment_required") {
        return res.send({ status: "unpaid", bookingId: String(booking._id) });
      }

      let intent = typeof session.payment_intent === "object" ? session.payment_intent : null;
      if (session.status === "complete" && !intent && session.payment_intent) {
        try {
          intent = await stripe.paymentIntents.retrieve(session.payment_intent);
        } catch {
          return res.status(502).send({ message: "Unable to verify the Checkout payment status" });
        }
      }

      if (
        session.status === "complete" &&
        ["requires_payment_method", "canceled"].includes(intent?.status)
      ) {
        return markUnpaidStatus(bookingFilter, bookingsCollection, res, "failed", "payment_failed");
      }
      return res.send({ status: "pending", bookingId: String(booking._id) });
    }

    const intentId = paymentIntentId(session.payment_intent);
    if (!intentId) {
      return res.status(409).send({ message: "Paid Checkout Session is missing its Payment Intent" });
    }

    const existingPayment = await paymentsCollection.findOne({ stripeSessionId: session.id });
    if (
      existingPayment &&
      (String(existingPayment.bookingId) !== String(booking._id) ||
        String(existingPayment.customerId) !== customerId ||
        existingPayment.paymentIntentId !== intentId)
    ) {
      return res.status(409).send({ message: "Checkout Session is already linked to a different payment" });
    }

    if (booking.paymentStatus !== "paid") {
      await bookingsCollection.updateOne(
        { ...bookingFilter, paymentStatus: { $ne: "paid" } },
        {
          $set: {
            paymentStatus: "paid",
            bookingStatus: "confirmed",
            stripeCheckoutStatus: "complete",
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
      currentBooking.paymentStatus !== "paid" ||
      currentBooking.stripeSessionId !== session.id ||
      (currentBooking.stripePaymentIntentId && currentBooking.stripePaymentIntentId !== intentId)
    ) {
      return res.status(409).send({ message: "Booking changed while payment was being verified" });
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
            status: "paid",
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
        return res.status(409).send({ message: "Checkout Session is already linked to a different payment" });
      }
    }

    return res.send({ status: "paid", bookingId: String(currentBooking._id) });
  };
}

async function markUnpaidStatus(bookingFilter, bookingsCollection, res, paymentStatus, bookingStatus) {
  await bookingsCollection.updateOne(
    { ...bookingFilter, paymentStatus: { $ne: "paid" } },
    { $set: { paymentStatus, bookingStatus, updatedAt: new Date() } },
  );
  const booking = await bookingsCollection.findOne(bookingFilter);
  if (!booking) return res.status(404).send({ message: "Booking for this Checkout Session was not found" });
  if (booking.paymentStatus === "paid") {
    return res.send({ status: "paid", bookingId: String(booking._id) });
  }
  return res.send({ status: paymentStatus, bookingId: String(booking._id) });
}
