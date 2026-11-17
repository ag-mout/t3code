import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import type { DesktopServerExposureState } from "@t3tools/contracts";

import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";

export interface WslLanForwardPlan {
  readonly listenPort: number;
  readonly targetHost: string;
  readonly targetPort: number;
  /** Try wildcard first so a later DHCP address still reaches the forwarder. */
  readonly listenHosts: readonly string[];
}

const portOf = (url: URL): number | null => {
  const port = url.port.length > 0 ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
};

/** Windows addresses the WSL server should publish. Empty hides the unreachable distro NIC. */
export const lanHostsFromExposure = (
  exposure: Pick<DesktopServerExposureState, "mode" | "advertisedHost">,
): ReadonlyArray<string> =>
  exposure.mode === "network-accessible" && exposure.advertisedHost !== null
    ? [exposure.advertisedHost]
    : [];

/**
 * NAT WSL listens on a distro address other devices cannot route to. Mirrored
 * networking already binds the Windows interfaces, so it needs no forwarder.
 */
export const planWslLanForward = (input: {
  readonly config: Pick<DesktopBackendStartConfig, "executablePath" | "httpBaseUrl">;
  readonly exposure: Pick<DesktopServerExposureState, "mode" | "advertisedHost">;
}): WslLanForwardPlan | null => {
  if (input.config.executablePath !== "wsl.exe") return null;
  if (input.exposure.mode !== "network-accessible" || input.exposure.advertisedHost === null) {
    return null;
  }
  const targetHost = input.config.httpBaseUrl.hostname;
  if (isLocalLoopbackHost(targetHost) || targetHost === input.exposure.advertisedHost) return null;
  const listenPort = portOf(input.config.httpBaseUrl);
  if (listenPort === null) return null;
  return {
    listenPort,
    targetHost,
    targetPort: listenPort,
    listenHosts: ["0.0.0.0", input.exposure.advertisedHost],
  };
};

export const wslTailscaleTarget = (
  config: Pick<DesktopBackendStartConfig, "executablePath" | "httpBaseUrl">,
): { readonly localHost: string; readonly localPort: number } | null => {
  if (config.executablePath !== "wsl.exe") return null;
  const localPort = portOf(config.httpBaseUrl);
  if (localPort === null) return null;
  return { localHost: config.httpBaseUrl.hostname, localPort };
};
