/**
 * A headless Chromium walkthrough of the console (#91, #119), against
 * a running Worker:
 *
 *   BASE_URL=http://localhost:8787 SETUP_TOKEN=… \
 *     pnpm --filter @stratosonic/admin walkthrough
 *
 * Not part of the test suite or CI. It needs a Worker serving the built
 * console (`pnpm --filter @stratosonic/server dev`) on a database with no
 * console user and `SETUP_TOKEN` set, or, for a database that already has its
 * owner, `OWNER_USER` and `OWNER_PASSWORD` for it (the first-run setup is
 * skipped). Chromium comes from Playwright's browser cache
 * (`PLAYWRIGHT_BROWSERS_PATH`, or `playwright-core install chromium`).
 *
 * Console users are the console's own accounts, separate from Subsonic users
 * (#99), so every Subsonic `ping` with the owner's credentials must fail with
 * error 40, by `p=` and by token. With `SUBSONIC_USER` and
 * `SUBSONIC_PASSWORD` (the `INITIAL_*` Subsonic user, say) it also checks
 * that the Subsonic user cannot sign in to the console, and that its `ping`
 * stays ok through every change of the owner's password.
 *
 * It walks, in order: the router guard, which sends a deep link to
 * `/login?redirect=…` and the overview to plain `/login`; first-run setup,
 * with a wrong token and a mismatched confirmation on the way, then the first
 * sign-in;
 * sign-out and sign-in; a wrong password, and a Subsonic user's; a set-up
 * server, whose screens offer neither setup nor a password reset (the setup
 * token only sets the server up, #105); a deep link opened while signed out,
 * which sign-in returns to; the account page's validation, where a wrong
 * current password's error goes once that field changes and at the next
 * submit, and a password change, after which a Subsonic `ping` with neither
 * password is ok; signing out from the account page, which lands on plain
 * `/login` and signs in to the overview; a session that ends while on a page,
 * which sign-in returns to; the Overview (#82), whose usage panel is absent
 * from a server without an analytics token, and whose **Scan now** starts a
 * pass that the page follows to its end, when it reads the library again
 * (within `SCAN_TIMEOUT` seconds, 120 by default: give the Worker a small
 * library, such as the fixture files, in its bucket); dark mode, on the
 * account page, the sign-in screen and the Overview; and a phone-sized
 * viewport, where neither the account page nor the Overview scrolls
 * sideways. It signs in more often than the server's limit of 5 a minute
 * allows, so it meets the rate limit's message on the way, and waits it out.
 *
 * What a form did, or why it failed, is a toast (#101): the walkthrough waits
 * for a new one, in the toaster's live region, with the expected words.
 * Field-level validation stays beside its field, so it checks no toast
 * repeats it.
 *
 * The Subsonic users page (`/users`, #82, #118) is walked after the password
 * change: it adds a Subsonic user and pings with it (adding a Subsonic admin
 * first when there is none, with the switch locked on), refuses a taken name
 * beside its field, sets the user's password (the old one then answers error
 * 40 and the new one ok), renames it (likewise for the old and new names),
 * tries to demote and to delete the last Subsonic admin and sees the refusal
 * toasts, and deletes the user, once it owns a playlist made with
 * `createPlaylist` that the confirmation counts, whose ping then answers
 * error 40. Its users are named `walkthrough-…`, so the database must not
 * have those yet.
 *
 * The Files page (`/files`, #83 ticket D) is walked in a scratch folder of
 * the bucket, `FILES_PREFIX` (`walkthrough-files/` by default), which the
 * run deletes from: it must hold a file of its own (so that it outlives the
 * run) and a subfolder `album/` with at least two files. Without it at the
 * bucket's root, the Files steps are skipped. The walkthrough browses into
 * the folder and `album/` and back, by the path and by the browser's back
 * button; refuses a New folder name beside its field and opens a new one,
 * empty, writing nothing; deletes one file of `album/` through the dialog,
 * which says the delete cannot be undone, and sees the toast and the scan
 * line; and deletes `album/` itself. On a server with `FILE_WRITES = "off"`
 * (the preview) it instead checks that the page shows no write control and
 * that the server refuses a delete (`file_writes_disabled`), and deletes
 * nothing.
 *
 * Uploads (#83 ticket E) need a real bucket: a presigned `PUT` goes to R2's
 * S3 endpoint, which a local `wrangler dev` bucket does not have. So they
 * run only against a Worker with R2 API credentials whose bucket is a
 * scratch bucket named in `UPLOADS_BUCKET` (and the CORS rule for
 * `BASE_URL`'s origin, apps/server README "File uploads"), and are skipped
 * otherwise. In `FILES_PREFIX` they upload a folder (two FLACs, their
 * `.lrc` and a cover, from the server's test fixtures), seeing the toast,
 * the scan line, the header's Uploads trigger ("Uploads done") and one row
 * a file in its popover; upload one of its files again, which already
 * exists ("1 needs attention"), and replace it from the popover; and
 * delete the folder again. On any Worker with uploads configured (fake
 * credentials will do), they pick a `.pdf` and see it refused before any
 * request: the trigger says "1 needs attention" while the popover stays
 * closed and the folder stays the page's one block, the keyboard opens the
 * popover, Escape closes it with focus back on the trigger, and Clear
 * finished takes the trigger away with focus on Upload. Each step's note
 * gives the requests its run made (sign, complete and `PUT`), for the
 * budget. Signing out from the Files page then reads nothing more from the
 * files API (#141).
 *
 * Any console error or uncaught exception on a page fails the walkthrough,
 * except the browser's own "Failed to load resource" line for a response the
 * console expects to be refused (a 401 from `/api/me` while signed out, the
 * 4xx of a refused form). Set `SCREENSHOTS` to a directory to keep a
 * screenshot of each step there.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const SETUP_TOKEN = process.env.SETUP_TOKEN;
const USERNAME = process.env.OWNER_USER ?? "owner";
const SUBSONIC_USER = process.env.SUBSONIC_USER;
const SUBSONIC_PASSWORD = process.env.SUBSONIC_PASSWORD;
const SCREENSHOTS = process.env.SCREENSHOTS;
/** The bucket's scratch folder the Files steps browse and delete from. */
const FILES_PREFIX = process.env.FILES_PREFIX ?? "walkthrough-files/";
/**
 * The bucket the Worker binds, when it is a real scratch bucket that may be
 * uploaded to: the upload steps run only when this names it and the Worker
 * has R2 API credentials (`GET /api/files/config`). A presigned `PUT` goes to
 * R2's S3 endpoint, which `wrangler dev`'s local bucket (miniflare) does not
 * have, so these steps need a deployment (or `wrangler dev --remote`) on a
 * scratch bucket with the CORS rule for the console's origin.
 */
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET;
/** How long a pass started with Scan now may take to finish, in seconds. */
const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT ?? 120) * 1000;

const passwords = {
  first: process.env.OWNER_PASSWORD ?? "first-run password",
  changed: "changed in the console",
};

/** The refused responses the walkthrough expects, by path. */
const EXPECTED_REFUSALS = {
  "/api/me": [401],
  "/api/auth/sign-in/username": [401, 429],
  "/api/setup": [403],
  "/api/account/password": [400, 401],
  // A taken name, and the last Subsonic admin's demotion and deletion.
  "/api/subsonic-users": [409],
  "/api/subsonic-users/:id": [409],
  // A delete the preview refuses (`file_writes_disabled`).
  "/api/files/delete": [403],
};

