import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface TlsMaterials {
  cert: Buffer;
  key: Buffer;
}

/**
 * Loads the sign-in page's certificate, generating a self-signed one with the
 * openssl command if none exists. Returns null when there is no certificate
 * and openssl is not available (as in the published Docker image).
 */
/** A file that exists and is not empty (an empty key is no key). */
function hasContent(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

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
  } else if (!hasContent(certPath) || !hasContent(keyPath)) {
    try {
      // The private key is written here: keep the folder and the key private
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Create the key file empty and private first: openssl then fills it in
      // place, so it is never readable by others, whatever the umask is
      writeFileSync(keyPath, "", { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      execFileSync(
        "openssl",
        [
          "req", "-x509", "-newkey", "rsa:2048",
          "-keyout", keyPath,
          "-out", certPath,
          "-days", "825", "-nodes",
          "-subj", "/CN=macbid-ical",
        ],
        { stdio: "ignore" }
      );
      chmodSync(keyPath, 0o600);
      console.log(`Generated self-signed TLS certificate at ${certPath}`);
    } catch {
      // Do not leave the empty private key file behind: a later start (or an
      // operator who adds only a certificate) would take it for a real key
      if (existsSync(keyPath) && statSync(keyPath).size === 0) {
        unlinkSync(keyPath);
      }
      return null;
    }
  }

  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}
