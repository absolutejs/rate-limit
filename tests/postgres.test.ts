import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { slidingWindow } from "../src/core";
import { postgresStore } from "../src/postgres";

const databaseTest = process.env.DATABASE_URL ? test : test.skip;

describe("postgresStore", () => {
  databaseTest("linearizes concurrent replicas and honors expiry", async () => {
    const table = `rate_limit_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const firstSql = new SQL({
      prepare: false,
      url: process.env.DATABASE_URL!,
    });
    const secondSql = new SQL({
      prepare: false,
      url: process.env.DATABASE_URL!,
    });
    await firstSql.unsafe(
      `CREATE TABLE ${table} (
				key text PRIMARY KEY,
				value jsonb NOT NULL,
				expires_at timestamp NOT NULL,
				updated_at timestamp NOT NULL DEFAULT NOW()
			)`,
    );
    const first = postgresStore({ sql: firstSql, table });
    const second = postgresStore({ sql: secondSql, table });
    const algorithm = slidingWindow({ periodMs: 60_000, requestsPerPeriod: 3 });

    try {
      const decisions = await Promise.all([
        algorithm.check(first, "shared-key", Date.now()),
        algorithm.check(second, "shared-key", Date.now()),
        algorithm.check(first, "shared-key", Date.now()),
        algorithm.check(second, "shared-key", Date.now()),
      ]);
      expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(3);
      expect(decisions.filter(({ allowed }) => !allowed)).toHaveLength(1);

      await firstSql.unsafe(
        `UPDATE ${table} SET expires_at = NOW() - INTERVAL '1 second' WHERE key = $1`,
        ["shared-key"],
      );
      expect(
        (await algorithm.check(second, "shared-key", Date.now())).allowed,
      ).toBeTrue();
      await first.update("expired-key", 60_000, () => ({ count: 1 }));
      await firstSql.unsafe(
        `UPDATE ${table} SET expires_at = NOW() - INTERVAL '1 second' WHERE key = $1`,
        ["expired-key"],
      );
      expect(await first.activeEntries()).toBe(1);
      expect(await second.pruneExpired()).toBe(1);
    } finally {
      await firstSql.unsafe(`DROP TABLE ${table}`);
      await Promise.all([firstSql.close(), secondSql.close()]);
    }
  });
});