/** A path as `EXPECTED_REFUSALS` names it: one Subsonic user's as `:id`. */
function refusalPath(path) {
  return path.replace(/^\/api\/subsonic-users\/[^/]+$/, "/api/subsonic-users/:id");
}

const results = [];
const consoleErrors = [];
/** The page the last step worked in, for a screenshot of a failure. */
let lastPage;
/** The error a step failed with, which that step has already printed. */
let stepFailure;
/** How often sign-in hit the rate limit. */
let rateLimited = 0;

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Runs one step. It may answer "skipped", or a note on what it left out,
 * which is printed beside it.
 */
async function step(name, run) {
  try {
    const note = await run();
    const skipped = note === "skipped";
    results.push({ name, outcome: skipped ? "skipped" : "ok" });
    console.log(`${skipped ? "-" : "✓"} ${name}${note ? ` (${note})` : ""}`);
  } catch (error) {
    results.push({ name, outcome: "failed" });
    if (SCREENSHOTS) {
      await lastPage?.screenshot({ path: join(SCREENSHOTS, "failure.png") }).catch(() => {});
    }
    console.log(`✗ ${name}\n    ${error instanceof Error ? error.message : error}`);
    stepFailure = error;
    throw error;
  }
}

/** The path a response answers. */
function pathOf(response) {
  return new URL(response.url()).pathname;
}

async function setupState() {
  const response = await fetch(`${BASE_URL}/api/setup`);
  return response.ok ? (await response.json()).state : `http_${response.status}`;
}

/**
 * What a Subsonic `ping` answers with these credentials, by `p=` and by token
 * (`t` = md5(password + salt)): "ok", or the error code. Both must agree.
 */
async function ping(username, password) {
  const salt = "walk5a17";
  const token = createHash("md5")
    .update(password + salt)
    .digest("hex");
  const answers = [];
  for (const credentials of [{ p: password }, { t: token, s: salt }]) {
    const query = new URLSearchParams({ u: username, v: "1.16.1", c: "walkthrough", f: "json" });
    for (const [name, value] of Object.entries(credentials)) {
      query.set(name, value);
    }
    const body = (await (await fetch(`${BASE_URL}/rest/ping?${query}`)).json())[
      "subsonic-response"
    ];
    answers.push(body.status === "ok" ? "ok" : body.error?.code);
  }
  check(answers[0] === answers[1], `ping by p= answered ${answers[0]}, by token ${answers[1]}`);
  return answers[0];
}

/** Creates an empty playlist as a Subsonic user, through `/rest/createPlaylist`. */
async function createPlaylist(username, password, name) {
  const query = new URLSearchParams({
    u: username,
    p: password,
    v: "1.16.1",
    c: "walkthrough",
    f: "json",
    name,
  });
  const body = (await (await fetch(`${BASE_URL}/rest/createPlaylist?${query}`)).json())[
    "subsonic-response"
  ];
  check(body.status === "ok", `createPlaylist as ${username} answered ${JSON.stringify(body)}`);
}

/** That Subsonic refuses the owner's console credentials, as a wrong password. */
async function checkOwnerCannotPing(password) {
  const answer = await ping(USERNAME, password);
  check(answer === 40, `Subsonic ping with the owner's credentials answered ${answer}, not 40`);
}

/** That the Subsonic user, when there is one to check, still pings. */
async function checkSubsonicUserPings() {
  if (SUBSONIC_USER && SUBSONIC_PASSWORD) {
    const answer = await ping(SUBSONIC_USER, SUBSONIC_PASSWORD);
    check(answer === "ok", `Subsonic ping as ${SUBSONIC_USER} answered ${answer}`);
  }
}

function watch(page, label) {
  lastPage = page;
  page.on("console", (message) => {
    if (message.type() !== "error") {
      return;
    }
    const text = message.text();
    // Chromium reports every 4xx response on the console. The refusals the
    // walkthrough provokes, and the signed-out `/api/me`, are the console's
    // to handle; any other is an error.
    const status = /^Failed to load resource: the server responded with a status of (\d+)/.exec(
      text,
    )?.[1];
    const path = new URL(message.location().url || BASE_URL).pathname;
    if (status && EXPECTED_REFUSALS[refusalPath(path)]?.includes(Number(status))) {
      return;
    }
    consoleErrors.push(`${label}: ${text} (${path})`);
  });
  page.on("pageerror", (error) => consoleErrors.push(`${label}: ${error.message}`));
}

async function shot(page, name) {
  if (SCREENSHOTS) {
    // A toast slides in, its transition starting a frame or two after it
    // mounts: catch it where it comes to rest. A transition that is replaced
    // rejects `finished`, which is as good as settled here.
    await page.evaluate(async (selector) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const animations = [...document.querySelectorAll(selector)].flatMap((element) =>
        element.getAnimations({ subtree: true }),
      );
      await Promise.allSettled(animations.map((animation) => animation.finished));
    }, TOAST);
    await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`), fullPage: true });
  }
}

/**
 * Signs in on the sign-in screen. The walkthrough signs in more often than
 * the server's limit of 5 a minute, so a 429 is met with its message on the
 * screen, then a wait and another try.
 */
async function signIn(page, password, { expectAt, username = USERNAME } = {}) {
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  for (;;) {
    await markToasts(page);
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-in/username")),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    if (response.status() !== 429) {
      break;
    }
    await expectToast(page, "Too many attempts");
    rateLimited += 1;
    const wait = Number(response.headers()["x-retry-after"] ?? 60) + 1;
    console.log(`  sign-in rate limited, as shown on the screen; retrying in ${wait} s`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
  if (expectAt) {
    await page.waitForURL((url) => url.pathname === expectAt);
  }
}

/** A toast inside the toaster's live region, which announces it. */
const TOAST = '[role="region"][aria-live] [data-slot="toast"]';

/** Marks the toasts already on screen, before an action that raises one. */
async function markToasts(page) {
  await page.locator(TOAST).evaluateAll((elements) => {
    for (const element of elements) {
      element.setAttribute("data-walkthrough-seen", "");
    }
  });
}

/** Waits for a toast raised since `markToasts` that has every one of `texts`. */
async function expectToast(page, ...texts) {
  let toast = page.locator(`${TOAST}:not([data-walkthrough-seen])`);
  for (const text of texts) {
    toast = toast.filter({ hasText: text });
  }
  await toast.first().waitFor();
}

/** That no toast repeats what a field says beside it. */
async function checkNoToast(page, text) {
  const count = await page.locator(TOAST).filter({ hasText: text }).count();
  check(count === 0, `a toast repeats the field's "${text}"`);
}

/**
 * That a page of one block has no h2: the header's h1 names it (#128). The
 * h1 is the breadcrumb's page, a heading by its role.
 */
async function checkNoSectionHeading(page, what) {
  const headings = await page.getByRole("heading").allTextContents();
  check(
    (await page.getByRole("heading", { level: 2 }).count()) === 0,
    `${what} has a section heading: ${JSON.stringify(headings)}`,
  );
}

/** That the sidebar lists only the pages that exist, with no placeholders (#128). */
async function checkSidebarEntries(page) {
  const sidebar = page.locator('[data-slot="sidebar-content"]');
  await sidebar.getByRole("link", { name: "Overview" }).waitFor();
  const entries = await sidebar.locator('[data-sidebar="menu-button"]').allTextContents();
  check(
    JSON.stringify(entries) === JSON.stringify(["Overview", "Users", "Files"]),
    `the sidebar lists ${JSON.stringify(entries)}`,
  );
  const disabled = await sidebar.locator('[data-sidebar="menu-button"]:disabled').count();
  check(disabled === 0, `the sidebar has ${disabled} disabled entries`);
}

