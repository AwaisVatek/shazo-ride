import dotenv from "dotenv";
dotenv.config();

import { app } from "./express_app";
import { config } from "./config/index";
import { db } from "./db/index";
import { seed } from "./seed/index";

const PORT = Number(process.env.PORT) || 3000;

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
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`===============================================`);
    console.log(`💚 Shazo Ride Company Core API is fully ONLINE!`);
    console.log(`📌 Port: ${PORT}`);
    console.log(`📡 Bind: 0.0.0.0`);
    console.log(`🌍 Env:  ${config.APP_ENV}`);
    console.log(`===============================================`);
  });
}

bootstrap().catch((err) => {
  console.error("💥 Unhandled runtime fatal error during bootstrap:", err);
  process.exit(1);
});
