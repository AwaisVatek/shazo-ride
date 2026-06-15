import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import crypto from "crypto";
dotenv.config();

import { app } from "./express_app";
import { config } from "./config/index";
import { db } from "./db/index";
import { seed } from "./seed/index";

const PORT = Number(process.env.PORT) || 3000;

export const httpServer = createServer(app);
export const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH"]
  }
});

// Setup basic Socket.io events
io.on("connection", (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  
  // A driver joins a specific room to receive nearby requests
  socket.on("join_driver_pool", () => {
    socket.join("driver_pool");
    console.log(`Driver joined pool: ${socket.id}`);
  });

  // A customer joins their own room to listen for driver bids
  socket.on("join_ride", (rideId) => {
    socket.join(rideId);
    console.log(`Customer joined ride tracking: ${rideId}`);
  });

  // Chat message system for an active ride
  socket.on("send_message", async (data: { rideId: string, senderId: string, senderRole: string, content: string }) => {
    try {
      const msgId = "msg_" + crypto.randomUUID().slice(0, 8);
      await db.query(
        "INSERT INTO ride_messages (id, ride_id, sender_id, sender_role, content) VALUES ($1, $2, $3, $4, $5)",
        [msgId, data.rideId, data.senderId, data.senderRole, data.content]
      );
      
      // Broadcast to everyone in the room
      io.to(data.rideId).emit("receive_message", {
        id: msgId,
        ride_id: data.rideId,
        sender_id: data.senderId,
        sender_role: data.senderRole,
        content: data.content,
        created_at: new Date().toISOString()
      });
    } catch (err) {
      console.error("Chat Error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
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
