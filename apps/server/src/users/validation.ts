/**
 * What a name and a password must be, for both kinds of account (#82): a
 * console user (console-auth/credentials.ts) and a Subsonic user
 * (api/subsonic-users.ts) take the same rule, so a name or a password the
 * console accepts for one is never refused for the other.
 *
 * Navidrome sets no rule beyond a name and a password being there (its
 * `createAdmin` takes any string, and its UI, `ui/src/user/UserCreate.jsx`,
 * marks both fields required), so nothing narrower is imposed.
 */

/**
 * The shortest and longest password accepted. The upper bound only keeps a
 * request from making the server hash, encrypt or compare an arbitrarily
 * large string: at 1,024 characters one console HMAC still costs about a
 * tenth of a millisecond (scripts/bench-console-auth.ts), and one Subsonic
 * AES-GCM encryption microseconds (ADR-0003). Better Auth enforces both on
 * a console sign-in (console-auth/auth.ts); the routes that set a password
 * check them before calling a writer.
 */
export const MIN_PASSWORD_LENGTH = 1;
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * The longest name accepted, which is also the longest the console's
 * username plugin lets sign in (console-auth/auth.ts).
 */
export const MAX_USERNAME_LENGTH = 255;

/** Whether a password is one the routes that set a password accept. It is never trimmed. */
export function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

/**
 * The name an account gets from what was typed, or `null` if there is none.
 *
 * Whitespace around the name is dropped, since a name that ends in a space
 * would look the same as one that does not and never be typed right again,
 * and the result must be 1 to `MAX_USERNAME_LENGTH` characters.
 */
export function acceptableUserName(typed: string): string | null {
  const userName = typed.trim();
  return userName.length >= 1 && userName.length <= MAX_USERNAME_LENGTH ? userName : null;
}
