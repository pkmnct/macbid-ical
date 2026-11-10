import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TlsMaterials {
  cert: Buffer;
  key: Buffer;
}

export function loadTlsMaterials(dir: string): TlsMaterials {
  const certPath =
    process.env.ICAL_TLS_CERT?.trim() || join(dir, "cert.pem");
  const keyPath = process.env.ICAL_TLS_KEY?.trim() || join(dir, "key.pem");

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    mkdirSync(dir, { recursive: true });
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 825 -nodes -subj "/CN=macbid-ical"`,
      { stdio: "ignore" }
    );
    console.log(`Generated self-signed TLS certificate at ${certPath}`);
  }

  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}
