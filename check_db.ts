import { db } from "./src/db/index";

async function run() {
  const users = await db.query("SELECT COUNT(*) as count FROM users");
  console.log("Users:", users[0]?.count);

  const fares = await db.query("SELECT COUNT(*) as count FROM fare_settings").catch(() => [{ count: 0 }]);
  console.log("Fares:", fares[0]?.count);

  const comms = await db.query("SELECT COUNT(*) as count FROM commission_settings").catch(() => [{ count: 0 }]);
  console.log("Comms:", comms[0]?.count);

  process.exit(0);
}
run().catch(console.error);
