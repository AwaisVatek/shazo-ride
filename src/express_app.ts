import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config/index";
import { sendSuccess, sendError } from "./utils/response";
import { db } from "./db/index";

// Import Modular Blueprints Rotators
import authRoutes from "./modules/auth/auth.routes";
import customerRoutes from "./modules/customer/customer.routes";
import usersRoutes from "./modules/users/users.routes";
import mapsRoutes from "./modules/maps/maps.routes";
import ridesRoutes from "./modules/rides/rides.routes";
import ambulanceRoutes from "./modules/ambulance/ambulance.routes";
import foodRoutes from "./modules/food/food.routes";
import riderRoutes from "./modules/rider/rider.routes";
import restaurantRoutes from "./modules/restaurant/restaurant.routes";
import adminRoutes from "./modules/admin/admin.routes";
import financeRoutes from "./modules/finance/finance.routes";
import supportRoutes from "./modules/support/support.routes";
import dispatchRoutes from "./modules/dispatch/dispatch.routes";
import notificationsRoutes from "./modules/notifications/notifications.routes";
import webhooksRoutes from "./modules/webhooks/webhooks.routes";

const app = express();

// 1. Core Security Middlewares
app.use(helmet());
const allowedOrigins = [
  "https://admin.shazoride.com",
  "https://app.shazoride.com",
  "http://localhost:5173",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"],
  })
);

app.options("*", cors());

app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

// Robust body parser limit parameters protects memory slots
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// 2. Global Request rate limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window limits
  max: 1000, // Limit each IP address to 1000 transactions per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    return sendError(res, "TOO_MANY_REQUESTS", "Rate limit exceeded. Please back off temporarily.", 429);
  }
});

app.use("/api", apiLimiter);

// 3. Register Modular Route Segments
app.use("/api/auth", authRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/maps", mapsRoutes);
app.use("/api/rides", ridesRoutes);
app.use("/api/ambulance", ambulanceRoutes);
app.use("/api/food", foodRoutes);
app.use("/api/rider", riderRoutes);
app.use("/api/restaurant", restaurantRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/dispatch", dispatchRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/webhooks", webhooksRoutes);

// 4. Custom Verification Testing Endpoints
app.get("/api/health", (req: Request, res: Response) => {
  return sendSuccess(res, {
    status: "ok",
    version: "2.1.0",
    service: "Shazo Ride Platform Core",
    app_env: config.APP_ENV,
    timezone: "PKT",
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime())
  });
});

app.get("/api/health/database", async (req: Request, res: Response) => {
  try {
    const rawResult = await db.query("SELECT 1 as ping");
    if (rawResult.length > 0 && rawResult[0].ping === 1) {
      return sendSuccess(res, { status: "connected", source: "PostgreSQL Database Pool" });
    }
    throw new Error("Invalid PostgreSQL response index returned.");
  } catch (err: any) {
    return sendError(res, "DATABASE_OFFLINE", `Database check failed: ${err.message}`, 500);
  }
});

app.get("/api/health/maps", async (req: Request, res: Response) => {
  const isGeoConfigured = config.GEOCODING_API_KEY && config.GEOCODING_API_KEY !== "YOUR_BACKEND_GEOCODING_KEY" && config.GEOCODING_API_KEY !== "demo_maps_geocoding_key_backend";
  return sendSuccess(res, {
    maps_provider: config.MAPS_PROVIDER,
    geocoding_initialized: !!isGeoConfigured,
    maps_key_configured: config.MAPS_API_KEY !== "YOUR_FRONTEND_MAPS_KEY",
    notice: "Automatic Karachi geometrical fallbacks are active if API keys represent placeholders."
  });
});

// 5. Catch All 404 router - ensures all /api mismatches return standard JSON
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  return sendError(res, "NOT_FOUND", `Endpoint '${req.originalUrl}' matching method '${req.method}' does not exist on Shazo API routing map.`, 404);
});

// 6. Structured JSON error handling - intercepts runtime throws cleanly preventing raw stacks HTML dumps
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error("💥 Critical global error interception handler:", err);
  const status = err.status || err.statusCode || 500;
  return sendError(res, err.code || "INTERNAL_SERVER_ERROR", err.message || "An unexpected system exception occurred.", status);
});

export { app };
export default app;
