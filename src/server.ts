import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import crypto from "crypto";
import jwt from "jsonwebtoken";
dotenv.config();

import { app } from "./express_app";
import { config } from "./config/index";
import { db } from "./db/index";
import { seed } from "./seed/index";

const PORT = Number(process.env.PORT) || 3000;

export const httpServer = createServer(app);
const socketAllowedOrigins = [
  "https://admin.shazoride.com",
  "https://app.shazoride.com",
  "http://localhost:5173",
  "http://localhost:3000",
];
export const io = new Server(httpServer, {
  cors: {
    origin: socketAllowedOrigins,
    methods: ["GET", "POST", "PATCH"]
  }
});

interface AuthedSocket extends Socket {
  data: { user?: { id: string; role: string } };
}

// Every socket connection previously had NO authentication at all — both
// apps already send a JWT via `socket.auth = { token }` before connecting
// (confirmed in each app's api/client.ts), but the server never read it.
// Concretely, this meant: any client could join ANY rideId's room and both
// read live location/chat and post chat messages under a spoofed
// senderId/senderRole for a ride they had nothing to do with, and a rider
// disconnecting (app killed, crash, connection loss) never got marked
// offline server-side — a "ghost rider" staying is_online=true forever
// until they happened to reopen the app and manually toggle offline.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error("UNAUTHORIZED"));
  }
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as { userId: string; role: string };
    (socket as AuthedSocket).data.user = { id: decoded.userId, role: decoded.role };
    next();
  } catch (err) {
    next(new Error("UNAUTHORIZED"));
  }
});

async function markRiderOffline(userId: string) {
  try {
    await db.query("UPDATE rider_profiles SET is_online = false, updated_at = NOW() WHERE user_id = $1", [userId]);
  } catch (err) {
    console.error("Failed to mark rider offline on disconnect:", err);
  }
}

async function canAccessRide(userId: string, role: string, rideId: string): Promise<boolean> {
  if (role === "admin" || role === "operations_manager") return true;
  try {
    const rows = await db.query(
      "SELECT 1 FROM ride_bookings WHERE id = $1 AND (customer_id = $2 OR rider_id = $2)",
      [rideId, userId]
    );
    return rows.length > 0;
  } catch (err) {
    return false;
  }
}

async function canAccessAmbulance(userId: string, role: string, requestId: string): Promise<boolean> {
  if (role === "admin" || role === "operations_manager") return true;
  try {
    const rows = await db.query(
      "SELECT 1 FROM ambulance_bookings WHERE id = $1 AND (customer_id = $2 OR rider_id = $2)",
      [requestId, userId]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

// Setup basic Socket.io events
io.on("connection", (socket: AuthedSocket) => {
  const user = socket.data.user!;
  console.log(`🔌 Client connected: ${socket.id} (user=${user.id}, role=${user.role})`);

  // A driver joins a specific room to receive nearby requests
  socket.on("join_driver_pool", async () => {
    if (user.role !== "rider") return;
    const profiles = await db.query(
      `SELECT verification_status, is_online, vehicle_type, current_lat, current_lng, last_location_at
       FROM rider_profiles WHERE user_id = $1`,
      [user.id]
    );
    const profile = profiles[0];
    const locationFresh = profile?.last_location_at && Date.now() - new Date(profile.last_location_at).getTime() < 10 * 60 * 1000;
    if (!profile || profile.verification_status !== "verified" || !profile.is_online || !locationFresh || profile.current_lat == null || profile.current_lng == null) return;
    socket.join(`driver_pool:${profile.vehicle_type}`);
    console.log(`Eligible driver joined ${profile.vehicle_type} pool: ${socket.id}`);
  });

  // A customer or rider joins their own ride's room — only if they're
  // actually a party to that ride, not any arbitrary rideId.
  socket.on("join_ride", async (rideId) => {
    if (typeof rideId !== "string" || !(await canAccessRide(user.id, user.role, rideId))) {
      return;
    }
    socket.join(rideId);
    console.log(`${user.role} ${user.id} joined ride tracking: ${rideId}`);
  });

  // A customer joins their ambulance dispatch's room to receive status updates
  socket.on("join_ambulance", async (requestId) => {
    if (typeof requestId !== "string" || !(await canAccessAmbulance(user.id, user.role, requestId))) return;
    socket.join(`ambulance_${requestId}`);
    console.log(`Customer joined ambulance tracking: ${requestId}`);
  });

  // Chat message system for an active ride — sender identity comes from the
  // authenticated socket, never trusted from the client payload (previously
  // any connected client could post as any senderId/senderRole).
  socket.on("send_message", async (data: { rideId: string, content: string }) => {
    try {
      if (typeof data?.rideId !== "string" || !(await canAccessRide(user.id, user.role, data.rideId))) {
        return;
      }
      const msgId = "msg_" + crypto.randomUUID().slice(0, 8);
      await db.query(
        "INSERT INTO ride_messages (id, ride_id, sender_id, sender_role, content) VALUES ($1, $2, $3, $4, $5)",
        [msgId, data.rideId, user.id, user.role, data.content]
      );

      // Broadcast to everyone in the room
      io.to(data.rideId).emit("receive_message", {
        id: msgId,
        ride_id: data.rideId,
        sender_id: user.id,
        sender_role: user.role,
        content: data.content,
        created_at: new Date().toISOString()
      });
    } catch (err) {
      console.error("Chat Error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Client disconnected: ${socket.id} (user=${user.id})`);
    if (user.role === "rider") {
      markRiderOffline(user.id);
    }
  });
});

async function bootstrap() {
  // Check if ran as CLI migrations or seeds utility command
  if (process.argv.includes("--migrate")) {
    console.log("⚙️  Running manual CLI database migration...");
    try {
      await db.verifyConnection();
      await db.migrate();
      console.log("✅ Manual CLI database migration completed successfully.");
      process.exit(0);
    } catch (err: any) {
      console.error("❌ CLI migration failed:", err.message);
      process.exit(1);
    }
  }

  if (process.argv.includes("--seed")) {
    console.log("🌱 Running manual CLI database seeding...");
    try {
      await db.verifyConnection();
      await seed();
      console.log("✅ Manual CLI database seeding completed successfully.");
      process.exit(0);
    } catch (err: any) {
      console.error("❌ CLI seeding failed:", err.message);
      process.exit(1);
    }
  }

  console.log("🚀 Initializing Shazo ride platform core engine...");

  try {
    // 1. Verify database connectivity without executing migrations automatically
    await db.verifyConnection();
    
    // 2. Only in development, auto-seed if ENABLE_DEMO_CREDENTIALS is true
    if (config.APP_ENV === "development" && config.ENABLE_DEMO_CREDENTIALS) {
      console.log("🌱 Development mode auto-seed checking...");
      await seed();
    }
  } catch (err: any) {
    console.error("☠️  Core systems failed to bootstrap on launch:", err.message);
    if (config.APP_ENV === "production") {
      process.exit(1);
    }
  }

  // 3. Bind server to port
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`===============================================`);
    console.log(`💚 Shazo Ride Company Core API is fully ONLINE!`);
    console.log(`📌 Port: ${PORT} (HTTP + WebSockets)`);
    console.log(`📡 Bind: 0.0.0.0`);
    console.log(`🌍 Env:  ${config.APP_ENV}`);
    console.log(`===============================================`);
  });
}

bootstrap().catch((err) => {
  console.error("💥 Unhandled runtime fatal error during bootstrap:", err);
  process.exit(1);
});
