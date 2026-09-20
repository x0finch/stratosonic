import { env } from "cloudflare:test";
import { newRandomId } from "@stratosonic/db";
import { encryptPassword } from "../src/auth/crypto";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { insertUser } from "../src/users/repository";

/**
 * Helpers shared by the tests. The bindings come from vitest.config.ts, which
 * supplies the two Worker secrets the same way the runtime does.
 */

export const BASE = "https://stratosonic.test";

/** The test environment, including the bindings that are secrets in production. */
export const testEnv = env as Env;

export function encryptionKey(): string {
  const key = testEnv.PASSWORD_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("PASSWORD_ENCRYPTION_KEY is missing from the test bindings");
  }

  return key;
}

/** Creates a user with a known password, the way the bootstrap would. */
export async function seedUser(
  userName: string,
  password: string,
  isAdmin = false,
): Promise<string> {
  const id = newRandomId();
  const now = new Date();

  await insertUser(database(testEnv), {
    id,
    userName,
    name: userName,
    password: await encryptPassword(encryptionKey(), password),
    isAdmin,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

/** A `<user>` element as the JSON rendering carries it. */
export interface SubsonicUser {
  username: string;
  email?: string;
  scrobblingEnabled: boolean;
  adminRole: boolean;
  settingsRole: boolean;
  downloadRole: boolean;
  uploadRole: boolean;
  playlistRole: boolean;
  coverArtRole: boolean;
  commentRole: boolean;
  podcastRole: boolean;
  streamRole: boolean;
  jukeboxRole: boolean;
  shareRole: boolean;
  videoConversionRole: boolean;
  folder: number[];
}

export interface JsonEnvelope {
  "subsonic-response": {
    status: string;
    version: string;
    type: string;
    serverVersion: string;
    openSubsonic: boolean;
    error?: { code: number; message: string };
    license?: { valid: boolean };
    openSubsonicExtensions?: { name: string; versions: number[] }[];
    user?: SubsonicUser;
    users?: { user: SubsonicUser[] };
  };
}
