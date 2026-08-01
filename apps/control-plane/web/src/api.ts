import { useCallback, useEffect, useState } from "react";

/**
 * One way to reach the control plane.
 *
 * The queue view carried its own copy of this and forgot the org parameter, so
 * a reader with two organizations could be shown a queue belonging to the other
 * one. Every caller now goes through the same request.
 */

export function selectedOrg(): string | null {
  return localStorage.getItem("thwip.org");
}

export function withOrg(path: string): string {
  const org = selectedOrg();
  if (!org) return path;
  return path + (path.includes("?") ? "&" : "?") + "org=" + encodeURIComponent(org);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withOrg(path), {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function useFetch<T>(path: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}
