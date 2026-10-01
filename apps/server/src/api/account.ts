import { setConsolePassword, storedPasswordQuery } from "../console-auth/credentials";
import { requireFreshSession, requirePermission } from "../console-auth/middleware";
import { countPasswordAttempt } from "../console-auth/password-attempts";
import { verifyConsolePassword } from "../console-auth/password-hash";
import { database } from "../db";
import { isAcceptablePassword } from "../users/validation";
import type { ApiApp } from "./app";
import { invalidRequest, limitJsonBody, readJsonObject } from "./json-body";
import { requireSameOrigin } from "./same-origin";

/** The signed-in console user's own account (#81, "Change own password"; #99). */
export function registerAccountRoutes(api: ApiApp): void {
  /**
   * `POST /api/account/password` with `{currentPassword, newPassword}`.
   *
   * As in Navidrome's `validatePasswordChange` (persistence/
   * user_repository.go), whoever changes their own password has to give the
   * current one: `400 wrong_password` otherwise, having written nothing but
   * the session's count of attempts. After `MAX_PASSWORD_ATTEMPTS` attempts
   * within the window, the session's next ones, right or wrong, are
   * `429 rate_limited` and write nothing (console-auth/password-attempts.ts).
   * A new password outside the accepted lengths is `400 invalid_password`,
   * and a console user whose role does not grant `account:change-password`
   * is `403 forbidden` (console-auth/permissions.ts).
   *
   * It is the console password, and only that: no Subsonic password changes.
   * The session is read from D1, role and all, as for every write, and it is
   * the one session kept: the console user's others end with the old
   * password.
   */
  api.post(
    "/account/password",
    requireSameOrigin,
    limitJsonBody,
    requireFreshSession,
    requirePermission("account:change-password"),
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
      // The attempt is counted first, atomically, and the stored hash read in
      // the same round trip; it is compared only if the count allows.
      const [counted, [stored]] = await db.batch([
        countPasswordAttempt(db, sessionId, Date.now()),
        storedPasswordQuery(db, userId),
      ]);
      if (counted.length === 0) {
        return c.json({ error: "rate_limited" }, 429);
      }
      if (
        !stored?.password ||
        !(await verifyConsolePassword(c.var.passphrase, stored.password, currentPassword))
      ) {
        return c.json({ error: "wrong_password" }, 400);
      }

      await setConsolePassword(db, c.var.passphrase, userId, newPassword, {
        keepSessionId: sessionId,
      });

      return c.json({ ok: true });
    },
  );
}
