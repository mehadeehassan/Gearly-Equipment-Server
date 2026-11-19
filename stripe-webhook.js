import { ObjectId } from "mongodb";

export function createStripeWebhookHandler({ stripe, webhookSecret }) {
  return function handleStripeWebhook(req, res) {
    if (!stripe || !webhookSecret) return res.status(503).send("Stripe webhook is not configured");
    try {
      const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], webhookSecret);
      if (!event.id || !event.type) return res.status(400).send("Invalid Stripe event");
      return res.status(200).send({ received: true });
    } catch (error) {
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }
  };
}