async function openUserMenu(page) {
  await page.getByRole("button", { name: new RegExp(USERNAME) }).click();
}

/**
 * Signs out through the user menu, which lands on plain `/login`: a
 * deliberate sign-out leaves no page for the next sign-in to return to.
 */
async function signOut(page) {
  await openUserMenu(page);
  await clickSignOut(page);
}

/** Clicks "Sign out" in the open user menu, and checks where it lands. */
async function clickSignOut(page) {
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/login");
  const { search } = new URL(page.url());
  check(search === "", `signing out landed on /login${search}`);
}

/** The Subsonic users the walkthrough adds, and the passwords it gives them. */
const subsonic = {
  admin: { username: "walkthrough-admin", password: "walkthrough admin password" },
  user: { username: "walkthrough-user", password: "walkthrough first password" },
  changedPassword: "walkthrough second password",
  renamed: "walkthrough-renamed",
};

/** The Subsonic users as the console's own API lists them, with the page's session. */
async function listSubsonicUsers(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/subsonic-users");
    return (await response.json()).users;
  });
}

/** That a Subsonic `ping` with these credentials answers `expected`. */
async function checkPing(username, password, expected) {
  const answer = await ping(username, password);
  check(answer === expected, `Subsonic ping as ${username} answered ${answer}, not ${expected}`);
}

