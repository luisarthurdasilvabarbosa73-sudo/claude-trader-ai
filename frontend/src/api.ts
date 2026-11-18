// As telas continuam pedindo "/api/...", mas agora quem responde é o robô rodando
// dentro do próprio app (src/core/runtime.ts). Não há servidor.
import { LocalApiError, localApi } from "./core/runtime.ts";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    const res = await localApi(path, options.method ?? "GET", (options.body ?? {}) as Record<string, unknown>);
    // cópia "limpa" (as telas nunca alteram o estado interno do robô por engano)
    return JSON.parse(JSON.stringify(res)) as T;
  } catch (e) {
    if (e instanceof LocalApiError) throw new ApiError(e.message, e.status);
    throw new ApiError(e instanceof Error ? e.message : String(e), 500);
  }
}
