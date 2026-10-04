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
  // The server answers `invalid_token` for a mistyped token and for a spent
  // one alike, and must not say which, so one message covers both: the
  // likelier mistype first, then the spent token.
  invalid_token: {
    title: "The setup token is not valid",
    description:
      "Check the token and paste it again. Each token works once: if this one has been used already, set a new one with wrangler secret put SETUP_TOKEN.",
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
    description: "Sign in with your console account instead.",
  },
  invalid_username: {
    title: "The username is not valid",
    description: `Use 1 to ${MAX_USERNAME_LENGTH} characters, not only spaces.`,
  },
  invalid_password: {
    title: "The password is not valid",
    description: `Use 1 to ${MAX_PASSWORD_LENGTH.toLocaleString("en")} characters.`,
  },
  // The Subsonic users API's (#82). A username is unique in any mix of case,
  // as Navidrome's is; the last two keep one Subsonic admin, which library
  // scans, the playlist import and the admin-only Subsonic endpoints need.
  username_taken: {
    title: "The username is taken",
    description: "Another Subsonic user has it, in some mix of upper and lower case.",
  },
  last_admin: {
    title: "This is the last Subsonic admin",
    description:
      "Library scans and the playlist import need one. Make another user a Subsonic admin first.",
  },
  admin_required: {
    title: "The first Subsonic user must be a Subsonic admin",
    description:
      "There is no Subsonic admin yet, and library scans and the playlist import need one. Turn on Subsonic admin.",
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
  // The Files API's (#83). Keys and prefixes come from a listing, so a
  // refused one most often means the bucket changed since it was read.
  invalid_path: {
    title: "The path is not valid",
    description:
      "A folder ends in a slash, and no path is over 1,024 bytes. Reload this page and try again.",
  },
  reserved_path: {
    title: "That path is the scanner's own",
    description:
      "The scanner keeps the covers it extracts in _covers/, and nothing there can be changed.",
  },
  file_writes_disabled: {
    title: "Files are read-only here",
    description:
      "This deployment, the preview, browses the bucket but cannot change it. Use the production console.",
  },
  invalid_cursor: {
    title: "The folder changed while it was open",
    description: "It is shown again from its first page.",
  },
  uploads_not_configured: {
    title: "Uploads are not configured",
    description: "Uploads need R2 API credentials on the server (see the server README).",
  },
  type_not_allowed: {
    title: "That type of file is not accepted",
    description: "Upload audio, lyrics, playlists or images, which the server reads.",
  },
  too_large: {
    title: "The file is too large",
    description: "It is over the largest size the server takes for its type.",
  },
  empty_file: {
    title: "The file is empty",
    description: "An empty file holds nothing the server can read.",
  },
  exists: {
    title: "The file already exists",
    description: "Upload it again to replace it.",
  },
  replace_unavailable: {
    title: "The file cannot be replaced from here",
    description:
      "The server could not tell for certain how the bucket spells its name. Replace it with rclone, which writes the name as you give it.",
  },
  path_too_long: {
    title: "The path is too long",
    description: "A path is at most 1,024 bytes, and each name in it at most 255.",
  },
  // The Libraries API's (#84). A library's name is what Subsonic clients show
  // in their folder picker, unique in any mix of case, as Navidrome's is.
  name_taken: {
    title: "The name is taken",
    description: "Another library has it, in some mix of upper and lower case.",
  },
  already_connected: {
    title: "The bucket is already connected",
    description: "It is a library already, or the bucket the Worker is bound to.",
  },
  invalid_account_id: {
    title: "The account ID is not valid",
    description:
      "It is 32 characters of 0-9 and a-f, as the Cloudflare dashboard shows it beside R2.",
  },
  invalid_bucket: {
    title: "The bucket name is not valid",
    description:
      "An R2 bucket name is 3 to 63 lowercase letters, digits and hyphens, and starts and ends with a letter or digit.",
  },
  default_library: {
    title: "Library 1 cannot be changed that way",
    description:
      "It is the bucket the Worker is bound to: it cannot be removed, and only its name and its default for new users change.",
  },
  removing: {
    title: "The library is being removed",
    description: "The scan is deleting its tracks and albums, so it cannot be changed any more.",
  },
  forbidden: {
    title: "Your role does not allow that",
    description: "Sign in with a console account whose role allows it.",
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

/**
 * Why the usage panel has no numbers: `GET /api/usage` answers
 * `analytics_unavailable` with a `reason` (#82, "API: usage panel"). The
 * server caches each failure, and the panel asks again in five minutes.
 */
const ANALYTICS_REASONS: Record<"unauthorized" | "rate_limited" | "upstream", ErrorMessage> = {
  unauthorized: {
    title: "Cloudflare refused the analytics token",
    description:
      "Check that CF_ANALYTICS_TOKEN has Account Analytics Read for the account CF_ACCOUNT_ID names, then set it again with wrangler secret put.",
  },
  rate_limited: {
    title: "Cloudflare's analytics are rate limited",
    description: "Too many queries reached the GraphQL Analytics API. The panel tries again later.",
  },
  upstream: {
    title: "Cloudflare's analytics did not answer",
    description: "The GraphQL Analytics API failed. The panel tries again later.",
  },
};

/**
 * Why a bucket could not be reached (#84): a connect or a connection test
 * that failed (`connection_failed {reason}`), or a library the last scan
 * skipped (`lastScanError`). The titles are the Libraries page's "Scan
 * failed" tooltips.
 */
const CONNECTION_FAILURES: Record<
  "auth" | "bucket_not_found" | "throttled" | "unavailable",
  ErrorMessage
> = {
  auth: {
    title: "The key was refused",
    description:
      "Check the Access Key ID and the Secret Access Key, and that the token has Object Read & Write on this bucket.",
  },
  bucket_not_found: {
    title: "The bucket was not found",
    description: "Check the bucket's name, and that the account ID is the account that owns it.",
  },
  throttled: {
    title: "The bucket is busy",
    description: "R2 asked for fewer requests. Try again in a moment.",
  },
  unavailable: {
    title: "The bucket did not answer",
    description: "R2 could not be reached, or answered with an error. Try again in a moment.",
  },
};

/**
 * Why a bucket could not be reached, in words. A reason this console does
 * not know yet reads as a bucket that did not answer.
 */
export function describeConnectionFailure(reason: string | null | undefined): ErrorMessage {
  return reason && Object.hasOwn(CONNECTION_FAILURES, reason)
    ? CONNECTION_FAILURES[reason as keyof typeof CONNECTION_FAILURES]
    : CONNECTION_FAILURES.unavailable;
}

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

  if (error.code === "analytics_unavailable") {
    const reason = error.reason ?? "";
    // A reason this console does not know yet is still a failure upstream.
    return Object.hasOwn(ANALYTICS_REASONS, reason)
      ? ANALYTICS_REASONS[reason as keyof typeof ANALYTICS_REASONS]
      : ANALYTICS_REASONS.upstream;
  }

  if (error.code === "connection_failed") {
    return describeConnectionFailure(error.reason);
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
