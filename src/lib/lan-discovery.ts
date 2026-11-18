import dgram from "node:dgram";
import os from "node:os";
import type { AddressInfo } from "node:net";

export const DISCOVERY_UDP_PORT = 41234;
export const DISCOVERY_PROBE_MAGIC = "TWINKLEBOT_DISCOVER_V1";

export interface DiscoveryInfo {
  ok: true;
  instanceId: string;
  hostname: string;
  platform: string;
  port: number;
  appVersion: string;
  lanAccessEnabled: boolean;
  pairingRequired: true;
}

export interface DiscoveryResponder {
  address(): AddressInfo;
  close(): Promise<void>;
}

export function buildDiscoveryInfo({
  instanceId = "",
  hostname = os.hostname(),
  platform = process.platform,
  port = 3230,
  appVersion = "1.0.0",
  lanAccessEnabled = false,
}: {
  instanceId?: string;
  hostname?: string;
  platform?: string;
  port?: number;
  appVersion?: string;
  lanAccessEnabled?: boolean;
} = {}): DiscoveryInfo {
  return {
    ok: true,
    instanceId: String(instanceId || "").trim(),
    hostname: String(hostname || os.hostname()).trim(),
    platform: String(platform || process.platform).trim(),
    port: Number(port) || 3230,
    appVersion: String(appVersion || "1.0.0").trim(),
    lanAccessEnabled: Boolean(lanAccessEnabled),
    pairingRequired: true,
  };
}

export function startLanDiscoveryResponder({
  port = DISCOVERY_UDP_PORT,
  bindAddress = "0.0.0.0",
  getInfo = () => buildDiscoveryInfo(),
}: {
  port?: number;
  bindAddress?: string;
  getInfo?: () => DiscoveryInfo | null | undefined;
} = {}): Promise<DiscoveryResponder> {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("message", (msg, rinfo) => {
    const text = msg.toString("utf8").trim();
    if (text !== DISCOVERY_PROBE_MAGIC) return;
    let info: DiscoveryInfo | null | undefined;
    try {
      info = getInfo();
    } catch {
      return;
    }
    if (!info || info.lanAccessEnabled === false) return;
    const payload = Buffer.from(
      JSON.stringify({
        type: "TWINKLEBOT_OFFER_V1",
        ...info,
      }),
      "utf8"
    );
    socket.send(payload, rinfo.port, rinfo.address, () => {});
  });

  socket.on("error", () => {
    // Ignore UDP bind/network errors so desktop server never crashes
  });

  return new Promise((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    socket.once("error", onErr);
    socket.bind(port, bindAddress, () => {
      socket.off("error", onErr);
      try {
        socket.setBroadcast(true);
      } catch {}
      resolve({
        address: () => socket.address(),
        close: () =>
          new Promise<void>((res) => {
            try {
              socket.close(() => res());
            } catch {
              res();
            }
          }),
      });
    });
  });
}

export default {
  DISCOVERY_UDP_PORT,
  DISCOVERY_PROBE_MAGIC,
  buildDiscoveryInfo,
  startLanDiscoveryResponder,
};
