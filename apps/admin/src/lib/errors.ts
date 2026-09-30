import { ApiError } from "@/lib/api";

/** An error as the console shows it: a short title and what to do about it. */
export interface ErrorMessage {
  title: string;
  description: string;
}

/** The server's limits (#81): the username plugin's and the credential writer's. */
export const MAX_USERNAME_LENGTH = 255;
export const MAX_PASSWORD_LENGTH = 1024;

const MESSAGES: Record<string, ErrorMessage> = {
  invalid_credentials: {
    title: "Wrong username or password",
    description: "Check them and try again. Use your console account, not a Subsonic login.",
  },
  invalid_token: {
    title: "The setup token is not valid",
    description:
      "It is wrong, or it has been used already: each token works once. Set a new one with wrangler secret put SETUP_TOKEN and try again.",
  },
  wrong_password: {
    title: "The current password is wrong",
    description: "Enter the password you signed in with.",
  },
  unauthenticated: {
    title: "You are signed out",
    description: "Your session has ended. Sign in again.",
  },
  not_configured: {
    title: "The server is not configured",
    description:
      "PASSWORD_ENCRYPTION_KEY is not set on the Worker. Set it with wrangler secret put PASSWORD_ENCRYPTION_KEY, then reload this page.",
  },
  insecure_origin: {
    title: "The console needs HTTPS",
    description:
      "It refuses plain http outside localhost, where the session would travel in the clear. Open it over https:// instead.",
  },
  forbidden_origin: {
    title: "The request was refused",
    description: "It did not come from the console's own origin. Reload this page and try again.",
  },
  already_set_up: {
    title: "The server is already set up",
    description: "Sign in instead, or reset the owner's password with a new setup token.",
  },
  not_set_up: {
    title: "There is no owner yet",
    description: "Set up the server with the setup token instead.",
  },
  unknown_user: {
    title: "There is no console user by that name",
    description: "Enter the owner's username.",
  },
  invalid_username: {
    title: "The username is not valid",
    description: `Use 1 to ${MAX_USERNAME_LENGTH} characters, not only spaces.`,
  },
  invalid_password: {
    title: "The password is not valid",
    description: `Use 1 to ${MAX_PASSWORD_LENGTH.toLocaleString("en")} characters.`,
  },
  password_too_long: {
    title: "The password is too long",
    description: `Use at most ${MAX_PASSWORD_LENGTH.toLocaleString("en")} characters.`,
  },
  invalid_request: {
    title: "The request was not understood",
    description: "Reload this page and try again.",
  },
  payload_too_large: {
    title: "The request is too large",
    description: "Shorten what you entered and try again.",
  },
  not_found: {
    title: "Not found",
    description: "The server has nothing at this address. Reload this page and try again.",
  },
  internal: {
    title: "The server failed",
    description: "Something went wrong on the server. Try again in a moment.",
  },
  network: {
    title: "The server could not be reached",
    description: "Check the connection and try again.",
  },
};

/** What to tell the user about a failed call. */
export function describeError(error: unknown): ErrorMessage {
  if (!(error instanceof ApiError)) {
    return {
      title: "Something went wrong",
      description: error instanceof Error ? error.message : "Try again.",
    };
  }

  if (error.code === "rate_limited") {
    const wait =
      error.retryAfter === undefined
        ? "a minute"
        : `${error.retryAfter} second${error.retryAfter === 1 ? "" : "s"}`;
    return { title: "Too many attempts", description: `Wait ${wait} and try again.` };
  }

  const known = MESSAGES[error.code];
  if (known) {
    return known;
  }

  // A code this console does not know yet: the server's own words, if any.
  return {
    title: "Something went wrong",
    description:
      error.message && error.message !== error.code
        ? error.message
        : `The server answered ${error.status} (${error.code}). Try again.`,
  };
}
