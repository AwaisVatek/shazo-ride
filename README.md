# Shazo Ride Company Core API Backend 🚖🌟

Shazo Ride Company backend is a high-performance, modular, and production-grade API engine built explicitly for Karachi-first ride, ambulance, and food delivery services.

This is the actual production backend designed for direct **Coolify** deployments via GitHub. It completely avoids hardcoded logic, simulated maps computations, or mock database fallbacks.

---

## 🏗️ Core Product Architecture

The system utilizes a fully decoupled, role-permissioned, and event-driven architecture structured around a unified relational PostgreSQL interface.

```
src/
├── app.ts                  # Central Express configuration, helmet, cors & error-handling limits
├── server.ts               # Master launcher, bootstraps DB migrations & seeds
├── config/                 # Strong environment schema validation utilizing Zod
├── db/                     # PostgreSQL transactional connection pooling structures
├── migrations/             # SQL-native initial table definitions, enum boundaries, and audit schemas
├── seed/                   # Production-grade administrative, driver, and restaurant catalogs seed
├── middleware/             # Role guards (Riders, Restaurants, Finance desk, Op Managers)
├── utils/                  # Standardized response structures, phone normalization, notification systems
└── modules/                # Core modular business domains
    ├── auth/               # OTP verification & credential sessions JWT systems
    ├── users/              # Multi-role account selectors & updates
    ├── maps/               # Geocoding, Google routing maps cache proxies
    ├── rides/              # Multi-tier ride estimations, status, cancellations, and ratings
    ├── ambulance/          # Emergency dispatches, fully paid calculation rates, Hospital routing
    ├── food/               # Interactive restaurant catalogs, multi-item carts, commission checkouts
    ├── rider/              # Duty shifts, manual payment top-up filings with verification receipts
    ├── restaurant/         # Cook orders preparation status tracks & inventory controls
    ├── admin/              # Core statistics aggregation & live configurations overrides
    ├── finance/            # Verification review, approval, and double-entry ledger audits
    ├── support/            # Customer support tickets & message boards
    ├── dispatch/           # Ops dispatch force-assign unassigned queues to online riders
    └── notifications/      # Real-time message storage log trackers
```

---

## ⚙️ Primary Production Environment Settings

Prepare your backend ecosystem by initializing the following keys in your Coolify config variables panel (refer to `.env.example` as a template guide):

```env
# Server Network Settings
PORT=3000
API_BASE_URL=https://app.shazoride.com

# Database Connection Pool
DATABASE_URL=postgresql://user:password@hostname:5432/dbname

# Cryptographic Token Signing
JWT_SECRET=shazo-secure-karachi-secret-token-key-2026

# External Services Integrations
MAPS_API_KEY=your-google-maps-api-key
GEOCODING_API_KEY=your-google-maps-geocoding-server-key
WHATSAPP_SANDBOX_TOKEN=your-whatsapp-sandbox-token
SMS_GATEWAY_API_KEY=your-sms-gateway-api-key
```

---

## 🐳 Coolify Containerization Guides

This repository includes a multi-stage Dockerfile designed for high-performance builds and visual deployment states inside Coolify runners.

### Local Compilation Checks
1. Compile and bundle the microservices using:
   ```bash
   npm run build
   ```
2. Start the resulting self-contained production bundle:
   ```bash
   npm run start
   ```

### Coolify Platform Integration:
- **Build Provider**: Dockerfile
- **Port Mapping**: `3000:3000`
- **Health Check Path**: `/api/health`
- **Deployment Variables**: Fully load database connection strings in the Coolify environment values panel.

---

## 🚦 Live QA & Testing Verification Routes

Once healthy and online, execute request audits on the following unified testing endpoints to verify compliance:

1. **System Health Heartbeat**:
   `GET /api/health`
2. **PostgreSQL Network Ping**:
   `GET /api/health/database`
3. **Mappers Cache Diagnostics**:
   `GET /api/health/maps`
4. **Current Account Context**:
   `GET /api/auth/session` (Requires Bearer authorization)
5. **Admin Operations Board**:
   `GET /api/admin/dashboard` (Requires Admin authorization)

---

## 🔑 Operational Seed Testing Credentials

The system hydrates verification records automatically on bootstrap. Test specific domains using the following developer sandbox profiles:

| Operational Persona | Login Identifier (Email) | Sandbox Standard Passcodes |
| :--- | :--- | :--- |
| **System Administrator** | `admin@shazoride.com` | `ShazoAdmin2026!` |
| **Finance Desk Manager** | `finance@shazoride.com` | `ShazoFinance2026!` |
| **Operations dispatcher** | `operations@shazoride.com` | `ShazoOps2026!` |
| **Customer / Passenger** | `customer@shazoride.com` | `ShazoCustomer2026!` |
| **Ride Platform Pilot** | `rider@shazoride.com` | `ShazoRider2026!` |
| **Restaurant Partner** | `restaurant@shazoride.com` | `ShazoRestaurante2026!` |

---

## 🚨 Ambulance Operations Terms Notice
- **Karachi ambulance dispatches are strictly paid, premium medical services**.
- This service is always **subject to availability and coverage**.
- Promotional credits, wallet cashbacks, or free transport campaigns *never* apply to Emergency Ambulance dispatches under corporate regulatory frameworks.
