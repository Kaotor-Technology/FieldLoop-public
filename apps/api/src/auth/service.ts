import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  OidcRejectedError,
  type AuthStore,
  type AuthUser,
  type EnvelopeCrypto,
  type InternalTokenService,
  type LoginTokens,
  type OidcProvider,
} from "./model.js";

const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const INTROSPECTION_INTERVAL_MS = 60 * 1000;
const TOKEN_REFRESH_WINDOW_MS = 60 * 1000;
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const REAUTH_MAX_AGE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;
const DEFAULT_CLIENT_ID = "kaotor-fieldloop";
const ALLOWED_ROLES = new Set(["fieldloop.viewer", "fieldloop.operator", "fieldloop.manager"]);
const DEFAULT_PERSONA: Record<string, string> = {
  "fieldloop.viewer": "Executive",
  "fieldloop.operator": "Integrity Engineer",
  "fieldloop.manager": "Technical Authority",
};

export class AuthError extends Error {
  readonly code: "validation_failed" | "unauthenticated" | "csrf_token_invalid" | "forbidden" | "reauthentication_required" | "service_unavailable";

  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 403 | 503,
    code?: AuthError["code"],
  ) {
    super(message);
    this.name = "AuthError";
    this.code = code ?? ({ 400: "validation_failed", 401: "unauthenticated", 403: "forbidden", 503: "service_unavailable" } as const)[statusCode];
  }
}

export interface AuthServiceOptions {
  store: AuthStore;
  crypto: EnvelopeCrypto;
  oidc: OidcProvider;
  internalTokens: InternalTokenService;
  baseUrl: string;
  defaultOrgId: string;
  clientId?: string;
  now?: () => Date;
}

export interface LoginCompletion {
  sessionCookieValue: string;
  returnPath: string;
  authTime: Date;
}

export interface CurrentUser {
  sub: string;
  roles: string[];
  persona: string;
  orgId: string;
  clearance: string;
  csrfToken: string;
  authTime: Date;
}

export interface AuthServicePort {
  startLogin(returnPath: string): Promise<URL>;
  startReauthentication(sessionCookieValue: string | undefined, returnPath: string): Promise<URL>;
  completeLogin(callbackUrl: URL, existingCookieValue?: string): Promise<LoginCompletion>;
  getCurrentUser(sessionCookieValue: string | undefined, forceIntrospection?: boolean): Promise<CurrentUser>;
  /** Read-only identity for server-to-server calls made on behalf of a user (assistant tools). */
  getCurrentUserFromInternalToken?(token: string): Promise<CurrentUser>;
  issueInternalUserToken(sessionCookieValue: string | undefined): Promise<string>;
  logout(sessionCookieValue: string | undefined): Promise<URL>;
  backchannelLogout(token: string): Promise<void>;
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
}

export class BffAuthService implements AuthServicePort {
  private readonly now: () => Date;
  private readonly baseUrl: string;

  constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.baseUrl = new URL(options.baseUrl).origin;
  }

  async startLogin(returnPath: string): Promise<URL> {
    return this.createAuthorizationRedirect(safeReturnPath(returnPath), null, false);
  }

  async startReauthentication(sessionCookieValue: string | undefined, returnPath: string): Promise<URL> {
    if (!sessionCookieValue) throw new AuthError("Session required", 401);
    const user = await this.requireUser(sessionCookieValue, true);
    return this.createAuthorizationRedirect(safeReturnPath(returnPath), hash(sessionCookieValue), true, user.orgId);
  }

  async completeLogin(callbackUrl: URL, existingCookieValue?: string): Promise<LoginCompletion> {
    const state = callbackUrl.searchParams.get("state");
    if (!state) throw new AuthError("Missing OIDC state", 400);
    const transaction = await this.options.store.consumeTransaction(hash(state));
    if (!transaction || transaction.expiresAt.getTime() <= this.now().getTime()) {
      throw new AuthError("OIDC login transaction is missing or expired", 400);
    }
    if (callbackUrl.searchParams.has("error")) throw new AuthError("Keycloak sign-in was not completed", 401);
    if (!callbackUrl.searchParams.get("code")) throw new AuthError("Missing OIDC authorization code", 400);

    const codeVerifier = await this.options.crypto.decryptWithKey(
      transaction.encryptedCodeVerifier,
      transaction.wrappedDataKey,
      `oidc:${transaction.stateHash}:pkce`,
    );
    const reauth = transaction.reauthSessionHash !== null;
    const sessionCookieValue = reauth ? existingCookieValue : createOpaqueSessionId();
    if (!sessionCookieValue) throw new AuthError("The session to reauthenticate is no longer available", 401);
    const sessionHash = hash(sessionCookieValue);
    if (reauth && sessionHash !== transaction.reauthSessionHash) {
      throw new AuthError("Reauthentication session did not match", 401);
    }

    const now = this.now();
    const tokens = await this.options.oidc
      .exchange({
        callbackUrl,
        state,
        nonce: transaction.nonce,
        codeVerifier,
        ...(reauth ? { maxAge: 0 as const } : {}),
      })
      .catch((error: unknown) => {
        if (error instanceof OidcRejectedError) throw new AuthError("Keycloak sign-in was not completed", 401);
        throw error;
      });
    const identity = identityFrom(tokens, this.options.clientId ?? DEFAULT_CLIENT_ID, reauth);
    if (reauth && !isRecentAuthTime(identity.authTime, now)) {
      throw new AuthError("Keycloak did not confirm a recent reauthentication", 401);
    }
    if (reauth) {
      const previous = await this.options.store.findSession(sessionHash);
      if (!previous || previous.sub !== identity.sub || previous.orgId !== transaction.orgId) {
        await this.options.store.deleteSession(sessionHash);
        throw new AuthError("Reauthentication identity did not match the active session", 401);
      }
    }

    const encryptedAccess = await this.options.crypto.encryptNew(tokens.accessToken, `session:${sessionHash}:access`);
    const encryptedRefresh = tokens.refreshToken
      ? await this.options.crypto.encryptWithKey(tokens.refreshToken, encryptedAccess.wrappedDataKey, `session:${sessionHash}:refresh`)
      : null;
    const encryptedId = await this.options.crypto.encryptWithKey(tokens.idToken, encryptedAccess.wrappedDataKey, `session:${sessionHash}:id`);
    const csrfToken = createOpaqueSessionId();
    const accessExpiresAt = new Date(now.getTime() + Math.max(tokens.expiresIn, 1) * 1000);
    const existing = reauth ? await this.options.store.findSession(sessionHash) : undefined;
    const expiresAt = existing?.expiresAt ?? new Date(now.getTime() + SESSION_ABSOLUTE_MS);

    await this.options.store.saveSession({
      sessionHash,
      existingSessionHash: reauth ? sessionHash : null,
      orgId: transaction.orgId,
      sub: identity.sub,
      displayName: identity.displayName,
      sid: identity.sid,
      roles: identity.roles,
      clearance: identity.clearance,
      csrfToken,
      authTime: identity.authTime,
      lastValidatedAt: now,
      lastActiveAt: now,
      accessExpiresAt,
      expiresAt,
      wrappedDataKey: encryptedAccess.wrappedDataKey,
      accessToken: encryptedAccess.ciphertext,
      refreshToken: encryptedRefresh,
      idToken: encryptedId,
    });

    return { sessionCookieValue, returnPath: safeReturnPath(transaction.returnPath), authTime: identity.authTime };
  }

  async getCurrentUser(sessionCookieValue: string | undefined, forceIntrospection = false): Promise<CurrentUser> {
    const user = await this.requireUser(sessionCookieValue, forceIntrospection);
    return {
      sub: user.sub,
      roles: user.roles,
      persona: user.roles.map((role) => DEFAULT_PERSONA[role]).find(Boolean) ?? "User",
      orgId: user.orgId,
      clearance: user.clearance,
      csrfToken: user.csrfToken,
      authTime: user.authTime,
    };
  }

  async getCurrentUserFromInternalToken(token: string): Promise<CurrentUser> {
    const verify = this.options.internalTokens.verify?.bind(this.options.internalTokens);
    if (!verify) throw new AuthError("Internal user tokens cannot be verified", 503);
    let claims;
    try {
      claims = await verify(token);
    } catch {
      throw new AuthError("Internal user token failed verification", 401);
    }
    const roles = claims.roles.filter((role) => ALLOWED_ROLES.has(role));
    if (roles.length === 0 || claims.orgId !== this.options.defaultOrgId) {
      throw new AuthError("Internal user token is not valid for this Organisation", 403);
    }
    return {
      sub: claims.sub,
      roles,
      persona: roles.map((role) => DEFAULT_PERSONA[role]).find(Boolean) ?? "User",
      orgId: claims.orgId,
      clearance: claims.clearance,
      // Never usable for a state change: no CSRF secret and no recent authentication.
      csrfToken: "",
      authTime: new Date(0),
    };
  }

  async issueInternalUserToken(sessionCookieValue: string | undefined): Promise<string> {
    const user = await this.requireUser(sessionCookieValue);
    return this.options.internalTokens.sign(user);
  }

  async jwks(): Promise<{ keys: Record<string, unknown>[] }> {
    return this.options.internalTokens.jwks();
  }

  async logout(sessionCookieValue: string | undefined): Promise<URL> {
    if (!sessionCookieValue) return new URL("/", this.baseUrl);
    const sessionHash = hash(sessionCookieValue);
    const session = await this.options.store.findSession(sessionHash);
    await this.options.store.deleteSession(sessionHash);
    if (!session) return new URL("/", this.baseUrl);
    try {
      const idToken = await this.options.crypto.decryptWithKey(session.idToken, session.wrappedDataKey, `session:${sessionHash}:id`);
      return await this.options.oidc.endSessionUrl(idToken, new URL("/", this.baseUrl).toString());
    } catch {
      // The local session is already deleted; keep logout complete if the IdP redirect cannot be built.
      return new URL("/", this.baseUrl);
    }
  }

  async backchannelLogout(token: string): Promise<void> {
    const { sid } = await this.options.oidc.verifyBackchannelLogout(token).catch((error: unknown) => {
      if (error instanceof OidcRejectedError) throw new AuthError("Invalid back-channel logout token", 400);
      throw error;
    });
    await this.options.store.deleteSessionsBySid(sid);
  }

  private async createAuthorizationRedirect(
    returnPath: string,
    reauthSessionHash: string | null,
    forceLogin: boolean,
    orgId = this.options.defaultOrgId,
  ): Promise<URL> {
    const state = randomSecret();
    const nonce = randomSecret();
    const codeVerifier = randomSecret();
    const stateHash = hash(state);
    const encryptedVerifier = await this.options.crypto.encryptNew(codeVerifier, `oidc:${stateHash}:pkce`);
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const redirectUri = new URL("/api/auth/callback", this.baseUrl).toString();
    const expiresAt = new Date(this.now().getTime() + TRANSACTION_TTL_MS);

    await this.options.store.createTransaction({
      stateHash,
      nonce,
      encryptedCodeVerifier: encryptedVerifier.ciphertext,
      wrappedDataKey: encryptedVerifier.wrappedDataKey,
      returnPath,
      reauthSessionHash,
      orgId,
      expiresAt,
    });

    return this.options.oidc.authorizationUrl({
      redirectUri,
      state,
      nonce,
      codeChallenge: challenge,
      ...(forceLogin ? { prompt: "login" as const, maxAge: 0 as const } : {}),
    });
  }

  private async requireUser(sessionCookieValue: string | undefined, forceIntrospection = false): Promise<AuthUser> {
    if (!sessionCookieValue) throw new AuthError("Session required", 401);
    const sessionHash = hash(sessionCookieValue);
    let user = await this.options.store.findSession(sessionHash);
    if (!user) throw new AuthError("Session required", 401);

    const now = this.now();
    if (
      user.expiresAt.getTime() <= now.getTime() ||
      user.lastActiveAt.getTime() + SESSION_IDLE_MS <= now.getTime()
    ) {
      await this.options.store.deleteSession(sessionHash);
      throw new AuthError("Session expired", 401);
    }

    const shouldRefresh = user.accessExpiresAt.getTime() <= now.getTime() + TOKEN_REFRESH_WINDOW_MS;
    const shouldIntrospect = forceIntrospection || user.lastValidatedAt.getTime() + INTROSPECTION_INTERVAL_MS <= now.getTime();
    let didIntrospect = false;
    if (shouldIntrospect && user.accessExpiresAt.getTime() > now.getTime()) {
      user = await this.introspectOrThrow(sessionHash, user, now);
      didIntrospect = true;
    }

    if (shouldRefresh && user.refreshToken) {
      const refreshToken = await this.options.crypto.decryptWithKey(user.refreshToken, user.wrappedDataKey, `session:${sessionHash}:refresh`);
      const refreshed = await this.options.oidc.refresh(refreshToken).catch(async (error: unknown) => {
        if (!(error instanceof OidcRejectedError)) throw error;
        await this.options.store.deleteSession(sessionHash);
        throw new AuthError("Session is no longer active", 401);
      });
      const encryptedAccess = await this.options.crypto.encryptWithKey(refreshed.accessToken, user.wrappedDataKey, `session:${sessionHash}:access`);
      const encryptedRefresh = refreshed.refreshToken
        ? await this.options.crypto.encryptWithKey(refreshed.refreshToken, user.wrappedDataKey, `session:${sessionHash}:refresh`)
        : user.refreshToken;
      await this.options.store.updateTokens({
        sessionHash,
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        accessExpiresAt: new Date(now.getTime() + Math.max(refreshed.expiresIn, 1) * 1000),
        lastValidatedAt: user.lastValidatedAt,
      });
      user = {
        ...user,
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        accessExpiresAt: new Date(now.getTime() + Math.max(refreshed.expiresIn, 1) * 1000),
        lastValidatedAt: user.lastValidatedAt,
      };
    }

    if (user.accessExpiresAt.getTime() <= now.getTime()) {
      await this.options.store.deleteSession(sessionHash);
      throw new AuthError("Session access token expired", 401);
    }

    if (shouldIntrospect && !didIntrospect) {
      user = await this.introspectOrThrow(sessionHash, user, now);
    }

    await this.options.store.touchSession(sessionHash, now);
    return { ...user, lastActiveAt: now };
  }

  private async introspectOrThrow(sessionHash: string, user: AuthUser, now: Date): Promise<AuthUser> {
    const accessToken = await this.options.crypto.decryptWithKey(user.accessToken, user.wrappedDataKey, `session:${sessionHash}:access`);
    if (!(await this.options.oidc.introspect(accessToken))) {
      await this.options.store.deleteSession(sessionHash);
      throw new AuthError("Session is no longer active", 401);
    }
    await this.options.store.markSessionValidated(sessionHash, now);
    return { ...user, lastValidatedAt: now };
  }
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  try {
    const parsed = new URL(value, "https://fieldloop.invalid");
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

export function isRecentAuthTime(authTime: Date, now: Date): boolean {
  const authAgeMs = now.getTime() - authTime.getTime();
  return authAgeMs >= -CLOCK_SKEW_MS && authAgeMs < REAUTH_MAX_AGE_MS;
}

export function csrfMatches(expected: string, received: string | undefined): boolean {
  if (!received || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function createOpaqueSessionId(): string {
  return randomSecret();
}

function identityFrom(tokens: LoginTokens, clientId: string, requireAuthTime = false): {
  sub: string;
  displayName: string | null;
  sid: string | null;
  roles: string[];
  clearance: string;
  authTime: Date;
} {
  const sub = stringClaim(tokens.claims["sub"]);
  const authTime = numberClaim(tokens.claims["auth_time"]) ?? (requireAuthTime ? undefined : numberClaim(tokens.claims["iat"]));
  const resourceAccess = tokens.accessClaims["resource_access"];
  const clientRoles =
    resourceAccess && typeof resourceAccess === "object"
      ? (resourceAccess as Record<string, unknown>)[clientId]
      : undefined;
  const candidateRoles = clientRoles && typeof clientRoles === "object" ? (clientRoles as Record<string, unknown>)["roles"] : undefined;
  const roles = Array.isArray(candidateRoles)
    ? candidateRoles.filter((role): role is string => typeof role === "string" && ALLOWED_ROLES.has(role))
    : [];

  if (!sub || !authTime || roles.length === 0) {
    throw new AuthError("Keycloak identity is missing a subject, auth time or supported role", 401);
  }
  const expiresAt = numberClaim(tokens.accessClaims["exp"]);
  if (expiresAt !== undefined && expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new AuthError("Keycloak access token is expired", 401);
  }

  return {
    sub,
    displayName: stringClaim(tokens.claims["name"]) ?? stringClaim(tokens.claims["preferred_username"]) ?? null,
    sid: stringClaim(tokens.claims["sid"]) ?? stringClaim(tokens.accessClaims["sid"]) ?? null,
    roles,
    clearance: stringClaim(tokens.accessClaims["clearance"]) ?? "INTERNAL",
    authTime: new Date(authTime * 1000),
  };
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberClaim(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
