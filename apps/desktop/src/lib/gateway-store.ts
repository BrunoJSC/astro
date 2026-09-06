import type { ServerFrame } from "@repo/server/gateway/model";
import { create } from "zustand";
import { env } from "../env";
import {
  createGatewayClient,
  type GatewayClient,
  type GatewayStatus,
  type GatewayTopic,
} from "./gateway";

/**
 * One gateway connection for the whole app.
 *
 * A store rather than a hook that owns the socket: several components care
 * about presence and typing, and a hook per component would open a socket per
 * component. The connection belongs to the process, not to a subtree.
 *
 * `client` is created lazily on `connect` so that importing this module -- which
 * `app.tsx` does at load -- does not open a socket before the token is read.
 */

interface GatewayState {
  client: GatewayClient | null;
  connect: () => void;
  disconnect: () => void;
  /** The last frame received, for the connection panel. */
  lastFrame: ServerFrame | null;
  status: GatewayStatus;
  subscribe: (topic: GatewayTopic) => void;
  /** Typing users per channel, replaced whenever the server sends the list. */
  typing: Record<string, string[]>;
  unsubscribe: (topic: GatewayTopic) => void;
}

export const useGateway = create<GatewayState>((set, get) => ({
  client: null,

  connect: () => {
    if (get().client) {
      return;
    }

    const client = createGatewayClient({
      apiUrl: env.VITE_API_URL,
      onFrame: (frame) => {
        set({ lastFrame: frame });

        if (frame.op === "typing") {
          set((state) => ({
            typing: {
              ...state.typing,
              [frame.channelId]: frame.users.map((entry) => entry.userId),
            },
          }));
        }
      },
      onStatus: (status) => set({ status }),
    });

    client.connect();
    set({ client });
  },

  disconnect: () => {
    get().client?.close();
    set({ client: null, status: "closed" });
  },

  lastFrame: null,
  status: "closed",
  subscribe: (topic) => get().client?.subscribe(topic),
  typing: {},
  unsubscribe: (topic) => get().client?.unsubscribe(topic),
}));
