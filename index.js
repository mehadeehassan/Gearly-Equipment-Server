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
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:3000", credentials: true }));
function myLogger(req, res, next) {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
}
app.use(myLogger);
app.use(express.json({ limit: "2mb" }));
import jwt from "jsonwebtoken";
function verifyToken(req, res, next) {
  const authorization = req.headers.authorization;
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
  const token = authorization.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE
    });
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).send({ message: "Invalid or expired token" });
  }
}
const validId = (id) => ObjectId.isValid(id);
const toObjectId = (id) => new ObjectId(id);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
app.get("/", (req, res) => res.send({ message: "Gearly API is running" }));
app.get("/api/health", (req, res) => res.send({ status: "ok" }));

// Profile is based on the verified token identity, never on a client-supplied user id.
app.get("/api/profile", verifyToken, async (req, res) => {
  try {
    const user = await usersCollection.findOne({ _id: req.user.id }, { projection: { password: 0 } });
    if (!user) return res.status(404).send({ message: "User not found" });
    const { _id, ...profile } = user;
    res.send({ user: { ...profile, id: _id } });
  } catch { res.status(500).send({ message: "Failed to load profile" }); }
});

app.patch("/api/profile", verifyToken, async (req, res) => {
  try {
    const { name, image, phone, address } = req.body || {};
    const update = {};
    if (typeof name === "string") update.name = name.trim();
    if (typeof image === "string") update.image = image.trim();
    if (typeof phone === "string") update.phone = phone.trim();
    if (typeof address === "string") update.address = address.trim();
    if (!Object.keys(update).length) {
      return res.status(400).send({ message: "Provide at least one editable profile field: name, image, phone, or address" });
    }

    const result = await usersCollection.updateOne(
      { _id: req.user.id },
      { $set: { ...update, updatedAt: new Date() } }
    );
    if (!result.matchedCount) return res.status(404).send({ message: "User not found" });

    const user = await usersCollection.findOne(
      { _id: req.user.id },
      { projection: { password: 0 } }
    );
    const { _id, ...profile } = user;
    res.send({ message: "Profile updated", user: { ...profile, id: _id } });
  } catch (error) {
    console.error("Failed to update profile", error);
    res.status(500).send({ message: "Failed to update profile" });
  }
});

// Owner equipment management.

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
