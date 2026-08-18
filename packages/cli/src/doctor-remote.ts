import type { DoctorObservation, DoctorProbe } from "./queue-doctor.js";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read one idempotent doctor endpoint with a small, fixed retry bound. */
export async function readDoctorProbe(
  input: {
    readonly endpoint: string;
    readonly auth: string;
    readonly path: string;
    readonly probe: DoctorProbe;
  },
  ports: {
    readonly fetch?: typeof fetch;
    readonly pause?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<DoctorObservation> {
  const fetcher = ports.fetch ?? fetch;
  const pause = ports.pause ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let status = 0;
  let body: Record<string, unknown> | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetcher(input.endpoint + input.path, {
      headers: { authorization: input.auth },
    }).catch(() => null);
    status = response?.status ?? 0;
    body = response === null ? null : jsonRecord(await response.json().catch(() => null));
    if (response !== null && !RETRYABLE.has(response.status)) {
      return { section: input.probe.section, operation: input.probe.operation, attempts: attempt, status, body };
    }
    if (attempt < MAX_ATTEMPTS) await pause(50 * attempt);
    else return { section: input.probe.section, operation: input.probe.operation, attempts: attempt, status, body };
  }

  throw new Error("doctor retry bound was not reached");
}
