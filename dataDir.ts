import { access, chmod, copyFile, mkdir, rename, unlink } from "node:fs/promises";
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

export function tlsDir(): string {
  return join(dataDir(), "tls");
}

export async function ensureDataDir(): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await mkdir(tlsDir(), { recursive: true });
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  );

/**
 * Before the data directory, tokens were saved as .macbid-tokens.json in the
 * working directory. Move them so upgrading does not sign the feed out.
 * Credentials files from earlier builds are deleted: credentials are now only
 * held in memory.
 */
export async function migrateLegacyFiles(): Promise<void> {
  const legacyTokens = join(process.cwd(), ".macbid-tokens.json");
  const tokens = authStatePath();

  if ((await exists(legacyTokens)) && !(await exists(tokens))) {
    try {
      await rename(legacyTokens, tokens);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
        throw error;
      }
      // ICAL_DATA_DIR is on another filesystem
      await copyFile(legacyTokens, tokens);
      await unlink(legacyTokens);
    }
    await chmod(tokens, 0o600);
    console.log(`Moved saved Mac.Bid session from ${legacyTokens} to ${tokens}`);
  }

  for (const legacyCredentials of [
    join(process.cwd(), ".macbid-credentials.json"),
    join(dataDir(), "credentials.json"),
  ]) {
    await unlink(legacyCredentials).catch(() => undefined);
  }
}
