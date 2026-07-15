import type { SQL } from "bun";
import type { Store } from "./types";

const DEFAULT_TABLE = "absolute_rate_limit_entries";
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

export type PostgresStoreOptions = {
  sql: SQL;
  table?: string;
};

export type PostgresStore = Store & {
  activeEntries: () => Promise<number>;
  delete: NonNullable<Store["delete"]>;
  pruneExpired: (limit?: number) => Promise<number>;
};

const tableName = (value: string | undefined) => {
  const table = value ?? DEFAULT_TABLE;
  if (!IDENTIFIER_PATTERN.test(table))
    throw new Error("postgresStore: table must be a safe SQL identifier");

  return table;
};

export const postgresStore = (options: PostgresStoreOptions): PostgresStore => {
  const table = tableName(options.table);
  const query = (statement: string) => statement.replaceAll("$TABLE", table);

  return {
    activeEntries: async () => {
      const rows = (await options.sql.unsafe(
        query(
          "SELECT COUNT(*)::integer AS count FROM $TABLE WHERE expires_at > NOW()",
        ),
      )) as Array<{ count: number }>;

      return rows[0]?.count ?? 0;
    },
    delete: async (key) => {
      await options.sql.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        await transaction.unsafe(query("DELETE FROM $TABLE WHERE key = $1"), [
          key,
        ]);
      });
    },
    pruneExpired: async (limit = 1_000) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000)
        throw new Error(
          "postgresStore.pruneExpired: limit must be between 1 and 100000",
        );
      const rows = (await options.sql.unsafe(
        query(
          `WITH expired AS (
             SELECT key FROM $TABLE
             WHERE expires_at <= NOW()
             ORDER BY expires_at
             LIMIT $1
           )
           DELETE FROM $TABLE entries
           USING expired
           WHERE entries.key = expired.key
           RETURNING entries.key`,
        ),
        [limit],
      )) as Array<{ key: string }>;

      return rows.length;
    },
    update: async <Value>(
      key: string,
      ttlMs: number,
      updateValue: (previous: Value | null) => Value,
    ) =>
      options.sql.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        const rows = (await transaction.unsafe(
          query(
            "SELECT value FROM $TABLE WHERE key = $1 AND expires_at > NOW()",
          ),
          [key],
        )) as Array<{ value: string }>;
        const previous = rows[0] ? (JSON.parse(rows[0].value) as Value) : null;
        const next = updateValue(previous);
        await transaction.unsafe(
          query(
            `INSERT INTO $TABLE (key, value, expires_at, updated_at)
						 VALUES ($1, $2::jsonb, NOW() + $3 * INTERVAL '1 millisecond', NOW())
						 ON CONFLICT (key) DO UPDATE SET
						 value = EXCLUDED.value,
						 expires_at = EXCLUDED.expires_at,
						 updated_at = EXCLUDED.updated_at`,
          ),
          [key, JSON.stringify(next), ttlMs],
        );

        return next;
      }),
  };
};
