import { user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { constantTimeEquals, decryptPassword } from "../auth/crypto";
import { isAcceptablePassword, setPassword } from "../console-auth/credentials";
import { requireFreshSession } from "../console-auth/middleware";
import {
  recentFailures,
  recordFailedAttempt,
  tooManyFailures,
} from "../console-auth/password-attempts";
import { database } from "../db";
import type { ApiApp } from "./app";
import { invalidRequest, limitJsonBody, readJsonObject } from "./json-body";
import { requireSameOrigin } from "./same-origin";

/** The signed-in user's own account (#81, "Change own password"). */
export function registerAccountRoutes(api: ApiApp): void {
  /**
   * `POST /api/account/password` with `{currentPassword, newPassword}`.
   *
   * As in Navidrome's `validatePasswordChange` (persistence/
   * user_repository.go), a user changing their own password has to give the
   * current one: `400 wrong_password` otherwise, having written nothing but
   * the failed attempt. After `MAX_FAILED_PASSWORD_ATTEMPTS` of those within
   * the window every attempt, right or wrong, is `429 rate_limited` and
   * writes nothing (console-auth/password-attempts.ts). A new password
   * outside the accepted lengths is `400 invalid_password`.
   *
   * The session is read from D1, as for every write, and it is the one
   * session kept: the user's others end with the old password, and their
   * Subsonic clients need the new one.
   */
  api.post(
    "/account/password",
    requireSameOrigin,
    limitJsonBody,
    requireFreshSession,
    async (c) => {
      const body = await readJsonObject(c);
      const { currentPassword, newPassword } = body ?? {};
      if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
        return invalidRequest(c);
      }
      if (!isAcceptablePassword(newPassword)) {
        return c.json({ error: "invalid_password" }, 400);
      }

      const { id: sessionId, userId } = c.var.session;
      const db = database(c.env);
      const now = Date.now();
      // The stored password and the recent failures, in one statement.
      const [stored] = await db
        .select({ password: user.password, failures: recentFailures(db, userId, now) })
        .from(user)
        .where(eq(user.id, userId));
      if (stored && tooManyFailures(stored.failures)) {
        return c.json({ error: "rate_limited" }, 429);
      }
      if (!stored || !(await passwordMatches(c.var.passphrase, stored.password, currentPassword))) {
        await recordFailedAttempt(db, userId, now);
        return c.json({ error: "wrong_password" }, 400);
      }

      await setPassword(db, c.var.passphrase, userId, newPassword, { keepSessionId: sessionId });

      return c.json({ ok: true });
    },
  );
}

/** Whether a stored ciphertext holds `given`, compared in constant time. */
async function passwordMatches(passphrase: string, stored: string, given: string) {
  try {
    return constantTimeEquals(await decryptPassword(passphrase, stored), given);
  } catch {
    // Not a ciphertext this passphrase wrote, so nothing can match it.
    return false;
  }
}
