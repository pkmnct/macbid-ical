export interface MacbidCredentials {
  email: string;
  password: string;
}

export function envCredentials(): MacbidCredentials | null {
  const email = process.env.MACBID_EMAIL?.trim();
  const password = process.env.MACBID_PASSWORD;
  if (email && password) {
    return { email, password };
  }
  return null;
}

export function hasEnvCredentials(): boolean {
  return envCredentials() !== null;
}

export function credentialsFromForm(
  form: URLSearchParams
): MacbidCredentials | null {
  const email = form.get("email")?.trim();
  const password = form.get("password") ?? undefined;
  if (email && password) {
    return { email, password };
  }
  return null;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) {
    return email;
  }
  const masked =
    local.length <= 2 ? `${local[0] ?? ""}•••` : `${local.slice(0, 2)}•••`;
  return `${masked}@${domain}`;
}

/** In-memory credentials between "send code" and "verify code" (never persisted). */
export class PendingCredentials {
  private credentials: MacbidCredentials | null = null;
  private savedAt = 0;

  constructor(private readonly ttlMs: number = 15 * 60 * 1000) {}

  set(credentials: MacbidCredentials): void {
    this.credentials = credentials;
    this.savedAt = Date.now();
  }

  get(): MacbidCredentials | null {
    if (!this.credentials) {
      return null;
    }
    if (Date.now() - this.savedAt > this.ttlMs) {
      this.clear();
      return null;
    }
    return this.credentials;
  }

  clear(): void {
    this.credentials = null;
    this.savedAt = 0;
  }
}
