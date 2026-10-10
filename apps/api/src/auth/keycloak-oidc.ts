import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  buildEndSessionUrl,
  ClientSecretBasic,
  discovery,
  refreshTokenGrant,
  tokenIntrospection,
  type Configuration,
} from "openid-client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { LoginTokens, OidcProvider } from "./model.js";

const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

export class KeycloakOidcProvider implements OidcProvider {
  private configurationPromise: Promise<Configuration> | undefined;
  private jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly clientSecret: () => Promise<string>,
  ) {}

  async authorizationUrl(input: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    prompt?: "login";
    maxAge?: 0;
  }): Promise<URL> {
    const config = await this.configuration();
    return buildAuthorizationUrl(config, {
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: "openid profile email",
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.maxAge !== undefined ? { max_age: String(input.maxAge) } : {}),
    });
  }

  async exchange(input: {
    callbackUrl: URL;
    state: string;
    nonce: string;
    codeVerifier: string;
    maxAge?: 0;
  }): Promise<LoginTokens> {
    const config = await this.configuration();
    const response = await authorizationCodeGrant(config, input.callbackUrl, {
      expectedState: input.state,
      expectedNonce: input.nonce,
      pkceCodeVerifier: input.codeVerifier,
      ...(input.maxAge !== undefined ? { maxAge: input.maxAge } : {}),
    });
    return this.tokensFrom(response);
  }

  async introspect(accessToken: string): Promise<boolean> {
    const response = await tokenIntrospection(await this.configuration(), accessToken, {
      token_type_hint: "access_token",
    });
    return response.active === true;
  }

  async refresh(refreshToken: string): Promise<LoginTokens> {
    const response = await refreshTokenGrant(await this.configuration(), refreshToken);
    const accessToken = response.access_token;
    if (!accessToken) throw new Error("Keycloak did not return an access token during refresh");
    return {
      accessToken,
      refreshToken: response.refresh_token ?? refreshToken,
      idToken: response.id_token ?? "",
      claims: response.claims() ? { ...response.claims() } : {},
      accessClaims: await this.verifyAccessToken(accessToken),
      expiresIn: response.expiresIn() ?? 300,
    };
  }

  async endSessionUrl(idToken: string, postLogoutRedirectUri: string): Promise<URL> {
    return buildEndSessionUrl(await this.configuration(), {
      id_token_hint: idToken,
      post_logout_redirect_uri: postLogoutRedirectUri,
    });
  }

  async verifyBackchannelLogout(token: string): Promise<{ sid: string }> {
    const { payload } = await jwtVerify(token, await this.jwks(), {
      issuer: this.issuer,
      audience: this.clientId,
      algorithms: ["RS256"],
    });
    const events = payload["events"];
    const sid = payload["sid"];
    if (
      typeof sid !== "string" ||
      !sid ||
      typeof payload["jti"] !== "string" ||
      payload["nonce"] !== undefined ||
      !events ||
      typeof events !== "object" ||
      !(LOGOUT_EVENT in events)
    ) {
      throw new Error("Invalid Keycloak back-channel logout token");
    }
    return { sid };
  }

  private async configuration(): Promise<Configuration> {
    if (!this.configurationPromise) {
      this.configurationPromise = (async () => {
        const secret = await this.clientSecret();
        return discovery(new URL(this.issuer), this.clientId, { client_secret: secret }, ClientSecretBasic(secret));
      })();
    }
    try {
      return await this.configurationPromise;
    } catch (error) {
      this.configurationPromise = undefined;
      throw error;
    }
  }

  private async jwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (!this.jwksPromise) {
      this.jwksPromise = (async () => {
        const metadata = (await this.configuration()).serverMetadata();
        const uri = metadata.jwks_uri;
        if (!uri) throw new Error("Keycloak discovery metadata has no JWKS URI");
        return createRemoteJWKSet(new URL(uri));
      })();
    }
    try {
      return await this.jwksPromise;
    } catch (error) {
      this.jwksPromise = undefined;
      throw error;
    }
  }

  private async verifyAccessToken(token: string): Promise<Record<string, unknown>> {
    const { payload } = await jwtVerify(token, await this.jwks(), {
      issuer: this.issuer,
      algorithms: ["RS256"],
    });
    const clientId = payload["azp"] ?? payload["client_id"];
    const audiences = Array.isArray(payload["aud"]) ? payload["aud"] : [payload["aud"]];
    if (clientId !== this.clientId && !audiences.includes(this.clientId)) {
      throw new Error("Keycloak access token was not issued for this BFF client");
    }
    return payload;
  }

  private async tokensFrom(response: Awaited<ReturnType<typeof authorizationCodeGrant>>): Promise<LoginTokens> {
    const accessToken = response.access_token;
    const idToken = response.id_token;
    if (!accessToken || !idToken) throw new Error("Keycloak did not return required OIDC tokens");
    return {
      accessToken,
      refreshToken: response.refresh_token ?? null,
      idToken,
      claims: response.claims() ? { ...response.claims() } : {},
      accessClaims: await this.verifyAccessToken(accessToken),
      expiresIn: response.expiresIn() ?? 300,
    };
  }
}
