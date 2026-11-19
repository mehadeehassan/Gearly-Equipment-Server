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
const verifyRenter = (req, res, next) => {
  if (req.user?.role !== "customer" && req.user?.role !== "renter") return res.status(403).send({ message: "Renter access required" });
  next();
};
const verifyOwner = (req, res, next) => {
  if (req.user?.role !== "owner") return res.status(403).send({ message: "Owner access required" });
  next();
};
const verifyAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") return res.status(403).send({ message: "Admin access required" });
  next();
};
const validId = (id) => ObjectId.isValid(id);
const toObjectId = (id) => new ObjectId(id);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
app.get("/", (req, res) => res.send({ message: "Gearly API is running" }));
app.get("/api/health", (req, res) => res.send({ status: "ok" }));

// Public equipment list with server-side search, filtering, sorting and pagination.
app.get("/api/equipment", async (req, res) => {
  try {
    const { search, category, rentalType, availability, minPrice, maxPrice } = req.query;
    const query = { status: "approved" };
    if (category) query.category = category;
    if (rentalType) query.rentalType = rentalType;
    if (availability === "available") query.availableQuantity = { $gt: 0 };
    if (availability === "unavailable") query.availableQuantity = { $lte: 0 };
    if (minPrice !== undefined || maxPrice !== undefined) {
      query.price = {};
      if (minPrice !== undefined && Number.isFinite(Number(minPrice))) query.price.$gte = Math.max(0, Number(minPrice));
      if (maxPrice !== undefined && Number.isFinite(Number(maxPrice))) query.price.$lte = Math.max(0, Number(maxPrice));
      if (!Object.keys(query.price).length) delete query.price;
    }
    if (search) {
      const safeSearch = new RegExp(escapeRegex(String(search)), "i");
      query.$or = [{ title: safeSearch }, { category: safeSearch }, { location: safeSearch }];
    }
    const [equipment, total] = await Promise.all([
      equipmentCollection.find(query).toArray(),
      equipmentCollection.countDocuments(query)
    ]);
    res.send({ equipment, total });
  } catch (error) {
    res.status(500).send({ message: "Failed to load equipment" });
  }
});

app.get("/api/equipment/featured", async (req, res) => {
  try {
    const equipment = await equipmentCollection.find({ status: "approved" }).sort({ createdAt: -1 }).limit(6).toArray();
    res.send({ equipment });
  } catch { res.status(500).send({ message: "Failed to load featured equipment" }); }
});

// Published reviews and clearly labeled demo reviews are read from MongoDB.
app.get("/api/reviews", async (req, res) => {
  try {
    const reviews = await reviewsCollection.find({ status: { $in: ["approved", "published", "demo"] } }, { projection: { customerName: 1, rating: 1, comment: 1, createdAt: 1, demoOnly: 1 } }).sort({ createdAt: -1 }).limit(15).toArray();
    res.send({ reviews });
  } catch { res.status(500).send({ message: "Failed to load reviews" }); }
});

app.get("/api/equipment/:id", async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).send({ message: "Invalid equipment id" });
    const equipment = await equipmentCollection.findOne({ _id: toObjectId(req.params.id), status: "approved" });
    if (!equipment) return res.status(404).send({ message: "Equipment not found" });
    res.send({ equipment });
  } catch { res.status(500).send({ message: "Failed to load equipment details" }); }
});

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
app.post("/api/owner/equipment", verifyToken, verifyOwner, async (req, res) => {
  try {
    const { title, description, category, location, price, rentalType, availableQuantity, condition, brand, model, image, terms } = req.body;
    if (!title || !description || !category || !location || !price || !rentalType || !image) {
      return res.status(400).send({ message: "Please provide all required equipment fields" });
    }
    const doc = {
      title: title.trim(), description, category, location: location.trim(), price: Number(price), rentalType,
      availableQuantity: Math.max(0, Number(availableQuantity) || 0), condition, brand, model, image, terms,
      ownerId: toObjectId(req.user.id), ownerName: req.user.name || "", status: "pending",
      createdAt: new Date(), updatedAt: new Date()
    };
    const result = await equipmentCollection.insertOne(doc);
    res.status(201).send({ message: "Equipment submitted for approval", insertedId: result.insertedId });
  } catch { res.status(500).send({ message: "Failed to add equipment" }); }
});

app.get("/api/owner/equipment", verifyToken, verifyOwner, async (req, res) => {
  try {
    const equipment = await equipmentCollection.find({ ownerId: toObjectId(req.user.id) }).sort({ createdAt: -1 }).toArray();
    res.send({ equipment });
  } catch { res.status(500).send({ message: "Failed to load your equipment" }); }
});

app.patch("/api/owner/equipment/:id", verifyToken, verifyOwner, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).send({ message: "Invalid equipment id" });
    const allowed = ["title","description","category","location","price","rentalType","availableQuantity","condition","brand","model","image","terms"];
    const update = {};
    for (const key of allowed) if (req.body[key] !== undefined) update[key] = req.body[key];
    if (update.price !== undefined) update.price = Number(update.price);
    if (update.availableQuantity !== undefined) update.availableQuantity = Number(update.availableQuantity);
    const result = await equipmentCollection.updateOne(
      { _id: toObjectId(req.params.id), ownerId: toObjectId(req.user.id) },
      { $set: { ...update, status: "pending", updatedAt: new Date() } }
    );
    if (!result.matchedCount) return res.status(404).send({ message: "Equipment not found" });
    res.send({ message: "Equipment updated and sent for review" });
  } catch { res.status(500).send({ message: "Failed to update equipment" }); }
});

app.delete("/api/owner/equipment/:id", verifyToken, verifyOwner, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).send({ message: "Invalid equipment id" });
    const result = await equipmentCollection.deleteOne({ _id: toObjectId(req.params.id), ownerId: toObjectId(req.user.id) });
    if (!result.deletedCount) return res.status(404).send({ message: "Equipment not found" });
    res.send({ message: "Equipment deleted" });
  } catch { res.status(500).send({ message: "Failed to delete equipment" }); }
});

// Favorites.

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
