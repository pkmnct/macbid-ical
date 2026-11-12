import { createHash, timingSafeEqual } from "node:crypto";
import type { PersistedAuthState } from "./authStateFile.js";
import { appVersion } from "./version.js";
import {
  hasActiveSession,
  hasPersistedTokens,
  isRefreshTokenExpired,
} from "./authStateFile.js";

export type LoginRoute = "login" | "login-send-code";

export function parseAppPath(
  requestUrl: string | undefined,
  feedSecret: string
): "feed" | LoginRoute | null {
  if (!requestUrl) {
    return null;
  }

  const pathname = requestUrl.split("?")[0]?.split("#")[0] ?? "";
  const base = `/${feedSecret}`;

  // Always make all three comparisons so timing does not depend on the match
  const feed = constantTimeEqual(pathname, base);
  const login = constantTimeEqual(pathname, `${base}/login`);
  const sendCode = constantTimeEqual(pathname, `${base}/login/send-code`);

  if (feed) {
    return "feed";
  }
  if (login) {
    return "login";
  }
  if (sendCode) {
    return "login-send-code";
  }

  return null;
}

/** Compares fixed-length digests, so timing reveals nothing about the secret. */
function constantTimeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Replaces the secret path in a URL or message before it is logged. */
export function redactSecret(text: string): string {
  const secret = process.env.ICAL_UNIQUE_URL;
  return secret ? text.replaceAll(secret, "<ICAL_UNIQUE_URL>") : text;
}

function bindHost(): string {
  const bind = process.env.ICAL_URL || "127.0.0.1";
  return bind === "0.0.0.0" ? "127.0.0.1" : bind;
}

function configuredPublicOrigin(protocol: "http" | "https"): string | undefined {
  const raw = process.env.ICAL_PUBLIC_URL?.trim();
  if (!raw) {
    return undefined;
  }

  const normalized = raw.replace(/\/$/, "");
  const withScheme = /^https?:\/\//i.test(normalized)
    ? normalized
    : `${protocol}://${normalized}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(
      `ICAL_PUBLIC_URL is invalid (${JSON.stringify(raw)}). ` +
        `Use a full URL (https://host:8443) or host:port (host:8443). ` +
        `In docker-compose.yml, quote values containing // — unquoted https:// is truncated to https:/ by YAML.`
    );
  }

  if (!url.hostname) {
    throw new Error(
      `ICAL_PUBLIC_URL is invalid (${JSON.stringify(raw)}): missing hostname. ` +
        `If you use \${DOMAIN} in compose, set DOMAIN in your .env.`
    );
  }

  url.protocol = `${protocol}:`;
  return url.origin;
}

export function feedPublicBaseUrl(): string {
  const explicit = configuredPublicOrigin("http");
  if (explicit) {
    return explicit;
  }

  const host = bindHost();
  const port = portFromEnv("ICAL_PORT", 3000);
  return `http://${host}:${port}`;
}

/** A port from the environment: a whole number from 1 to 65535, or the default. */
export function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `${name} must be a port number from 1 to 65535 (got ${JSON.stringify(raw)})`
    );
  }
  return value;
}

export function loginPublicBaseUrl(): string {
  const explicit = configuredPublicOrigin("https");
  if (explicit) {
    return explicit;
  }

  const host = bindHost();
  const port = portFromEnv("ICAL_TLS_PORT", 3443);
  return `https://${host}:${port}`;
}

export function loginPageUrl(): string {
  return `${loginPublicBaseUrl()}/${process.env.ICAL_UNIQUE_URL}/login`;
}

export interface LoginPageModel {
  loginUrl: string;
  sendCodeUrl: string;
  status: "authenticated" | "pending" | "expired" | "unauthenticated";
  showCredentialFields: boolean;
  configuredEmail?: string;
  refreshExpires?: string;
  message?: string;
  error?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatExpiry(iso: string | undefined): string | undefined {
  if (!iso) {
    return undefined;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  });
}

export function loginPageModel(
  auth: PersistedAuthState | null,
  options: {
    credentialsFromEnv: boolean;
    /** Email and password from "send code" are still held in memory. */
    hasPendingCredentials: boolean;
    configuredEmail?: string;
    message?: string;
    error?: string;
  }
): LoginPageModel {
  const loginUrl = loginPageUrl();
  const hasTokens = hasPersistedTokens(auth);
  const pending = !!(auth?.device_id && !hasTokens);

  let status: LoginPageModel["status"] = "unauthenticated";
  if (hasTokens && hasActiveSession(auth)) {
    status = "authenticated";
  } else if (hasTokens && isRefreshTokenExpired(auth)) {
    status = "expired";
  } else if (pending) {
    status = "pending";
  }

  return {
    loginUrl,
    sendCodeUrl: `${loginUrl}/send-code`,
    status,
    // While a code is pending the server reuses the email and password from
    // "send code", unless it restarted or they timed out: then ask again.
    showCredentialFields:
      !options.credentialsFromEnv &&
      status !== "authenticated" &&
      !(status === "pending" && options.hasPendingCredentials),
    configuredEmail: options.configuredEmail,
    refreshExpires: formatExpiry(auth?.refresh_token_expiration),
    message: options.message,
    error: options.error,
  };
}

