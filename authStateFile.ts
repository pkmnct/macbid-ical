import { promises as fs } from "node:fs";
import MacBid, { type AuthInfo, type SerializableAuthState } from "macbid-ts-api";

/** On-disk auth state: API session fields plus the validation code we last saw in .env. */
export interface PersistedAuthState extends SerializableAuthState {
  validation_code?: string;
}

export async function loadAuthStateFile(
  path: string
): Promise<PersistedAuthState | null> {
  try {
    const data = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(data) as PersistedAuthState;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveAuthStateFile(
  path: string,
  state: PersistedAuthState
): Promise<void> {
  await fs.writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

export async function clearAuthStateFile(path: string): Promise<void> {
  await fs.unlink(path).catch(() => undefined);
}

export function toAuthInfo(state: PersistedAuthState | null): Partial<AuthInfo> {
  if (!state) {
    return {};
  }
  return MacBid.parseAuthState(state);
}

export function hasPersistedTokens(state: PersistedAuthState | null): boolean {
  return !!(state?.token || state?.refresh_token);
}

export function isRefreshTokenExpired(state: PersistedAuthState | null): boolean {
  if (!state?.refresh_token_expiration) {
    return !hasPersistedTokens(state);
  }
  return Date.now() >= new Date(state.refresh_token_expiration).getTime();
}

export function hasActiveSession(state: PersistedAuthState | null): boolean {
  return hasPersistedTokens(state) && !isRefreshTokenExpired(state);
}

/**
 * Drop saved session when .env validation_code no longer matches what we stored.
 * - Logged in: only clear if a different code appears in .env (re-auth attempt).
 * - Pending 2FA: clear if the code was removed or changed after we recorded one.
 */
export function reconcileValidationCode(
  envCode: string | undefined,
  saved: PersistedAuthState | null
): { state: PersistedAuthState | null; cleared: boolean } {
  if (!saved) {
    return { state: null, cleared: false };
  }

  const savedCode = saved.validation_code;
  const hasTokens = !!(saved.token || saved.refresh_token);
  const pending2FA = !!(saved.device_id && !hasTokens);

  if (hasTokens) {
    if (envCode && savedCode && envCode !== savedCode) {
      return { state: null, cleared: true };
    }
    return { state: saved, cleared: false };
  }

  if (pending2FA && savedCode && (!envCode || envCode !== savedCode)) {
    return { state: null, cleared: true };
  }

  return { state: saved, cleared: false };
}

/** Avoid overwriting valid tokens when a re-login or code validation fails. */
export function shouldPersistAuthState(
  apiState: SerializableAuthState,
  previous: PersistedAuthState | null
): boolean {
  const apiHasTokens = !!(apiState.token || apiState.refresh_token);
  if (apiHasTokens) {
    return true;
  }

  const previousHasTokens = !!(previous?.token || previous?.refresh_token);
  if (previousHasTokens) {
    return false;
  }

  return !!apiState.device_id;
}

export function mergePersistedAuthState(
  apiState: SerializableAuthState,
  envCode: string | undefined,
  previous: PersistedAuthState | null
): PersistedAuthState {
  const hasTokens = !!(apiState.token || apiState.refresh_token);

  if (hasTokens && envCode) {
    return { ...apiState, validation_code: envCode };
  }

  if (hasTokens) {
    return { ...apiState, validation_code: previous?.validation_code };
  }

  if (envCode) {
    return { ...apiState, validation_code: envCode };
  }

  return { ...apiState };
}
