import type { Context } from "hono";
import {
  acceptableUserName,
  createUserWithPassword,
  isAcceptablePassword,
  MAX_USERNAME_LENGTH,
  setPassword,
} from "../console-auth/credentials";
import type { ConsoleEnv } from "../console-auth/middleware";
import { database } from "../db";
import {
  configuredSetupToken,
  isSpentTokenConflict,
  markSpentIfCreated,
  markSpentIfStillAdmin,
  matchSetupToken,
  readSetupFacts,
  setupState,
  setupTokenDigest,
} from "../setup/setup-token";
import type { ApiApp } from "./app";
import { invalidRequest, limitJsonBody, readJsonObject } from "./json-body";
import { requireSameOrigin } from "./same-origin";

/**
 * Setup and recovery with the setup token (#81): the first admin, created in
 * the console, and an admin's password reset once it is forgotten.
 *
 * Both POSTs take `{token, username, password}` and check them in this
 * order, answering with the first refusal:
 *
 * 1. `400 invalid_request`: a body that is not a JSON object of strings;
 * 2. `403 invalid_token`: no usable token configured, or a wrong one.
 *    Nothing past this point is told to a caller without the token;
 * 3. `400 invalid_username`, `400 invalid_password`: see
 *    console-auth/credentials.ts for what is accepted. Setup trims the name
 *    it creates; recovery looks the name up exactly as typed, so that a
 *    name with spaces around it, written before that rule, can be reset;
 * 4. what the database says: a token already spent is `403 invalid_token`
 *    as well; setup while a user exists is `409 already_set_up`; recovery
 *    with no user is `409 not_set_up`, of a name nobody has
 *    `400 unknown_user`, and of a user who is not an admin `400 not_admin`.
 *
 * Setup answers `201 {id, userName, isAdmin}` and recovery
 * `200 {id, userName, isAdmin}`, the shape of `GET /api/me`. Neither signs
 * anyone in: the console sends the admin to sign in with the new password.
 *
 * A refusal writes nothing. The write itself is one D1 batch: the password,
 * the credential account and the spent token, together or not at all.
 */
export function registerSetupRoutes(api: ApiApp): void {
  // What the console should offer. No token, or one too short, closes both
  // paths without asking D1 anything.
  api.get("/setup", async (c) => {
    const token = configuredSetupToken(c.env);
    const facts =
      token === null ? null : await readSetupFacts(database(c.env), await setupTokenDigest(token));

    return c.json({ state: setupState(facts) });
  });

  api.post("/setup", requireSameOrigin, limitJsonBody, async (c) => {
    const form = await readForm(c, acceptableUserName);
    if (!("digest" in form)) {
      return form.refusal;
    }

    const { digest, userName, password } = form;
    const db = database(c.env);
    const facts = await readSetupFacts(db, digest);
    if (facts.spent) {
      return invalidToken(c);
    }
    if (facts.hasUsers) {
      return alreadySetUp(c);
    }

    let id: string | null;
    try {
      id = await createUserWithPassword(
        db,
        c.var.passphrase,
        { userName, password, isAdmin: true },
        {
          // Two setups racing, or a setup racing the first-run bootstrap,
          // make one admin: the loser's batch writes nothing at all.
          onlyIfFirstUser: true,
          alongside: (userId) => [markSpentIfCreated(db, digest, userId)],
        },
      );
    } catch (error) {
      if (isSpentTokenConflict(error)) {
        return invalidToken(c);
      }
      throw error;
    }

    if (id === null) {
      return alreadySetUp(c);
    }

    return c.json({ id, userName, isAdmin: true }, 201);
  });

  api.post("/setup/reset", requireSameOrigin, limitJsonBody, async (c) => {
    const form = await readForm(c, nameAsTyped);
    if (!("digest" in form)) {
      return form.refusal;
    }

    const { digest, userName, password } = form;
    const db = database(c.env);
    const { spent, hasUsers, target } = await readSetupFacts(db, digest, userName);
    if (spent) {
      return invalidToken(c);
    }
    if (!hasUsers) {
      return c.json({ error: "not_set_up" }, 409);
    }
    if (target === null) {
      return c.json({ error: "unknown_user" }, 400);
    }
    if (!target.isAdmin) {
      return c.json({ error: "not_admin" }, 400);
    }

    let changed: boolean;
    try {
      // Every session of the admin's ends: whoever knew the old password is
      // signed out with it. The batch holds to the user still being an
      // admin, which the read above cannot promise: one demoted in between
      // keeps everything, and the token stays unspent.
      changed = await setPassword(db, c.var.passphrase, target.id, password, {
        onlyIfAdmin: true,
        alongside: [markSpentIfStillAdmin(db, digest, target.id)],
      });
    } catch (error) {
      if (isSpentTokenConflict(error)) {
        return invalidToken(c);
      }
      throw error;
    }
    if (!changed) {
      return c.json({ error: "not_admin" }, 400);
    }

    return c.json({ id: target.id, userName: target.userName, isAdmin: true });
  });
}

type SetupForm =
  | { readonly digest: string; readonly userName: string; readonly password: string }
  | { readonly refusal: Response };

/**
 * Reads `{token, username, password}` and checks everything the database is
 * not needed for: the shape, the token against the secret, then the name, by
 * `nameRule`, and the password.
 */
async function readForm(
  c: Context<ConsoleEnv>,
  nameRule: (typed: string) => string | null,
): Promise<SetupForm> {
  const body = await readJsonObject(c);
  const { token, username, password } = body ?? {};
  if (typeof token !== "string" || typeof username !== "string" || typeof password !== "string") {
    return { refusal: invalidRequest(c) };
  }

  const digest = await matchSetupToken(c.env, token);
  if (digest === null) {
    return { refusal: invalidToken(c) };
  }

  const userName = nameRule(username);
  if (userName === null) {
    return { refusal: c.json({ error: "invalid_username" }, 400) };
  }
  if (!isAcceptablePassword(password)) {
    return { refusal: c.json({ error: "invalid_password" }, 400) };
  }

  return { digest, userName, password };
}

/** A name to look up, as typed: any name `user_name` can hold. */
function nameAsTyped(typed: string): string | null {
  return typed.length >= 1 && typed.length <= MAX_USERNAME_LENGTH ? typed : null;
}

function invalidToken(c: Context) {
  return c.json({ error: "invalid_token" }, 403);
}

function alreadySetUp(c: Context) {
  return c.json({ error: "already_set_up" }, 409);
}
