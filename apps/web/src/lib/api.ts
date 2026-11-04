"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");

export function wsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;
  if (API_URL.startsWith("http")) return API_URL.replace(/^http/, "ws") + "/live";
  // Relative API URL (behind Nginx): same host, /live.
  if (typeof window !== "undefined") return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`;
  return "ws://localhost:4000/live";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The API's error code, e.g. "fresh_sign_in_required". */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The only IPFS gateway coin images load from (CSP img-src allows just this origin). */
export const IPFS_GATEWAY = (process.env.NEXT_PUBLIC_IPFS_GATEWAY || "https://gateway.pinata.cloud/ipfs/").replace(/\/?$/, "/");

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, { signal, headers: { accept: "application/json" }, cache: "no-store" });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Can't reach the Backflow API.");
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) msg = body.message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export interface UseApi<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  setData: (fn: (prev: T | null) => T | null) => void;
}

/** Minimal fetch hook. Pass `null` as path to skip. Keeps the last data while reloading. */
export function useApi<T>(path: string | null): UseApi<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [n, setN] = useState(0);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    if (lastPath.current !== path) {
      setDataState(null);
      lastPath.current = path;
    }
    const ac = new AbortController();
    setLoading(true);
    apiGet<T>(path, ac.signal)
      .then((d) => {
        setDataState(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [path, n]);

  const reload = useCallback(() => setN((x) => x + 1), []);
  const setData = useCallback((fn: (prev: T | null) => T | null) => setDataState((p) => fn(p)), []);
  return { data, error, loading, reload, setData };
}
