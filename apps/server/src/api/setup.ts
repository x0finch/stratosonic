import type { Context } from "hono";
import {
  acceptableUserName,
  createConsoleUser,
  isAcceptablePassword,
} from "../console-auth/credentials";
import type { ConsoleEnv } from "../console-auth/middleware";
import { OWNER_ROLE, permissionsOf } from "../console-auth/permissions";
import { database } from "../db";
import {
  configuredSetupToken,
  isSpentTokenConflict,
  markSpentFor,
  matchSetupToken,
  readSetupFacts,
  setupState,
  setupTokenDigest,
} from "../setup/setup-token";
import type { ApiApp } from "./app";
import { invalidRequest, limitJsonBody, readJsonObject } from "./json-body";
import { requireSameOrigin } from "./same-origin";

/**
 * First-run setup with the setup token (#81, #99, #105): the console's owner,
 * its first user, created in the console. Console users are the console's own
 * accounts: Subsonic users do not count as set up. The token does nothing
 * else: it is not a way to reset a password. An owner who has lost theirs is
 * deleted from D1 by hand, and the server set up again with a new token
 * (apps/server/README.md).
 *
 * `POST /api/setup` takes `{token, username, password}` and checks them in
 * this order, answering with the first refusal:
 *
 * 1. `400 invalid_request`: a body that is not a JSON object of strings;
 * 2. `403 invalid_token`: no usable token configured, or a wrong one.
 *    Nothing past this point is told to a caller without the token;
 * 3. `400 invalid_username`, `400 invalid_password`: see
 *    console-auth/credentials.ts for what is accepted. The name is trimmed;
 * 4. what the database says: a token already spent is `403 invalid_token`
 *    as well, and setup while a console user exists is `409 already_set_up`.
 *
 * Setup answers `201` with `{id, username, role, permissions}`, the shape of
 * `GET /api/me`, and gives the first console user the `owner` role. It signs
 * nobody in: the console sends the owner to sign in with the new password.
 *
 * A refusal writes nothing. The write itself is one D1 batch: the console
 * user, its credential account and the spent token, together or not at all.
 */
export function registerSetupRoutes(api: ApiApp): void {
  // What the console should offer. No token, or one too short, closes setup
  // without asking D1 anything.
  api.get("/setup", async (c) => {
    const token = configuredSetupToken(c.env);
    const facts =
      token === null ? null : await readSetupFacts(database(c.env), await setupTokenDigest(token));

    return c.json({ state: setupState(facts) });
  });

  api.post("/setup", requireSameOrigin, limitJsonBody, async (c) => {
    const form = await readForm(c);
    if (!("digest" in form)) {
      return form.refusal;
    }

    const { digest, username, password } = form;
    const db = database(c.env);
    const facts = await readSetupFacts(db, digest);
    if (facts.spent) {
      return invalidToken(c);
    }
    if (facts.hasConsoleUsers) {
      return alreadySetUp(c);
    }

    let id: string | null;
    try {
      id = await createConsoleUser(
        db,
        c.var.passphrase,
        { username, password, role: OWNER_ROLE },
        {
          // Two setups racing make one console user: the loser's batch writes
          // nothing at all.
          onlyIfFirstUser: true,
          alongside: (consoleUserId) => [markSpentFor(db, digest, consoleUserId)],
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

    return c.json({ id, username, role: OWNER_ROLE, permissions: permissionsOf(OWNER_ROLE) }, 201);
  });
}

type SetupForm =
  | { readonly digest: string; readonly username: string; readonly password: string }
  | { readonly refusal: Response };

/**
 * Reads `{token, username, password}` and checks everything the database is
 * not needed for: the shape, the token against the secret, then the name and
 * the password.
 */
async function readForm(c: Context<ConsoleEnv>): Promise<SetupForm> {
  const body = await readJsonObject(c);
  const { token, username, password } = body ?? {};
  if (typeof token !== "string" || typeof username !== "string" || typeof password !== "string") {
    return { refusal: invalidRequest(c) };
  }

  const digest = await matchSetupToken(c.env, token);
  if (digest === null) {
    return { refusal: invalidToken(c) };
  }

  const name = acceptableUserName(username);
  if (name === null) {
    return { refusal: c.json({ error: "invalid_username" }, 400) };
  }
  if (!isAcceptablePassword(password)) {
    return { refusal: c.json({ error: "invalid_password" }, 400) };
  }

  return { digest, username: name, password };
}

function invalidToken(c: Context) {
  return c.json({ error: "invalid_token" }, 403);
}

function alreadySetUp(c: Context) {
  return c.json({ error: "already_set_up" }, 409);
}
