export interface EngineHandle {
  /** Live auth-proxy port. */
  port: number;
  /** X-RaioPDF-Auth token the proxy expects. */
  token: string;
  /** `http://127.0.0.1:<port>`. */
  baseUrl: string;
  /** Gracefully shut the engine down and clean up its temp app-data dir. */
  stop: () => Promise<void>;
}

export function bootPayloadEngine(options?: {
  payloadDir?: string;
  hostBin?: string;
  readyTimeoutMs?: number;
}): Promise<EngineHandle>;
