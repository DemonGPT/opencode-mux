import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client";
import { isChildSession } from "./session.js";

export interface ConnectServerDeps {
  ensure?: typeof Service.ensure;
  headers?: typeof Service.headers;
}

export interface ServerConnection {
  url: string;
  client: OpenCodeClient;
}

/** Connects to the shared local opencode service (injectable for tests). */
export async function connectServer(deps: ConnectServerDeps = {}): Promise<ServerConnection> {
  const ensure = deps.ensure ?? Service.ensure;
  const headers = deps.headers ?? Service.headers;
  const endpoint = await ensure();
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: headers(endpoint) });
  return { url: endpoint.url, client };
}

/** Adopts already-existing child sessions; parentID null means watch all. */
export async function childSessions(client: OpenCodeClient, parentID: string | null): Promise<SessionInfo[]> {
  const response = await client.session.list(parentID === null ? {} : { parentID });
  return response.data.filter(isChildSession);
}

/** Live event stream; ends when the server restarts (watcher exits, next launch resumes). */
export async function events(client: OpenCodeClient, signal: AbortSignal): Promise<AsyncIterable<OpenCodeEvent>> {
  return client.event.subscribe({ signal });
}
