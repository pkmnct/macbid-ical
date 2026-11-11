import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface TlsMaterials {
  cert: Buffer;
  key: Buffer;
}

/** A file that exists and is not empty (an empty key is no key). */
function hasContent(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

/** Best effort: a leftover temporary file must never stop the server starting. */
function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to delete
  }
}

/**
 * Loads the sign-in page's certificate, generating a self-signed one with the
 * openssl command if none exists. Returns null when there is no certificate
 * and openssl is not available (as in the published Docker image).
 */
export function loadTlsMaterials(dir: string): TlsMaterials | null {
  const configuredCert = process.env.ICAL_TLS_CERT?.trim();
  const configuredKey = process.env.ICAL_TLS_KEY?.trim();
  const certPath = configuredCert || join(dir, "cert.pem");
  const keyPath = configuredKey || join(dir, "key.pem");

  // A certificate the user named must exist: never replace it with a
  // generated one, or hide the mistake by turning HTTPS off
  if (configuredCert || configuredKey) {
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      throw new Error(
        `ICAL_TLS_CERT and ICAL_TLS_KEY must both point to existing files (cert: ${certPath}, key: ${keyPath})`
      );
    }
  } else {
    const haveCert = hasContent(certPath);
    const haveKey = hasContent(keyPath);

    // Half a pair is somebody's certificate or key: never overwrite it
    if (haveCert !== haveKey) {
      // Not fatal: the feed still works, and sign-in can go through a proxy
      console.error(
        `${haveCert ? "cert.pem" : "key.pem"} exists in ${dir} without ${haveCert ? "key.pem" : "cert.pem"}; HTTPS sign-in is off until both files are there (add the missing one or remove the other)`
      );
      return null;
    }

    if (!haveCert) {
      // Generate next to the final files and rename on success, so a failure
      // never touches what is already there
      const tempKey = `${keyPath}.tmp`;
      const tempCert = `${certPath}.tmp`;
      try {
        // The private key is written here: keep the folder and the key private
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // Create the key file empty and private first: openssl then fills it in
        // place, so it is never readable by others, whatever the umask is
        writeFileSync(tempKey, "", { mode: 0o600 });
        chmodSync(tempKey, 0o600);
        execFileSync(
          "openssl",
          [
            "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", tempKey,
            "-out", tempCert,
            "-days", "825", "-nodes",
            "-subj", "/CN=macbid-ical",
          ],
          { stdio: "ignore" }
        );
        chmodSync(tempKey, 0o600);
        renameSync(tempKey, keyPath);
        renameSync(tempCert, certPath);
        console.log(`Generated self-signed TLS certificate at ${certPath}`);
      } catch {
        removeQuietly(tempKey);
        removeQuietly(tempCert);
        return null;
      }
    }
  }

  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}
