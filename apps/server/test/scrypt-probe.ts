/**
 * SPIKE #86 - stands in for `@better-auth/utils/password` under test
 * (vitest.config.ts aliases it here). It forwards to the real `workerd` build,
 * which runs `node:crypto`'s scrypt, and counts every call, so a test can prove
 * Better Auth's default scrypt hasher never ran.
 */

import {
  hashPassword as realHash,
  verifyPassword as realVerify,
} from "../../../node_modules/.pnpm/@better-auth+utils@0.4.2/node_modules/@better-auth/utils/dist/password.node.mjs";

export const scryptProbe = { calls: 0 };

export async function hashPassword(password: string): Promise<string> {
  scryptProbe.calls++;
  return realHash(password);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  scryptProbe.calls++;
  return realVerify(hash, password);
}