export function renderLoginPage(model: LoginPageModel): string {
  const title =
    model.status === "authenticated"
      ? "Mac.Bid session active"
      : model.status === "expired"
        ? "Mac.Bid session expired"
        : "Mac.Bid calendar sign-in";

  let body = "";

  if (model.error) {
    body += `<p class="error">${escapeHtml(model.error)}</p>`;
  }
  if (model.message) {
    body += `<p class="message">${escapeHtml(model.message)}</p>`;
  }

  if (model.status === "authenticated") {
    body += `<p>Your calendar feed is authenticated with Mac.Bid.</p>`;
    if (model.refreshExpires) {
      body += `<p>Session renews automatically until approximately <strong>${escapeHtml(model.refreshExpires)}</strong> (US Eastern), unless you sign in again sooner.</p>`;
    }
    body += `<p class="muted">No action is needed unless the feed stops updating.</p>`;
  } else if (model.status === "expired") {
    body += `<p>Your Mac.Bid session has expired`;
    if (model.refreshExpires) {
      body += ` (last valid until <strong>${escapeHtml(model.refreshExpires)}</strong> US Eastern)`;
    }
    body += `.</p>`;
    body += `<p>Sign in again to restore your calendar feed.</p>`;
    if (model.configuredEmail) {
      body += `<p class="muted">Using server-configured account: ${escapeHtml(model.configuredEmail)}</p>`;
    }
    body += sendCodeForm(model, "Send verification code");
  } else if (model.status === "pending") {
    if (model.configuredEmail) {
      body += `<p class="muted">Account: ${escapeHtml(model.configuredEmail)}</p>`;
    }
    if (model.showCredentialFields) {
      body += `<p>Enter the verification code sent to your phone, with your Mac.Bid email and password.</p>`;
    } else {
      body += `<p>Enter the verification code sent to your phone.</p>`;
    }
    body += codeForm(model);
    body += `<p class="muted">Didn't get a code? Request a new one below (this invalidates the previous code).</p>`;
    body += sendCodeForm(model, "Send new verification code");
  } else {
    body += `<p>Mac.Bid requires SMS verification to connect your calendar.</p>`;
    if (model.configuredEmail) {
      body += `<p class="muted">Using server-configured account: ${escapeHtml(model.configuredEmail)}</p>`;
    }
    body += sendCodeForm(model, "Send verification code");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #ffffff;
      --text: #111111;
      --muted: #555555;
      --border: #888888;
      --input-bg: #ffffff;
      --input-border: #aaaaaa;
      --button-bg: #e8e8e8;
      --button-text: #111111;
      --error: #b00020;
      --message: #0a6b0a;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #121212;
        --text: #f2f2f2;
        --muted: #b0b0b0;
        --border: #666666;
        --input-bg: #1e1e1e;
        --input-border: #555555;
        --button-bg: #2d2d2d;
        --button-text: #f2f2f2;
        --error: #ff8a8a;
        --message: #7ddea0;
      }
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      line-height: 1.5;
      max-width: 28rem;
      margin: 2rem auto;
      padding: 0 1rem;
      background: var(--bg);
      color: var(--text);
    }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; }
    label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
    input[type="text"], input[type="email"], input[type="password"] {
      width: 100%;
      box-sizing: border-box;
      font-size: 1rem;
      padding: 0.5rem 0.75rem;
      margin-bottom: 0.75rem;
      background: var(--input-bg);
      color: var(--text);
      border: 1px solid var(--input-border);
      border-radius: 6px;
    }
    input[name="code"] {
      font-size: 1.125rem;
      letter-spacing: 0.15em;
    }
    button, .button {
      display: inline-block;
      font-size: 1rem;
      padding: 0.5rem 1rem;
      cursor: pointer;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--button-bg);
      color: var(--button-text);
      text-decoration: none;
    }
    button:hover, .button:hover {
      filter: brightness(1.08);
    }
    .error { color: var(--error); }
    .message { color: var(--message); }
    .muted { color: var(--muted); font-size: 0.9rem; }
    .version {
      margin-top: 2rem;
      color: var(--muted);
      font-size: 0.8rem;
      text-align: center;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${body}
  <p class="version">macbid-ical v${escapeHtml(appVersion)}</p>
</body>
</html>`;
}

function credentialFields(idPrefix: string): string {
  return `<label for="${idPrefix}email">Mac.Bid email</label>
  <input id="${idPrefix}email" name="email" type="email" autocomplete="username" required>
  <label for="${idPrefix}password">Password</label>
  <input id="${idPrefix}password" name="password" type="password" autocomplete="current-password" required>`;
}

function codeForm(model: LoginPageModel): string {
  return `<form method="post" action="${escapeHtml(model.loginUrl)}">
  ${model.showCredentialFields ? credentialFields("code-") : ""}
  <label for="code">Verification code</label>
  <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="8" required autofocus>
  <button type="submit">Sign in</button>
</form>`;
}

function sendCodeForm(model: LoginPageModel, label: string): string {
  if (model.showCredentialFields) {
    return `<form method="post" action="${escapeHtml(model.sendCodeUrl)}">
  ${credentialFields("")}
  <button type="submit">${escapeHtml(label)}</button>
</form>`;
  }

  return `<form method="post" action="${escapeHtml(model.sendCodeUrl)}">
  <button type="submit">${escapeHtml(label)}</button>
</form>`;
}

/** The sign-in form is an email, a password and a code: far below this. */
const MAX_FORM_BYTES = 16 * 1024;

export async function readUrlEncodedForm(
  req: import("node:http").IncomingMessage
): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) {
      throw new Error("Form is too large.");
    }
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function validationCodeSentMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Validation code sent");
}

export function loginRedirectUrl(requestUrl: string | undefined): string {
  const pathname = requestUrl?.split("?")[0]?.split("#")[0] ?? "/login";
  return `${loginPublicBaseUrl()}${pathname}`;
}
