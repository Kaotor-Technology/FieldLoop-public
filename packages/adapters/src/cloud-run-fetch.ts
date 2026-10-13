import { GoogleAuth } from "google-auth-library";

export type ServiceFetch = (request: Request) => Promise<Response>;

interface InvokerIdentity {
  getIdTokenClient(audience: string): Promise<{ getRequestHeaders(url: string): Promise<Headers> }>;
}

export function createCloudRunFetch(baseUrl: string, auth: InvokerIdentity = new GoogleAuth(), transport: typeof fetch = fetch): ServiceFetch {
  const origin = new URL(baseUrl).origin;
  if (!origin.startsWith("https://")) throw new Error("Cloud Run requires HTTPS");
  let client: ReturnType<InvokerIdentity["getIdTokenClient"]> | undefined;
  return async (request) => {
    if (new URL(request.url).origin !== origin) throw new Error("Service request escaped the configured origin");
    client ??= auth.getIdTokenClient(origin);
    let authentication: Headers;
    try { authentication = await (await client).getRequestHeaders(origin); }
    catch (error) { client = undefined; throw error; }
    const authorization = authentication.get("authorization");
    if (!authorization) throw new Error("Invoker identity is unavailable");
    const headers = new Headers(request.headers);
    headers.set("authorization", authorization);
    return transport(new Request(request, { headers, redirect: "error" }));
  };
}
