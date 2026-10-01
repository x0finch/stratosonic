/**
 * A headless Chromium walkthrough of the console's auth screens (#91), against
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
 * which sign-in returns to; dark mode; and a phone-sized viewport. It signs in
 * more often than the server's limit of 5 a minute allows, so it meets the
 * rate limit's message on the way, and waits it out.
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
 * toasts, and deletes the user, whose ping then answers error 40. Its users
 * are named `walkthrough-…`, so the database must not have those yet.
 *
 * Any console error or uncaught exception on a page fails the walkthrough,
 * except the browser's own "Failed to load resource" line for a response the
 * console expects to be refused (a 401 from `/api/me` while signed out, the
 * 4xx of a refused form). Set `SCREENSHOTS` to a directory to keep a
 * screenshot of each step there.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const SETUP_TOKEN = process.env.SETUP_TOKEN;
const USERNAME = process.env.OWNER_USER ?? "owner";
const SUBSONIC_USER = process.env.SUBSONIC_USER;
const SUBSONIC_PASSWORD = process.env.SUBSONIC_PASSWORD;
const SCREENSHOTS = process.env.SCREENSHOTS;

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
      await page.getByRole("heading", { name: "Account" }).waitFor();
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
      await page.getByRole("heading", { name: "Subsonic users" }).waitFor();
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
      await userAction(page, subsonic.renamed, "Delete");
      const confirm = dialog(page);
      await confirm.getByText(`Delete ${subsonic.renamed}?`).waitFor();
      await confirm
        .getByText("Their stars, ratings, play counts, bookmarks and play queue are deleted")
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