/** Opens a row's menu on the Subsonic users page and picks one of its items. */
async function userAction(page, username, item) {
  await page.getByRole("button", { name: `Actions for ${username}`, exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/**
 * The open dialog (or alert dialog), and that it has closed. By its slot: a
 * toast is a dialog too, to assistive technology.
 */
function dialog(page) {
  return page.locator('[data-slot="dialog-content"], [data-slot="alert-dialog-content"]');
}

async function dialogClosed(page) {
  await dialog(page).waitFor({ state: "detached" });
}

/**
 * Adds a Subsonic user through the create dialog. `admin` is whether the
 * **Subsonic admin** switch should end up on; `locked`, whether it must be
 * locked on (no Subsonic admin exists); `screenshot`, a name for a screenshot
 * of the filled dialog.
 */
async function addSubsonicUser(page, { username, password }, { admin, locked, screenshot }) {
  await page.getByRole("button", { name: "Add user" }).click();
  const form = dialog(page);
  await form.getByLabel("Username", { exact: true }).fill(username);
  await form.getByLabel("Password", { exact: true }).fill(password);
  const toggle = form.getByRole("switch", { name: "Subsonic admin" });
  check((await toggle.isDisabled()) === locked, `the Subsonic admin switch is locked: ${!locked}`);
  if ((await toggle.isChecked()) !== admin) {
    await toggle.click();
  }
  check((await toggle.isChecked()) === admin, "the Subsonic admin switch did not change");
  if (screenshot) {
    await shot(page, screenshot);
  }
  await markToasts(page);
  await form.getByRole("button", { name: "Add user" }).click();
  await expectToast(page, "Subsonic user created", `${username} can now sign in`);
  await dialogClosed(page);
  await page.getByRole("cell", { name: username, exact: true }).waitFor();
}

/** The Files page's folder, by its prefix: the root for `""`. */
function filesUrl(prefix) {
  return `${BASE_URL}/files${prefix === "" ? "" : `?prefix=${encodeURIComponent(prefix)}`}`;
}

/** One folder as `GET /api/files` lists it, with the page's session. */
async function listFolder(page, prefix) {
  return page.evaluate(async (prefix) => {
    const response = await fetch(`/api/files?prefix=${encodeURIComponent(prefix)}`);
    return response.json();
  }, prefix);
}

/** What `GET /api/files/config` says, with the page's session. */
async function filesConfig(page) {
  return page.evaluate(async () => (await fetch("/api/files/config")).json());
}

/**
 * That the Files page shows the folder `prefix`: its URL, and the folder
 * path's current page (`aria-current="page"`), which names the folder (the
 * bucket at the root). The folder is the page's one block, so it has no h2.
 */
async function inFolder(page, prefix) {
  await page.waitForURL((url) => (url.searchParams.get("prefix") ?? "") === prefix);
  const name = prefix.split("/").at(-2);
  const current = folderPath(page).locator('[aria-current="page"]');
  await (name === undefined ? current : current.getByText(name, { exact: true })).waitFor();
}

/** The folder path above the table. */
function folderPath(page) {
  return page.getByRole("navigation", { name: "Folder path" });
}

/** Picks files through the page's Upload menu ("Files…" or "Folder…") and the file chooser. */
async function pick(page, item, paths) {
  await page.getByRole("button", { name: "Upload", exact: true }).first().click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: item }).click();
  await (await chooser).setFiles(paths);
}

/**
 * The header's Uploads trigger (#141), on every page while the upload queue
 * holds a file: with these words, or whatever its words.
 */
function uploadsTrigger(page, label) {
  return page.getByRole("button", {
    name: label ?? /^(Uploading [\d,]+ of [\d,]+|[\d,]+ needs? attention|Uploads done)$/,
    exact: true,
  });
}

/** The upload list, in the popover the trigger opens. */
function uploadsPopover(page) {
  return page.getByRole("dialog", { name: "Uploads" });
}

/** Clear finished in the Uploads popover, when there is a queue: the trigger goes. */
async function clearUploads(page) {
  if ((await uploadsTrigger(page).count()) === 0) {
    return;
  }
  await uploadsTrigger(page).click();
  await uploadsPopover(page).getByRole("button", { name: "Clear finished" }).click();
  await uploadsTrigger(page).waitFor({ state: "detached" });
}

/**
 * Counts the requests an upload run makes from now on: sign and complete
 * requests to the Worker, and `PUT`s to R2. A CORS preflight is not a
 * request Playwright reports; there is one before each `PUT`, since a
 * browser caches a preflight by its full URL and every presigned URL
 * differs.
 */
function countUploadRequests(page) {
  const counted = { sign: 0, complete: 0, put: 0, files: 0 };
  page.on("request", (request) => {
    const path = pathOf(request);
    if (path === "/api/files/uploads") {
      counted.sign++;
      counted.files += JSON.parse(request.postData() ?? "{}").files?.length ?? 0;
    } else if (path === "/api/files/uploads/complete") {
      counted.complete++;
    } else if (
      request.method() === "PUT" &&
      new URL(request.url()).host.endsWith(".r2.cloudflarestorage.com")
    ) {
      counted.put++;
    }
  });
  counted.note = () =>
    `${counted.sign} sign request(s) for ${counted.files} file(s), ${counted.put} PUT(s), ` +
    `${counted.complete} complete request(s)`;
  return counted;
}

/** The scan line's sentences (#83, "Layout", item 2). */
const SCAN_LINE =
  /Library scan in about (a minute|\d+ minutes)\.|Library scan starting\.|A scan is running\./;

async function main() {
  if (SCREENSHOTS) {
    mkdirSync(SCREENSHOTS, { recursive: true });
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  watch(page, "desktop");

  const initialState = await setupState();
  console.log(`GET /api/setup: ${initialState}`);
  let password = passwords.first;
  if (!SUBSONIC_USER || !SUBSONIC_PASSWORD) {
    console.log("SUBSONIC_USER / SUBSONIC_PASSWORD unset: the Subsonic user's checks are skipped");
  }

  try {
    await step("a signed-out visit to a shell page goes to /login?redirect=…", async () => {
      await page.goto(`${BASE_URL}/account`);
      await page.waitForURL((url) => url.pathname === "/login");
      const url = new URL(page.url());
      check(url.searchParams.get("redirect") === "/account", `redirect is ${url.search}`);
      await page.getByRole("button", { name: "Sign in" }).waitFor();
      await shot(page, "login");
    });

    await step("a signed-out visit to the overview goes to plain /login", async () => {
      await page.goto(`${BASE_URL}/`);
      await page.waitForURL((url) => url.pathname === "/login");
      const { search } = new URL(page.url());
      check(search === "", `the overview went to /login${search}`);
      await page.getByRole("button", { name: "Sign in" }).waitFor();
      await shot(page, "login-from-overview");
    });

    await step("first-run setup", async () => {
      if (initialState !== "needs-setup") {
        return "skipped";
      }
      check(SETUP_TOKEN, "the database has no console user: set SETUP_TOKEN");
      await page.goto(`${BASE_URL}/login`);
      await page.getByRole("link", { name: "Set up the server" }).click();
      await page.waitForURL((url) => url.pathname === "/setup");

      const fill = async (token, confirm) => {
        await page.getByLabel("Setup token", { exact: true }).fill(token);
        await page.getByLabel("Username", { exact: true }).fill(USERNAME);
        await page.getByLabel("Password", { exact: true }).fill(password);
        await page.getByLabel("Confirm password", { exact: true }).fill(confirm);
        await markToasts(page);
        await page.getByRole("button", { name: "Create owner account" }).click();
      };

      await fill(SETUP_TOKEN, `${password} (typo)`);
      await page.getByText("The passwords do not match.").waitFor();
      await checkNoToast(page, "The passwords do not match");

      await fill(`${SETUP_TOKEN}-wrong`, password);
      // A mistype and a spent token are one answer: check it first, then renew.
      await expectToast(
        page,
        "The setup token is not valid",
        "Check the token and paste it again. Each token works once: if this one has been used already, set a new one",
      );
      await shot(page, "setup-invalid-token");

      // The toast is raised before the navigation, and outlives it.
      await fill(SETUP_TOKEN, password);
      await page.waitForURL((url) => url.pathname === "/login");
      await expectToast(
        page,
        "The owner account is created",
        "Sign in with its username and password.",
      );
      check(
        new URL(page.url()).search === "",
        `setup landed on /login${new URL(page.url()).search}`,
      );
      check((await setupState()) === "closed", "the setup token is not spent");
      await checkOwnerCannotPing(password);
      await checkSubsonicUserPings();
      await shot(page, "login-after-setup");
      await signIn(page, password, { expectAt: "/" });
      const menu = page.getByRole("button", { name: new RegExp(USERNAME) });
      await menu.waitFor();
      const label = await menu.textContent();
      check(label?.includes("Owner"), `the user menu says ${label}, not the role Owner`);
      await shot(page, "overview");
    });

    await step("sign-out, then sign-in", async () => {
      if (new URL(page.url()).pathname !== "/") {
        await page.goto(`${BASE_URL}/login`);
        await signIn(page, password, { expectAt: "/" });
      }
      await signOut(page);
      const me = await page.evaluate(() => fetch("/api/me").then((response) => response.status));
      check(me === 401, `GET /api/me answers ${me} after sign-out`);
      await signIn(page, password, { expectAt: "/" });
    });

    await step("a wrong password is refused, in words", async () => {
      await signOut(page);
      await signIn(page, `${password} (wrong)`);
      await expectToast(page, "Wrong username or password");
      check(new URL(page.url()).pathname === "/login", "left /login on a wrong password");
      await shot(page, "login-wrong-password");
    });

    await step("a Subsonic user cannot sign in to the console", async () => {
      if (!SUBSONIC_USER || !SUBSONIC_PASSWORD) {
        return "skipped";
      }
      await page.goto(`${BASE_URL}/login`);
      await signIn(page, SUBSONIC_PASSWORD, { username: SUBSONIC_USER });
      await expectToast(page, "Wrong username or password");
      check(new URL(page.url()).pathname === "/login", "a Subsonic user left /login");
      await checkSubsonicUserPings();
    });

    await step("a set-up server offers neither setup nor a password reset", async () => {
      check((await setupState()) === "closed", "GET /api/setup is not closed");
      await page.goto(`${BASE_URL}/login`);
      await page.getByRole("button", { name: "Sign in" }).waitFor();
      const offers = await page.getByRole("link", { name: /set up|reset|forgot/i }).count();
      check(offers === 0, `the sign-in screen offers ${offers} setup or reset link(s)`);
      await page.goto(`${BASE_URL}/setup`);
      await page.getByText("The server is already set up").waitFor();
      check(
        (await page.getByLabel("Setup token", { exact: true }).count()) === 0,
        "/setup still shows its form",
      );
      await shot(page, "setup-closed");
      const reset = await fetch(`${BASE_URL}/api/setup/reset`, {
        method: "POST",
        headers: { origin: BASE_URL, "content-type": "application/json" },
        body: JSON.stringify({ token: SETUP_TOKEN ?? "", username: USERNAME, password: "x" }),
      });
      const body = await reset.json();
      check(
        reset.status === 404 && body.error === "not_found",
        `POST /api/setup/reset answered ${reset.status} ${JSON.stringify(body)}`,
      );
    });

    await step("sign-in returns to the page that asked for it", async () => {
      await page.goto(`${BASE_URL}/account`);
      await page.waitForURL((url) => url.pathname === "/login");
      const url = new URL(page.url());
      check(url.searchParams.get("redirect") === "/account", `redirect is ${url.search}`);
      await signIn(page, password, { expectAt: "/account" });
      await page.getByRole("heading", { level: 1, name: "Account" }).waitFor();
      await page.getByLabel("Current password", { exact: true }).waitFor();
      await checkNoSectionHeading(page, "the account page");
    });

    await step("the account form checks its fields", async () => {
      await page.getByLabel("Current password", { exact: true }).fill(password);
      await page.getByLabel("New password", { exact: true }).fill(passwords.changed);
      await page
        .getByLabel("Confirm new password", { exact: true })
        .fill(`${passwords.changed} (typo)`);
      await page.getByRole("button", { name: "Change password" }).click();
      await page.getByText("The passwords do not match.").waitFor();
      await checkNoToast(page, "The passwords do not match");

      await page.getByLabel("Current password", { exact: true }).fill(`${password} (wrong)`);
      await page.getByLabel("Confirm new password", { exact: true }).fill(passwords.changed);
      await page.getByRole("button", { name: "Change password" }).click();
      await page.getByText("The current password is wrong.").waitFor();
      await checkNoToast(page, "The current password is wrong");
      await shot(page, "account-wrong-password");
    });

    await step("a server-reported field error goes once its field changes", async () => {
      const current = page.getByLabel("Current password", { exact: true });
      const confirm = page.getByLabel("Confirm new password", { exact: true });
      const submit = page.getByRole("button", { name: "Change password" });
      const wrong = page.getByText("The current password is wrong.");
      const mismatch = page.getByText("The passwords do not match.");
      /** That the mismatch is the one error on the form (#103). */
      const checkOnlyMismatch = async () => {
        await mismatch.waitFor();
        const errors = await page.locator('[data-slot="field-error"]').allTextContents();
        check(
          errors.length === 1 && errors[0] === "The passwords do not match.",
          `the form shows ${JSON.stringify(errors)}, not only the mismatch`,
        );
        check(
          (await current.getAttribute("aria-invalid")) === null,
          "the current password is still marked invalid",
        );
      };

      // The wrong current password is fixed, then the confirmation typed
      // wrong: the mismatch check stops the submit before any request, and
      // the server's word on the old value went when the field changed.
      await wrong.waitFor();
      await current.fill(password);
      await wrong.waitFor({ state: "detached" });
      await confirm.fill(`${passwords.changed} (typo)`);
      await submit.click();
      await checkOnlyMismatch();
      await shot(page, "account-mismatch-only");

      // A submit drops it too, before its own checks: the wrong password
      // again, then only the confirmation typed wrong.
      await current.fill(`${password} (wrong)`);
      await confirm.fill(passwords.changed);
      await submit.click();
      await wrong.waitFor();
      check((await mismatch.count()) === 0, "the mismatch outlived a matching confirmation");
      await confirm.fill(`${passwords.changed} (typo)`);
      check((await wrong.count()) === 1, "the wrong-password error went with another field");
      await submit.click();
      await checkOnlyMismatch();
    });

    await step("change password; Subsonic's ping takes neither", async () => {
      await page.getByLabel("Current password", { exact: true }).fill(password);
      await page.getByLabel("New password", { exact: true }).fill(passwords.changed);
      await page.getByLabel("Confirm new password", { exact: true }).fill(passwords.changed);
      await markToasts(page);
      await page.getByRole("button", { name: "Change password" }).click();
      await expectToast(page, "Password changed", "Your other sessions are signed out.");
      await shot(page, "account-changed");
      const old = password;
      password = passwords.changed;
      await checkOwnerCannotPing(password);
      await checkOwnerCannotPing(old);
      await checkSubsonicUserPings();
      // This session was kept.
      await page.reload();
      await page.getByRole("heading", { name: "Account" }).waitFor();
    });

    await step("sign-out from /account goes to plain /login, then to the overview", async () => {
      check(new URL(page.url()).pathname === "/account", `on ${page.url()}, not /account`);
      await signOut(page);
      await signIn(page, password, { expectAt: "/" });
      await page.getByRole("button", { name: new RegExp(USERNAME) }).waitFor();
    });

    // The Subsonic users page (#82 "Testing Decisions", console steps 2–6).
    /** The one Subsonic admin, whose demotion and deletion are refused. */
    let lastAdmin;

    await step("Subsonic users: add a user, and ping with it", async () => {
      await page.getByRole("link", { name: "Users" }).click();
      await page.waitForURL((url) => url.pathname === "/users");
      // The page's h1. It is one block, so it has no h2 of its own (#128).
      await page.getByRole("heading", { level: 1, name: "Subsonic users" }).waitFor();
      await page.getByRole("button", { name: "Add user" }).waitFor();
      await checkNoSectionHeading(page, "the Subsonic users page");
      const before = await listSubsonicUsers(page);
      check(
        !before.some((user) => user.username.startsWith("walkthrough-")),
        "the database has walkthrough users already",
      );
      const admins = before.filter((user) => user.isAdmin);
      const notes = [];
      if (admins.length === 0) {
        // The first Subsonic user must be a Subsonic admin (admin_required).
        await shot(page, "users-empty");
        await addSubsonicUser(page, subsonic.admin, {
          admin: true,
          locked: true,
          screenshot: "users-add-first-admin",
        });
        await checkPing(subsonic.admin.username, subsonic.admin.password, "ok");
        lastAdmin = subsonic.admin.username;
        notes.push("no Subsonic admin: added one with the switch locked on");
      } else if (admins.length === 1) {
        lastAdmin = admins[0].username;
      } else {
        notes.push(`${admins.length} Subsonic admins: the last-admin step is skipped`);
      }
      await shot(page, "users");
      await addSubsonicUser(page, subsonic.user, { admin: false, locked: false });
      await shot(page, "users-added");
      await checkPing(subsonic.user.username, subsonic.user.password, "ok");
      await checkSubsonicUserPings();

      // A taken name, in another case, stays beside its field.
      await page.getByRole("button", { name: "Add user" }).click();
      const form = dialog(page);
      await form.getByLabel("Username", { exact: true }).fill(subsonic.user.username.toUpperCase());
      await form.getByLabel("Password", { exact: true }).fill("any");
      await form.getByRole("button", { name: "Add user" }).click();
      await form.getByText("The username is taken.").waitFor();
      await checkNoToast(page, "The username is taken");
      await form.getByRole("button", { name: "Show password" }).click();
      check(
        (await form.getByLabel("Password", { exact: true }).getAttribute("type")) === "text",
        "Show password does not show it",
      );
      await shot(page, "users-name-taken");
      await form.getByRole("button", { name: "Cancel" }).click();
      await dialogClosed(page);
      return notes.join("; ") || undefined;
    });

    await step("Subsonic users: set a password; the old one fails, the new one works", async () => {
      await userAction(page, subsonic.user.username, "Set password");
      const form = dialog(page);
      await form.getByLabel("New password", { exact: true }).fill(subsonic.changedPassword);
      await shot(page, "users-set-password");
      await markToasts(page);
      await form.getByRole("button", { name: "Set password" }).click();
      await expectToast(page, "Password set");
      await dialogClosed(page);
      await checkPing(subsonic.user.username, subsonic.user.password, 40);
      await checkPing(subsonic.user.username, subsonic.changedPassword, "ok");
    });

    await step("Subsonic users: rename; the old name fails, the new one works", async () => {
      await userAction(page, subsonic.user.username, "Edit");
      const form = dialog(page);
      await form.getByLabel("Username", { exact: true }).fill(subsonic.renamed);
      await form.getByText("signs walkthrough-user out of every Subsonic client").waitFor();
      await shot(page, "users-rename");
      await markToasts(page);
      await form.getByRole("button", { name: "Save" }).click();
      await expectToast(page, "Subsonic user saved", `is now ${subsonic.renamed}`);
      await dialogClosed(page);
      await page.getByRole("cell", { name: subsonic.renamed, exact: true }).waitFor();
      await checkPing(subsonic.user.username, subsonic.changedPassword, 40);
      await checkPing(subsonic.renamed, subsonic.changedPassword, "ok");
    });

    await step(
      "Subsonic users: the last Subsonic admin is neither demoted nor deleted",
      async () => {
        if (!lastAdmin) {
          return "skipped";
        }
        await userAction(page, lastAdmin, "Edit");
        const form = dialog(page);
        await form.getByRole("switch", { name: "Subsonic admin" }).click();
        await markToasts(page);
        await form.getByRole("button", { name: "Save" }).click();
        await expectToast(page, "This is the last Subsonic admin", "Make another user");
        // A refusal no field owns closes the dialog: its backdrop would blur the toast.
        await dialogClosed(page);
        await shot(page, "users-last-admin-demote");

        await userAction(page, lastAdmin, "Delete");
        await markToasts(page);
        await dialog(page).getByRole("button", { name: "Delete user" }).click();
        await expectToast(page, "This is the last Subsonic admin");
        await dialogClosed(page);
        await shot(page, "users-last-admin-delete");
        const admin = (await listSubsonicUsers(page)).find((user) => user.username === lastAdmin);
        check(admin?.isAdmin === true, `${lastAdmin} is no longer a Subsonic admin`);
        await checkSubsonicUserPings();
      },
    );

    await step("Subsonic users: delete the user; its ping fails", async () => {
      // A playlist of theirs, which the dialog counts and the delete takes too.
      await createPlaylist(subsonic.renamed, subsonic.changedPassword, "Walkthrough mix");
      await page.reload();
      await page.getByRole("cell", { name: subsonic.renamed, exact: true }).waitFor();
      await userAction(page, subsonic.renamed, "Delete");
      const confirm = dialog(page);
      await confirm.getByText(`Delete ${subsonic.renamed}?`).waitFor();
      await confirm
        .getByText("Their stars, ratings, play counts, bookmarks and play queue are deleted")
        .waitFor();
      await confirm
        .getByText("their 1 playlist is deleted too, including its playlist file in the bucket")
        .waitFor();
      await shot(page, "users-delete");
      await markToasts(page);
      await confirm.getByRole("button", { name: "Delete user" }).click();
      await expectToast(page, "Subsonic user deleted");
      await dialogClosed(page);
      await page.getByRole("cell", { name: subsonic.renamed, exact: true }).waitFor({
        state: "detached",
      });
      await checkPing(subsonic.renamed, subsonic.changedPassword, 40);
      await checkSubsonicUserPings();
    });

    await step("a session that ends while on a page returns there after sign-in", async () => {
      await page.goto(`${BASE_URL}/account`);
      await page.getByRole("heading", { name: "Account" }).waitFor();
      // As if the session ran out, or was revoked elsewhere: the next write
      // is refused, and the console asks for a sign-in on the way back here.
      await context.clearCookies();
      await page.getByLabel("Current password", { exact: true }).fill(password);
      await page.getByLabel("New password", { exact: true }).fill(passwords.changed);
      await page.getByLabel("Confirm new password", { exact: true }).fill(passwords.changed);
      await page.getByRole("button", { name: "Change password" }).click();
      await page.waitForURL((url) => url.pathname === "/login");
      const url = new URL(page.url());
      check(url.searchParams.get("redirect") === "/account", `redirect is ${url.search}`);
      await signIn(page, password, { expectAt: "/account" });
      await page.getByRole("heading", { name: "Account" }).waitFor();
    });

    await step("the Overview, without a usage panel when there is no token", async () => {
      const usage = page.waitForResponse((response) => pathOf(response) === "/api/usage");
      await page.goto(`${BASE_URL}/`);
      await page.getByText("Library scan", { exact: true }).waitFor();
      await page.getByText("Artists", { exact: true }).waitFor();
      await page.getByText("Recently added", { exact: true }).waitFor();
      await checkSidebarEntries(page);
      const answer = await usage;
      check(answer.ok(), `GET /api/usage answered ${answer.status()}`);
      const configured = (await answer.json()).configured;
      const panel = page.getByText("Free-tier usage", { exact: true });
      if (configured) {
        await panel.waitFor();
      } else {
        // Give the page a moment to render what it read, then look.
        await page.waitForTimeout(500);
        check((await panel.count()) === 0, "the usage panel shows without an analytics token");
      }
      await shot(page, "overview");
      return configured ? "the server has an analytics token: the panel shows" : undefined;
    });

    await step("Scan now starts a pass, and its end reads the library again", async () => {
      check(new URL(page.url()).pathname === "/", `on ${page.url()}, not the Overview`);
      // The reads, in the order the page made them: the scan request's
      // answer and each live answer as it arrives, with what they say of the
      // pass, and each library read as it is asked for.
      const reads = [];
      const onResponse = async (response) => {
        const path = pathOf(response);
        if (path === "/api/overview/live" || path === "/api/library/scan") {
          const read = { kind: path === "/api/library/scan" ? "scan" : "live" };
          reads.push(read);
          read.running = (await response.json().catch(() => null))?.scan?.running;
        }
      };
      const onRequest = (request) => {
        if (new URL(request.url()).pathname === "/api/overview/library") {
          reads.push({ kind: "library" });
        }
      };
      page.on("response", onResponse);
      page.on("request", onRequest);
      try {
        await markToasts(page);
        const [request] = await Promise.all([
          page.waitForResponse((response) => pathOf(response) === "/api/library/scan"),
          page.getByRole("button", { name: "Scan now" }).click(),
        ]);
        check(request.ok(), `POST /api/library/scan answered ${request.status()}`);
        const { outcome } = await request.json();
        await expectToast(
          page,
          outcome === "started" ? "Scan started" : "A scan is already running",
        );
        const scanSection = page.getByRole("region", { name: "Library scan" });
        // The playlists phase names itself twice (description and progress label).
        await scanSection
          .getByText(/A scan is running|Importing playlists/)
          .first()
          .waitFor();
        await shot(page, "overview-scanning");

        // The live route is read every 10 s during a pass, and the read that
        // finds it over reads the library again. A fixture library passes in
        // seconds.
        await scanSection.getByText(/Last scan finished/).waitFor({ timeout: SCAN_TIMEOUT_MS });
        const readAgain = () => {
          const ended = reads.findIndex(
            (read, index) =>
              read.kind === "live" &&
              read.running === false &&
              reads.slice(0, index).some((before) => before.running === true),
          );
          return ended >= 0 && reads.slice(ended + 1).some((read) => read.kind === "library");
        };
        for (let waited = 0; !readAgain() && waited < 5_000; waited += 100) {
          await page.waitForTimeout(100);
        }
        check(readAgain(), `the library was not read after the pass: ${JSON.stringify(reads)}`);
        await shot(page, "overview-scanned");
      } finally {
        page.off("response", onResponse);
        page.off("request", onRequest);
      }
    });

    /** What the Files steps found: the scratch folder, and whether writes are on. */
    const files = { present: false, writable: false, album: `${FILES_PREFIX}album/` };

    await step(
      "Files: browse into a folder and back, by the path and the back button",
      async () => {
        await page.goto(filesUrl(""));
        await page.getByRole("heading", { level: 1, name: "Files" }).waitFor();
        await checkSidebarEntries(page);
        const root = await listFolder(page, "");
        files.present = root.folders.some((folder) => folder.prefix === FILES_PREFIX);
        if (!files.present) {
          return "skipped";
        }
        files.writable = (await filesConfig(page)).writes.enabled;
        await checkNoSectionHeading(page, "the Files page");
        const [scratch] = FILES_PREFIX.split("/");
        await page.getByRole("link", { name: scratch, exact: true }).click();
        await inFolder(page, FILES_PREFIX);
        await page.getByRole("link", { name: "album", exact: true }).click();
        await inFolder(page, files.album);
        await shot(page, "files-album");
        await folderPath(page).getByRole("link", { name: scratch, exact: true }).click();
        await inFolder(page, FILES_PREFIX);
        await page.goBack();
        await inFolder(page, files.album);
        await page.goBack();
        await inFolder(page, FILES_PREFIX);
        await page.goBack();
        await inFolder(page, "");
        return files.writable ? undefined : "file writes are off here";
      },
    );

    await step(
      "Files: New folder refuses a bad name, and opens a new one writing nothing",
      async () => {
        if (!files.present || !files.writable) {
          return "skipped";
        }
        const writes = [];
        const onRequest = (request) => {
          if (
            request.method() !== "GET" &&
            new URL(request.url()).pathname.startsWith("/api/files")
          ) {
            writes.push(request.url());
          }
        };
        page.on("request", onRequest);
        try {
          await page.goto(filesUrl(FILES_PREFIX));
          await inFolder(page, FILES_PREFIX);
          await page.getByRole("button", { name: "New folder" }).click();
          const form = dialog(page);
          await form.getByLabel("Name", { exact: true }).fill(".hidden");
          await form.getByRole("button", { name: "Create folder" }).click();
          await form.getByText("A name cannot start with a dot.").waitFor();
          await checkNoToast(page, "A name cannot start with a dot.");
          await shot(page, "files-new-folder-refused");
          await form.getByLabel("Name", { exact: true }).fill("walkthrough new folder");
          await form.getByRole("button", { name: "Create folder" }).click();
          await dialogClosed(page);
          await inFolder(page, `${FILES_PREFIX}walkthrough new folder/`);
          await page.getByText("Upload files to create this folder.").waitFor();
          await shot(page, "files-new-folder");
          check(writes.length === 0, `New folder wrote: ${writes.join(", ")}`);
          await page.goBack();
          await inFolder(page, FILES_PREFIX);
        } finally {
          page.off("request", onRequest);
        }
      },
    );

    await step("Files: delete a file, which cannot be undone, and see the scan line", async () => {
      if (!files.present || !files.writable) {
        return "skipped";
      }
      const before = await listFolder(page, files.album);
      const [target] = before.files;
      check(before.files.length >= 2, `${files.album} holds ${before.files.length} files, not 2`);
      await page.goto(filesUrl(files.album));
      await inFolder(page, files.album);
      await page.getByRole("button", { name: `Actions for ${target.name}`, exact: true }).click();
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
      const confirm = dialog(page);
      await confirm.getByText("Delete 1 file?").waitFor();
      await confirm.getByText(target.name, { exact: true }).waitFor();
      await confirm.getByText(/This cannot be undone\./).waitFor();
      await shot(page, "files-delete-file-dialog");
      await markToasts(page);
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      await expectToast(page, "Deleted 1 file");
      await dialogClosed(page);
      check(
        (await page.locator(TOAST).filter({ hasText: /undo/i }).count()) === 0,
        "a toast offers an undo",
      );
      await page.getByText(SCAN_LINE).first().waitFor();
      await page.getByRole("cell", { name: target.name }).waitFor({ state: "detached" });
      await shot(page, "files-deleted-file");
      const after = await listFolder(page, files.album);
      check(
        !after.files.some((file) => file.key === target.key),
        `${target.key} is still in the bucket`,
      );
    });

    await step("Files: delete a folder, with everything in it", async () => {
      if (!files.present || !files.writable) {
        return "skipped";
      }
      const inside = (await listFolder(page, files.album)).files.length;
      await page.goto(filesUrl(FILES_PREFIX));
      await inFolder(page, FILES_PREFIX);
      await page.getByRole("checkbox", { name: "Select album", exact: true }).click();
      await page.getByRole("button", { name: "Delete 1 selected" }).click();
      const confirm = dialog(page);
      await confirm.getByText("Delete 1 folder?").waitFor();
      await confirm.getByText(files.album, { exact: true }).waitFor();
      await confirm.getByText(/This cannot be undone\./).waitFor();
      await shot(page, "files-delete-folder-dialog");
      await markToasts(page);
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      await expectToast(
        page,
        `Deleted ${files.album.replace(/\/$/, "")} (${inside} file${inside === 1 ? "" : "s"})`,
      );
      await dialogClosed(page);
      await page.getByRole("link", { name: "album", exact: true }).waitFor({ state: "detached" });
      await page.getByText(SCAN_LINE).first().waitFor();
      await shot(page, "files-deleted-folder");
      const after = await listFolder(page, files.album);
      check(after.files.length === 0 && after.folders.length === 0, `${files.album} is not empty`);
    });

    /**
     * What the upload steps found: whether uploads are configured (enough to
     * check the console's own refusals), whether they may really upload (a
     * scratch bucket), the local folder they pick from, and the bucket
     * folder they upload.
     */
    const uploads = {
      configured: false,
      on: false,
      dir: "",
      album: `${FILES_PREFIX}walkthrough upload/`,
    };

    await step("Files: a .pdf is refused before any request", async () => {
      if (!files.present || !files.writable) {
        return "skipped";
      }
      const config = await filesConfig(page);
      if (!config.uploads.configured) {
        return "skipped";
      }
      uploads.configured = true;
      uploads.on = Boolean(UPLOADS_BUCKET) && config.bucket === UPLOADS_BUCKET;
      // What the steps pick: a folder of two FLACs, their lyrics and a
      // cover, and a .pdf beside it.
      uploads.dir = mkdtempSync(join(tmpdir(), "walkthrough-upload-"));
      const album = join(uploads.dir, "walkthrough upload");
      mkdirSync(album);
      const fixture = (name) =>
        fileURLToPath(new URL(`../../server/test/fixtures/${name}`, import.meta.url));
      copyFileSync(fixture("hushed-interlude.flac"), join(album, "01 Hushed Interlude.flac"));
      copyFileSync(fixture("lyrics-vorbis.flac"), join(album, "02 Lyrics.flac"));
      writeFileSync(join(album, "01 Hushed Interlude.lrc"), "[00:00.00]Hushed\n");
      writeFileSync(join(album, "02 Lyrics.lrc"), "[00:00.00]Lyrics\n");
      copyFileSync(fixture("cover.png"), join(album, "cover.png"));
      writeFileSync(join(uploads.dir, "notes.pdf"), "%PDF-1.4\n");

      await page.goto(filesUrl(FILES_PREFIX));
      await inFolder(page, FILES_PREFIX);
      const counted = countUploadRequests(page);
      await markToasts(page);
      await pick(page, "Files…", join(uploads.dir, "notes.pdf"));
      // The header's trigger says so; the popover never opens by itself.
      await uploadsTrigger(page, "1 needs attention").waitFor();
      await expectToast(page, "1 file was not uploaded");
      check((await uploadsPopover(page).count()) === 0, "the Uploads popover opened by itself");
      // The folder stays the page's one block: no h2, no region.
      check(
        (await page.getByRole("main").getByRole("region").count()) === 0,
        "the Files page shows a region beside its folder",
      );
      check(
        counted.sign === 0 && counted.put === 0,
        `a refused .pdf made requests: ${counted.note()}`,
      );
      // The keyboard opens it, Escape closes it, and focus returns to the trigger.
      await uploadsTrigger(page).focus();
      await page.keyboard.press("Enter");
      await uploadsPopover(page).getByText("Failed: not a type the server reads").waitFor();
      await shot(page, "files-upload-refused");
      await page.keyboard.press("Escape");
      await uploadsPopover(page).waitFor({ state: "detached" });
      check(
        await uploadsTrigger(page).evaluate((element) => element === document.activeElement),
        "Escape did not return focus to the Uploads trigger",
      );
      // Clear finished empties the queue: the trigger goes, and focus goes to Upload.
      await clearUploads(page);
      check(
        await page.evaluate(() => document.activeElement?.hasAttribute("data-upload-trigger")),
        "emptying the queue did not return focus to Upload",
      );
    });

    await step(
      "Files: upload a folder, with the toast, the scan line and a row a file in the popover",
      async () => {
        if (!uploads.on) {
          if (uploads.configured) {
            console.log(
              "    uploads need UPLOADS_BUCKET naming the scratch bucket the Worker binds",
            );
          }
          return "skipped";
        }
        await page.goto(filesUrl(FILES_PREFIX));
        await inFolder(page, FILES_PREFIX);
        const counted = countUploadRequests(page);
        await markToasts(page);
        await pick(page, "Folder…", join(uploads.dir, "walkthrough upload"));
        await expectToast(page, "Uploaded 5 files");
        await uploadsTrigger(page, "Uploads done").waitFor();
        await page.getByText(SCAN_LINE).first().waitFor();
        // One row a file; a progress bar shows only while a file is sent.
        await uploadsTrigger(page).click();
        await uploadsPopover(page).getByText("5 of 5 uploaded").waitFor();
        check(
          (await uploadsPopover(page).getByRole("listitem").count()) === 5,
          "the upload list does not show one row a file",
        );
        await shot(page, "files-uploaded");
        await page.keyboard.press("Escape");
        await uploadsPopover(page).waitFor({ state: "detached" });
        const listed = await listFolder(page, uploads.album);
        check(
          listed.files.length === 5,
          `${uploads.album} holds ${listed.files.length} files, not 5`,
        );
        return counted.note();
      },
    );

    await step("Files: a file that exists is Already exists, and Replace replaces it", async () => {
      if (!uploads.on) {
        return "skipped";
      }
      await page.goto(filesUrl(uploads.album));
      await inFolder(page, uploads.album);
      await clearUploads(page);
      const counted = countUploadRequests(page);
      await markToasts(page);
      await pick(
        page,
        "Files…",
        join(uploads.dir, "walkthrough upload", "01 Hushed Interlude.flac"),
      );
      await expectToast(page, "1 file was not uploaded");
      await uploadsTrigger(page, "1 needs attention").click();
      await uploadsPopover(page).getByText("Already exists").waitFor();
      await shot(page, "files-upload-exists");
      await markToasts(page);
      await uploadsPopover(page).getByRole("button", { name: "Replace", exact: true }).click();
      await expectToast(page, "Uploaded 1 file");
      await uploadsTrigger(page, "Uploads done").waitFor();
      await uploadsPopover(page).getByRole("button", { name: "Clear finished" }).click();
      await uploadsTrigger(page).waitFor({ state: "detached" });
      return counted.note();
    });

    await step("Files: the uploaded folder is deleted again", async () => {
      if (uploads.dir !== "") {
        rmSync(uploads.dir, { recursive: true, force: true });
      }
      if (!uploads.on) {
        return "skipped";
      }
      const deleted = await page.evaluate(async (prefix) => {
        let total = 0;
        for (;;) {
          const response = await fetch("/api/files/delete-folder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prefix }),
          });
          const body = await response.json();
          total += body.deleted ?? 0;
          if (!response.ok || body.done) {
            return total;
          }
        }
      }, uploads.album);
      check(deleted === 5, `deleting ${uploads.album} took ${deleted} files, not 5`);
    });

    await step("Files: where file writes are off, the page is read-only", async () => {
      if (!files.present || files.writable) {
        return "skipped";
      }
      await page.goto(filesUrl(FILES_PREFIX));
      await inFolder(page, FILES_PREFIX);
      await page.getByText("Read-only on this deployment").waitFor();
      for (const control of [
        page.getByRole("checkbox"),
        page.getByRole("button", { name: "New folder" }),
        page.getByRole("button", { name: /^Actions for / }),
        page.getByRole("button", { name: /^Delete/ }),
      ]) {
        check((await control.count()) === 0, "a write control shows on a read-only page");
      }
      await shot(page, "files-read-only");
      const { files: listed } = await listFolder(page, FILES_PREFIX);
      const refused = await page.evaluate(async (key) => {
        const response = await fetch("/api/files/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keys: [key] }),
        });
        return { status: response.status, body: await response.json() };
      }, listed[0]?.key ?? `${FILES_PREFIX}nothing`);
      check(
        refused.status === 403 && refused.body.error === "file_writes_disabled",
        `a delete answered ${JSON.stringify(refused)}`,
      );
      const after = await listFolder(page, FILES_PREFIX);
      check(after.files.length === listed.length, "a refused delete deleted something");
    });

    await step("Files: signing out from the Files page reads nothing more", async () => {
      if (!files.present) {
        return "skipped";
      }
      await page.goto(filesUrl(FILES_PREFIX));
      await inFolder(page, FILES_PREFIX);
      // The page used to read its folder and the files config again as the
      // cache was cleared, both refused (#141).
      const read = [];
      let signedOut = false;
      const onRequest = (request) => {
        if (signedOut && pathOf(request).startsWith("/api/files")) {
          read.push(`${request.method()} ${pathOf(request)}`);
        }
      };
      page.on("request", onRequest);
      await openUserMenu(page);
      signedOut = true;
      await clickSignOut(page);
      await page.getByLabel("Username", { exact: true }).waitFor();
      await page.waitForTimeout(1000);
      page.off("request", onRequest);
      check(read.length === 0, `signing out read the files API: ${read.join(", ")}`);
      await signIn(page, password, { expectAt: "/" });
    });

    await step("dark mode", async () => {
      await page.goto(`${BASE_URL}/account`);
      await page.getByRole("button", { name: "Toggle theme" }).click();
      await page.getByRole("menuitem", { name: "Dark" }).click();
      check(
        await page.evaluate(() => document.documentElement.classList.contains("dark")),
        "the page is not dark",
      );
      await shot(page, "account-dark");
      await signOut(page);
      check(
        await page.evaluate(() => document.documentElement.classList.contains("dark")),
        "the sign-in screen is not dark",
      );
      await shot(page, "login-dark");
      await signIn(page, password, { expectAt: "/" });
      await page.getByText("Library scan", { exact: true }).waitFor();
      await page.locator('[data-slot="chart"], [data-slot="empty"]').first().waitFor();
      check(
        await page.evaluate(() => document.documentElement.classList.contains("dark")),
        "the Overview is not dark",
      );
      await shot(page, "overview-dark");
      if (files.present) {
        await page.goto(filesUrl(FILES_PREFIX));
        await inFolder(page, FILES_PREFIX);
        await shot(page, "files-dark");
      }
      await page.getByRole("button", { name: "Toggle theme" }).click();
      await page.getByRole("menuitem", { name: "Light" }).click();
    });

    await step("a phone-sized viewport", async () => {
      const phone = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      const mobile = await phone.newPage();
      watch(mobile, "mobile");
      const overflows = () =>
        mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

      await mobile.goto(`${BASE_URL}/account`);
      await mobile.waitForURL((url) => url.pathname === "/login");
      check(!(await overflows()), "the sign-in screen scrolls sideways");
      await shot(mobile, "mobile-login");
      await signIn(mobile, password, { expectAt: "/account" });
      check(!(await overflows()), "the account page scrolls sideways");
      await shot(mobile, "mobile-account");
      await mobile.goto(`${BASE_URL}/`);
      await mobile.getByText("Library scan", { exact: true }).waitFor();
      await mobile.getByText("Recently added", { exact: true }).waitFor();
      check(!(await overflows()), "the Overview scrolls sideways");
      await shot(mobile, "mobile-overview");
      if (files.present) {
        await mobile.goto(filesUrl(FILES_PREFIX));
        await inFolder(mobile, FILES_PREFIX);
        check(!(await overflows()), "the Files page scrolls sideways");
        check(
          !(await mobile.getByRole("columnheader", { name: "Modified" }).isVisible()),
          "the Files page shows Modified on a phone",
        );
        await shot(mobile, "mobile-files");
      }

      await mobile.getByRole("button", { name: "Toggle Sidebar" }).first().click();
      await openUserMenu(mobile);
      await mobile.getByRole("menuitem", { name: "Sign out" }).waitFor();
      await shot(mobile, "mobile-user-menu");
      await clickSignOut(mobile);
      await phone.close();
    });

    await step("no console errors", async () => {
      check(consoleErrors.length === 0, consoleErrors.join("\n    "));
    });
  } finally {
    await browser.close();
    const failed = results.filter((result) => result.outcome === "failed").length;
    const skipped = results.filter((result) => result.outcome === "skipped").length;
    console.log(
      `\n${results.length - failed - skipped} ok, ${skipped} skipped, ${failed} failed; ` +
        `sign-in rate limited ${rateLimited} time(s); the password is now "${password}"`,
    );
  }
}

main().catch((error) => {
  // A failed step has said why; anything else (Chromium failing to start, a
  // Worker that is not there) says so here.
  if (error !== stepFailure) {
    console.error(error);
  }
  process.exitCode = 1;
});
