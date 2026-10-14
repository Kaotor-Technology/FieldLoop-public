export interface AuthUser {
  userId: string;
  orgId: string;
  sub: string;
  displayName: string | null;
  sid: string | null;
  roles: string[];
  clearance: string;
  csrfToken: string;
  authTime: Date;
  lastValidatedAt: Date;
  lastActiveAt: Date;
  accessExpiresAt: Date;
  expiresAt: Date;
  wrappedDataKey: Buffer;
  accessToken: Buffer;
  refreshToken: Buffer | null;
  idToken: Buffer;
}

export interface OidcTransaction {
  stateHash: string;
  nonce: string;
  encryptedCodeVerifier: Buffer;
  wrappedDataKey: Buffer;
  returnPath: string;
  reauthSessionHash: string | null;
  orgId: string;
  expiresAt: Date;
}

export interface LoginTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string;
  claims: Record<string, unknown>;
  accessClaims: Record<string, unknown>;
  expiresIn: number;
}

// The identity provider gave a definitive refusal, as opposed to being unreachable.
export class OidcRejectedError extends Error {
  override readonly name = "OidcRejectedError";
}

export interface AuthStore {
  createTransaction(transaction: OidcTransaction): Promise<void>;
  consumeTransaction(stateHash: string): Promise<OidcTransaction | undefined>;
  findSession(sessionHash: string): Promise<AuthUser | undefined>;
  markSessionValidated(sessionHash: string, lastValidatedAt: Date): Promise<void>;
  saveSession(input: {
    sessionHash: string;
    existingSessionHash: string | null;
    orgId: string;
    sub: string;
    displayName: string | null;
    sid: string | null;
    roles: string[];
    clearance: string;
    csrfToken: string;
    authTime: Date;
    lastValidatedAt: Date;
    lastActiveAt: Date;
    accessExpiresAt: Date;
    expiresAt: Date;
    wrappedDataKey: Buffer;
    accessToken: Buffer;
    refreshToken: Buffer | null;
    idToken: Buffer;
  }): Promise<void>;
  touchSession(sessionHash: string, lastActiveAt: Date): Promise<void>;
  updateTokens(input: {
    sessionHash: string;
    accessToken: Buffer;
    refreshToken: Buffer | null;
    accessExpiresAt: Date;
    lastValidatedAt: Date;
  }): Promise<void>;
  deleteSession(sessionHash: string): Promise<void>;
  deleteSessionsBySid(sid: string): Promise<void>;
}

export interface OidcProvider {
  authorizationUrl(input: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    prompt?: "login";
    maxAge?: 0;
  }): Promise<URL>;
  exchange(input: {
    callbackUrl: URL;
    state: string;
    nonce: string;
    codeVerifier: string;
    maxAge?: 0;
  }): Promise<LoginTokens>;
  introspect(accessToken: string): Promise<boolean>;
  refresh(refreshToken: string): Promise<LoginTokens>;
  endSessionUrl(idToken: string, postLogoutRedirectUri: string): Promise<URL>;
  verifyBackchannelLogout(token: string): Promise<{ sid: string }>;
}

export interface EnvelopeCrypto {
  encryptNew(value: string, additionalData?: string): Promise<{ ciphertext: Buffer; wrappedDataKey: Buffer }>;
  encryptWithKey(value: string, wrappedDataKey: Buffer, additionalData?: string): Promise<Buffer>;
  decryptWithKey(ciphertext: Buffer, wrappedDataKey: Buffer, additionalData?: string): Promise<string>;
}

export interface InternalTokenClaims {
  sub: string;
  roles: string[];
  clearance: string;
  orgId: string;
}

export interface InternalTokenService {
  sign(user: AuthUser): Promise<string>;
  /** Verifies a token this service minted; used to let the assistant read as the user. */
  verify?(token: string): Promise<InternalTokenClaims>;
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
}
