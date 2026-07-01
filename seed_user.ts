import { db } from './src/db/index.js';
import crypto from 'crypto';

async function seed() {
  try {
    const id = "usr_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO users (id, phone, full_name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (phone) DO UPDATE SET password_hash = $4`,
      [id, '+92312877936', 'Test Rider', '$2b$10$49JQ9ZMFLDB17TsfQAJXKevZqlMiDfaKwOd.aqteMVMjtqQQyubJu', 'customer']
    );
    console.log("Test user created");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

seed();
