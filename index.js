import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;
const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log('You successfully connected to MongoDB!');
    return client;
  } catch (err) {
    console.dir(err);
    throw err;
  }
}
let usersCollection, equipmentCollection, bookingsCollection, favoritesCollection, paymentsCollection, reviewsCollection, stripeEventsCollection;
app.get("/", (req, res) => res.send({ message: "Gearly API is running" }));
app.get("/api/health", (req, res) => res.send({ status: "ok" }));


app.use((req, res) => res.status(404).send({ message: "Route not found" }));
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).send({ message: "Internal server error" });
});

async function startServer() {
  try {
    await connectToMongoDB();
    const db = client.db(process.env.DB_NAME || "equipment_rental");
    usersCollection = db.collection("user");
    equipmentCollection = db.collection("equipment");
    bookingsCollection = db.collection("bookings");
    favoritesCollection = db.collection("favorites");
    paymentsCollection = db.collection("payments");
    reviewsCollection = db.collection("reviews");
    stripeEventsCollection = db.collection("stripeEvents");
    await Promise.all([
      favoritesCollection.createIndex({ userId: 1, equipmentId: 1 }, { unique: true }),
      bookingsCollection.createIndex({ customerId: 1, bookingDate: -1 }),
      bookingsCollection.createIndex({ ownerId: 1, bookingDate: -1 }),
      equipmentCollection.createIndex({ status: 1, category: 1, createdAt: -1 }),
      paymentsCollection.createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true }),
      paymentsCollection.createIndex({ transactionId: 1 }, { unique: true, sparse: true }),
      stripeEventsCollection.createIndex({ eventId: 1 }, { unique: true }),
    ]);
    app.listen(port, () => console.log(`Gearly API listening on port ${port}`));
  } catch (error) {
    console.error("Failed to connect to MongoDB", error);
    process.exit(1);
  }
}
startServer();
