import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
export function loadTlsMaterials(dir: string): TlsMaterials | null {
  const certPath =
    process.env.ICAL_TLS_CERT?.trim() || join(dir, "cert.pem");
  const keyPath = process.env.ICAL_TLS_KEY?.trim() || join(dir, "key.pem");

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    try {
      mkdirSync(dir, { recursive: true });
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
      console.log(`Generated self-signed TLS certificate at ${certPath}`);
    } catch {
      return null;
    }
  }

  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}
