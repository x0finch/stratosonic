import type { Context } from "hono";
import {
  acceptableUserName,
  createOperator,
  isAcceptablePassword,
  MAX_USERNAME_LENGTH,
  setOperatorPassword,
} from "../console-auth/credentials";
import type { ConsoleEnv } from "../console-auth/middleware";
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
 * Setup and recovery with the setup token (#81, #99): the first operator,
 * created in the console, and an operator's password reset once it is
 * forgotten. Operators are the console's own accounts: Subsonic users neither
 * count as set up nor can be reset here.
 *
 * Both POSTs take `{token, username, password}` and check them in this
 * order, answering with the first refusal:
 *
 * 1. `400 invalid_request`: a body that is not a JSON object of strings;
 * 2. `403 invalid_token`: no usable token configured, or a wrong one.
 *    Nothing past this point is told to a caller without the token;
 * 3. `400 invalid_username`, `400 invalid_password`: see
 *    console-auth/credentials.ts for what is accepted. Setup trims the name
 *    it creates; recovery looks the name up exactly as sign-in does, folded
 *    but not trimmed;
 * 4. what the database says: a token already spent is `403 invalid_token`
 *    as well; setup while an operator exists is `409 already_set_up`;
 *    recovery with no operator is `409 not_set_up`, and of a name no
 *    operator has `400 unknown_user`.
 *
 * Setup answers `201 {id, username}` and recovery `200 {id, username}`, the
 * shape of `GET /api/me`. Neither signs anyone in: the console sends the
 * operator to sign in with the new password.
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

    const { digest, username, password } = form;
    const db = database(c.env);
    const facts = await readSetupFacts(db, digest);
    if (facts.spent) {
      return invalidToken(c);
    }
    if (facts.hasOperators) {
      return alreadySetUp(c);
    }

    let id: string | null;
    try {
      id = await createOperator(
        db,
        c.var.passphrase,
        { username, password },
        {
          // Two setups racing make one operator: the loser's batch writes
          // nothing at all.
          onlyIfFirstOperator: true,
          alongside: (operatorId) => [markSpentFor(db, digest, operatorId)],
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

    return c.json({ id, username }, 201);
  });

  api.post("/setup/reset", requireSameOrigin, limitJsonBody, async (c) => {
    const form = await readForm(c, nameAsTyped);
    if (!("digest" in form)) {
      return form.refusal;
    }

    const { digest, username, password } = form;
    const db = database(c.env);
    const { spent, hasOperators, target } = await readSetupFacts(db, digest, username);
    if (spent) {
      return invalidToken(c);
    }
    if (!hasOperators) {
      return c.json({ error: "not_set_up" }, 409);
    }
    if (target === null) {
      return unknownUser(c);
    }

    let changed: boolean;
    try {
      // Every session of the operator ends: whoever knew the old password is
      // signed out with it. The spent token is conditioned on the operator
      // still being there, like the password, so one deleted since the read
      // leaves the token unspent.
      changed = await setOperatorPassword(db, c.var.passphrase, target.id, password, {
        alongside: [markSpentFor(db, digest, target.id)],
      });
    } catch (error) {
      if (isSpentTokenConflict(error)) {
        return invalidToken(c);
      }
      throw error;
    }
    if (!changed) {
      // Deleted since the read.
      return unknownUser(c);
    }

    return c.json({ id: target.id, username: target.username });
  });
}

type SetupForm =
  | { readonly digest: string; readonly username: string; readonly password: string }
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

  const name = nameRule(username);
  if (name === null) {
    return { refusal: c.json({ error: "invalid_username" }, 400) };
  }
  if (!isAcceptablePassword(password)) {
    return { refusal: c.json({ error: "invalid_password" }, 400) };
  }

  return { digest, username: name, password };
}

/**
 * A name to look up, as typed: sign-in does not trim what it is given either,
 * so recovery finds exactly the operator that name signs in as.
 */
function nameAsTyped(typed: string): string | null {
  return typed.length >= 1 && typed.length <= MAX_USERNAME_LENGTH ? typed : null;
}

function invalidToken(c: Context) {
  return c.json({ error: "invalid_token" }, 403);
}

function unknownUser(c: Context) {
  return c.json({ error: "unknown_user" }, 400);
}

function alreadySetUp(c: Context) {
  return c.json({ error: "already_set_up" }, 409);
}
