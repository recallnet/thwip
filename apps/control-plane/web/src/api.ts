import { useCallback, useEffect, useState } from "react";
import { humanise } from "./vocabulary.js";

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

/**
 * A refusal with the status still on it.
 *
 * Callers that treat every failure alike show a reader who is not allowed in
 * the same screen as a reader whose request broke, and the two want opposite
 * treatment. The status travels so they can tell.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** A single word in the shape the protocol names things: `SUBJECT_BASE_MISMATCH`. */
function looksLikeCode(text: string): boolean {
  return /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(text);
}

/**
 * What a reader is told when the control plane says no.
 *
 * A route explains itself in `detail` when it has a sentence to give, and names
 * the refusal in `error`, which is sometimes prose and sometimes a code. Reading
 * only `error` dropped the sentence and put `RESUME_REFUSED` on screen; reading
 * nothing left the reader with "409". A refusal never reaches a person as a
 * number, and never as a code they have to go and look up.
 */
function refusalText(body: { error?: string; detail?: string }, status: number): string {
  if (typeof body.detail === "string" && body.detail.trim() !== "") return body.detail;
  if (typeof body.error === "string" && body.error.trim() !== "") {
    // Only a code gets read out as words. Run over a sentence, `humanise`
    // lowercases every word it does not take for an acronym, so a route that
    // wrote "GitHub says it is not merged" would be quoted back as "github".
    return looksLikeCode(body.error) ? humanise(body.error) : body.error;
  }
  return status >= 500
    ? "thwip could not answer that. Try again, and tell us if it keeps happening."
    : "thwip refused that, and did not say why.";
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withOrg(path), {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new ApiError(refusalText(body, res.status), res.status);
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
