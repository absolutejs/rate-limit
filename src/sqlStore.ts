import type { Store } from "./types";
export type RateLimitSql = {
  query: (
    text: string,
    params: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};
export type RateLimitSqlClient = RateLimitSql & {
  transaction: <T>(run: (sql: RateLimitSql) => Promise<T>) => Promise<T>;
};
/** PostgreSQL storage independent of a particular driver. The host owns the
 * journaled schema: key text PK, value jsonb, expires_at/updated_at timestamptz. */
export const sqlStore = (
  client: RateLimitSqlClient,
  table = "absolute_rate_limit_entries",
): Store => {
  if (!/^[a-z_][a-z0-9_]*$/u.test(table))
    throw new Error("Invalid rate-limit table");
  return {
    update: async <T>(
      key: string,
      ttlMs: number,
      update: (previous: T | null) => T,
    ): Promise<T> =>
      client.transaction(async (sql) => {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
          throw new Error("Positive integer TTL required");
        await sql.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [key],
        );
        const result = await sql.query(
          `SELECT value FROM ${table} WHERE key=$1 AND expires_at>NOW()`,
          [key],
        );
        const raw = result.rows[0]?.value;
        const previous =
          raw === undefined
            ? null
            : typeof raw === "string"
              ? JSON.parse(raw)
              : raw;
        const value = update(previous as T | null);
        await sql.query(
          `INSERT INTO ${table} (key,value,expires_at,updated_at) VALUES ($1,$2::jsonb,NOW()+$3*INTERVAL '1 millisecond',NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at`,
          [key, JSON.stringify(value), ttlMs],
        );
        return value;
      }),
    delete: async (key) => {
      await client.transaction(async (sql) => {
        await sql.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [key],
        );
        await sql.query(`DELETE FROM ${table} WHERE key=$1`, [key]);
      });
    },
  };
};
