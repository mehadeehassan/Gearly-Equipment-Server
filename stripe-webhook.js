import { ObjectId } from "mongodb";

const validObjectId = (value) => typeof value === "string" && /^[a-f\d]{24}$/i.test(value) && ObjectId.isValid(value);
const getPaymentIntentId = (paymentIntent) =>
  typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id || null;

export function createStripeWebhookHandler({ stripe, webhookSecret, bookingsCollection, paymentsCollection, stripeEventsCollection }) {
  return async function handleStripeWebhook(req, res) {
    if (!stripe || !webhookSecret) return res.status(503).send("Stripe webhook is not configured");

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], webhookSecret);
    } catch (error) {
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    if (!event.id || !event.type) return res.status(400).send("Invalid Stripe event");

    try {
      if (await stripeEventsCollection.findOne({ eventId: event.id })) {
        return res.status(200).send({ received: true, duplicate: true });
      }

      const session = event.data?.object;
      if (session?.object === "checkout.session") {
        await syncCheckoutSession(event.type, session, event.id, {
          bookingsCollection,
          paymentsCollection,
        });
      }

      await stripeEventsCollection.updateOne(
        { eventId: event.id },
        { $setOnInsert: { eventId: event.id, type: event.type, processedAt: new Date() } },
        { upsert: true },
      );
      return res.status(200).send({ received: true });
    } catch (error) {
      console.error("Failed to process Stripe webhook", error);
      return res.status(500).send("Failed to process Stripe webhook");
    }
  };
}

async function syncCheckoutSession(eventType, session, eventId, { bookingsCollection, paymentsCollection }) {
  const bookingId = session.metadata?.bookingId;
  const customerId = session.metadata?.customerId;
  if (!validObjectId(bookingId) || !validObjectId(customerId) || !session.id) return;

  const bookingFilter = { _id: new ObjectId(bookingId), customerId: new ObjectId(customerId) };
  const booking = await bookingsCollection.findOne(bookingFilter);
  if (!booking) return;

  // The session link is written before Checkout URL is returned. If the webhook
  // arrives first, return 500 so Stripe retries after the link is saved.
  if (!booking.stripeSessionId) throw new Error("Checkout Session has not been linked to its booking yet");
  if (booking.stripeSessionId !== session.id) return;

  const paymentIntentId = getPaymentIntentId(session.payment_intent);
  const sessionFilter = { ...bookingFilter, stripeSessionId: session.id };

  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(eventType)) {
    // A completed Checkout Session can still be unpaid when a delayed payment
    // method is used. Wait for async_payment_succeeded in that case.
    if (session.payment_status !== "paid") return;
    if (!paymentIntentId) throw new Error("Paid Checkout Session is missing its Payment Intent identifier");

    await bookingsCollection.updateOne(
      { ...sessionFilter, paymentStatus: { $ne: "paid" } },
      {
        $set: {
          paymentStatus: "paid",
          bookingStatus: "confirmed",
          paidAt: new Date(),
          stripePaymentIntentId: paymentIntentId,
          ...(paymentIntentId ? { transactionId: paymentIntentId } : {}),
          stripeEventId: eventId,
        },
      },
    );

    // Always upsert this idempotently, including on webhook retries. This also
    // repairs the payment record if a previous delivery stopped after updating the booking.
    await paymentsCollection.updateOne(
      { stripeSessionId: session.id },
      {
        $set: { status: "paid", paymentIntentId, ...(paymentIntentId ? { transactionId: paymentIntentId } : {}), updatedAt: new Date() },
        $setOnInsert: {
          stripeSessionId: session.id,
          bookingId: booking._id,
          customerId: booking.customerId,
          ownerId: booking.ownerId,
          amount: booking.totalAmount,
          currency: session.currency || "bdt",
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    return;
  }

  if (eventType === "checkout.session.async_payment_failed") {
    await bookingsCollection.updateOne(
      { ...sessionFilter, paymentStatus: { $nin: ["paid", "failed"] } },
      {
        $set: {
          paymentStatus: "failed",
          bookingStatus: "payment_failed",
          failedAt: new Date(),
          stripePaymentIntentId: paymentIntentId,
          stripeEventId: eventId,
        },
      },
    );
    return;
  }

  if (eventType === "checkout.session.expired") {
    await bookingsCollection.updateOne(
      { ...sessionFilter, paymentStatus: { $nin: ["paid", "cancelled"] } },
      {
        $set: {
          paymentStatus: "cancelled",
          bookingStatus: "payment_cancelled",
          stripeEventId: eventId,
        },
      },
    );
  }
}
