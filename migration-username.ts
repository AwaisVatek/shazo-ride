import { db } from "./src/db/index.js";

async function run() {
  try {
    await db.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;
    `);
    console.log('Username column added successfully');
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
run();
