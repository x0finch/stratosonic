import { drizzle } from "drizzle-orm/d1";
import type { Env } from "./env";

/**
 * A Drizzle handle on the D1 database.
 *
 * D1 bindings are per-request objects, so this is built where it is used rather
 * than kept in a module-level singleton.
 */
export function database(env: Env) {
  return drizzle(env.DB);
}

export type Database = ReturnType<typeof database>;
