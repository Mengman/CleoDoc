import type { ModelProtocolEvent, ModelRequest } from "../../contracts/src/index.js";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);

export function emitProtocolEvent(request: ModelRequest, event: ModelProtocolEvent): void {
  try {
    request.onProtocolEvent?.(event);
  } catch {
    // Protocol diagnostics must never change Provider execution.
  }
}

export function redactHeaders(
  headers: Headers | Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(
    entries.map(([name, value]) => [
      name,
      SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? "<redacted>" : value,
    ]),
  );
}
