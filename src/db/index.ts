import pg from "pg";
import fs from "fs";
import path from "path";
import { config } from "../config/index";

class DatabaseManager {
  private pool: pg.Pool | null = null;
  private initialized = false;

  constructor() {
    this.pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.APP_ENV === "production" ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.pool.on("error", (err) => {
      console.error("📋 PostgreSQL connection pool error:", err);
    });
  }

  public getPool(): pg.Pool {
    if (!this.pool) {
      throw new Error("Pool is not initialized");
    }
    return this.pool;
  }

  /**
   * Run custom parameterized string SQL queries asynchronously
   */
  public async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const client = await this.pool!.connect();
    try {
      const res = await client.query(sql, params);
      return res.rows as T[];
    } catch (err: any) {
      console.error(`❌ DB error executing query "${sql.substring(0, 80)}...":`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Run atomic queries within a transactional block
   */
  public async transaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool!.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Initialize pool connection and verify server-database link
   */
  public async verifyConnection(): Promise<void> {
    if (this.initialized) return;

    try {
      console.log("🛠️  Validating database connectivity...");
      // Check database health
      await this.query("SELECT 1 as ping");
      console.log("✅ Database connectivity successfully verified.");
      this.initialized = true;
    } catch (err: any) {
      console.error("❌ Database connectivity assertion failed:", err.message);
      if (config.APP_ENV === "production") {
        throw err;
      }
    }
  }

  /**
   * Manually execute initial database structure migrations
   */
  public async migrate(): Promise<void> {
    try {
      console.log("🔋 Loading local migration schemas...");
      const migrationsDir = path.resolve(process.cwd(), "src/migrations");

      if (!fs.existsSync(migrationsDir)) {
        throw new Error(`Migration directory not detected at path: ${migrationsDir}`);
      }

      const migrationFiles = fs
        .readdirSync(migrationsDir)
        .filter((file) => file.endsWith(".sql"))
        .sort();

      if (migrationFiles.length === 0) {
        throw new Error(`No SQL migration files detected at path: ${migrationsDir}`);
      }

      for (const file of migrationFiles) {
        const migrationPath = path.join(migrationsDir, file);
        const migrationSql = fs.readFileSync(migrationPath, "utf-8");
        console.log(`⚡ Executing migration: ${file}`);
        await this.pool!.query(migrationSql);
      }

      console.log("🚀 Schema successfully applied/verified manual migrations.");
    } catch (err: any) {
      console.error("❌ Database manual migration failed:", err.message);
      throw err;
    }
  }
}

export const db = new DatabaseManager();
export const dbQuery = db.query.bind(db);
