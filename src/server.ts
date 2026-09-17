import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client";
import { OpenCode as LegacyOpenCode } from "@opencode/client-legacy";
import { Service as LegacyService } from "@opencode/client-legacy/service";
import { isChildSession } from "./session.js";

/** Client protocol generation, matched to the daemon's service protocol. */
export type ServiceGeneration = "legacy" | "new";

export interface ConnectServerDeps {
  /** Selects the SDK line whose Service.ensure() speaks the daemon's protocol (/api/status vs /api/info). */
  generation?: ServiceGeneration;
  ensure?: typeof Service.ensure;
  headers?: typeof Service.headers;
}

export interface ServerConnection {
  url: string;
  client: OpenCodeClient;
}

/** Connects to the shared local opencode service (injectable for tests). */
export async function connectServer(deps: ConnectServerDeps = {}): Promise<ServerConnection> {
  const legacy = deps.generation === "legacy";
  const service = legacy ? LegacyService : Service;
  const ensure = deps.ensure ?? service.ensure;
  const headers = deps.headers ?? service.headers;
  const endpoint = await ensure();
  // Legacy 2.0.5's generated client has the same public session/event surface as 2.0.6
  // but different internal RpcClient typings; adapt with a narrow cast at the boundary.
  const client = legacy
    ? (LegacyOpenCode.make({ baseUrl: endpoint.url, headers: headers(endpoint) }) as unknown as OpenCodeClient)
    : OpenCode.make({ baseUrl: endpoint.url, headers: headers(endpoint) });
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
