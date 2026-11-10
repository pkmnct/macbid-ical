import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Persistent state directory (tokens, TLS certs). Override with ICAL_DATA_DIR. */
export function dataDir(): string {
  const configured = process.env.ICAL_DATA_DIR?.trim();
  if (configured) {
    return configured;
  }
  return join(process.cwd(), "data");
}

export function authStatePath(): string {
  return join(dataDir(), "tokens.json");
}

export function legacyCredentialsPath(): string {
  return join(dataDir(), "credentials.json");
}

export function tlsDir(): string {
  return join(dataDir(), "tls");
}

export async function ensureDataDir(): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await mkdir(tlsDir(), { recursive: true });
}
