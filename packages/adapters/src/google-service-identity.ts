import { OAuth2Client } from "google-auth-library";

export interface ServiceIdentityVerifier {
  verify(token: string, audience: string, email: string): Promise<void>;
}

/** Verify signature, issuer, expiry and audience with Google's cached certificate client. */
export class GoogleServiceIdentityVerifier implements ServiceIdentityVerifier {
  constructor(private readonly client: Pick<OAuth2Client, "verifyIdToken"> = new OAuth2Client()) {}
  async verify(token: string, audience: string, email: string): Promise<void> {
    const ticket = await this.client.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!payload || payload.email !== email || payload.email_verified !== true || !payload.sub) {
      throw new Error("Unexpected Google service identity");
    }
  }
}
