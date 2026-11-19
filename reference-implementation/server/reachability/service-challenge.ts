// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Answers the library's service challenge on this listener. A route that the
// owner keeps (own-address) is proven by asking the public origin for a signed
// nonce; the answer must come from the process that listens on the declared
// target port. Without this route that proof fails and the route stays
// unpublished. The library verifier answers for any Host, so this route also
// refuses every Host the owner has not approved. Registered before the RS host check because the challenge
// arrives with the public Host, which that check does not know.
type Verifier = (req: unknown, res: unknown) => boolean;
type Reply = {
  header(name: string, value: string): Reply;
  send(body?: string): Reply;
  status(code: number): Reply;
};
type App = {
  get(path: string, handler: (request: { raw: unknown }, response: Reply) => void): unknown;
};

export const SERVICE_CHALLENGE_PATH = "/.well-known/gozar/service";

export function mountServiceChallenge(
  app: App,
  verify: Verifier,
  approves: (authority: string) => boolean
): void {
  app.get(SERVICE_CHALLENGE_PATH, (request, response) => {
    // The verifier writes with the Node response API; collect that and reply
    // through the transport so the request lifecycle stays whole.
    const answer: { status: number; headers: Record<string, string>; body: string } = {
      body: "",
      headers: {},
      status: 200,
    };
    const collector = {
      end(body?: string) {
        answer.body = body ?? "";
      },
      writeHead(status: number, headers: Record<string, string>) {
        answer.status = status;
        answer.headers = headers;
      },
    };
    if (!(verify(request.raw, collector) && approves(answeredAuthority(answer.body)))) {
      response.status(404).header("content-type", "application/json").send('{"error":{"code":"not_found"}}');
      return;
    }
    let reply = response.status(answer.status);
    for (const [name, value] of Object.entries(answer.headers)) {
      reply = reply.header(name, value);
    }
    reply.send(answer.body);
  });
}

// The verifier puts the canonical Host it saw into its answer, so the approval
// check uses the library's own canonicalisation instead of a second one.
function answeredAuthority(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const authority = (parsed as { authority?: unknown } | null)?.authority;
    return typeof authority === "string" ? authority : "";
  } catch {
    return "";
  }
}
