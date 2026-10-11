// Shared bounded HTTPS reads: cap incoming bytes, prohibit downgrade redirects,
// and report failures through ConfigError for both preset import and self-update.

import { ConfigError } from "./config.ts";
import type { Messages } from "./i18n.ts";

export type Bounds = { maxBytes: number; timeoutMs: number };

// Node's documented certificate verification codes; resource exhaustion is not a trust diagnosis.
const CERTIFICATE_ERRORS = new Set([
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_CRL", "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE", "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY", "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE", "CERT_NOT_YET_VALID", "CERT_HAS_EXPIRED", "CRL_NOT_YET_VALID", "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD", "ERROR_IN_CERT_NOT_AFTER_FIELD", "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_CHAIN_TOO_LONG", "CERT_REVOKED",
  "INVALID_CA", "PATH_LENGTH_EXCEEDED", "INVALID_PURPOSE", "CERT_UNTRUSTED", "CERT_REJECTED",
  "HOSTNAME_MISMATCH", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Public identity only; complete URLs belong to the request, never its diagnostics. */
export function urlIdentity(source: string, t: Messages): string {
  try {
    const url = new URL(source);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : t.config.remoteSource;
  } catch {
    return t.config.remoteSource;
  }
}

/**
 * Fetch `url`, refusing a body past `maxBytes` as it arrives.
 *
 * The protocol rule is a **downgrade** check rather than a floor: an https request answered from
 * http is refused, and an http request is left to the caller to allow or not. `import` requires
 * https of what a user pastes; the registry is a configured endpoint that `install.sh` does not
 * constrain either, because an internal mirror over http is its operator's choice.
 */
export async function getBounded(url: string, bounds: Bounds, t: Messages): Promise<Uint8Array> {
  const source = urlIdentity(url, t);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(bounds.timeoutMs), redirect: "follow" });
    if (source.startsWith("https:") && !urlIdentity(response.url, t).startsWith("https:")) {
      throw new ConfigError(t.config.redirectedInsecure(urlIdentity(response.url, t)));
    }
    if (!response.ok) throw new ConfigError(t.config.fetchFailed(source, `HTTP ${response.status}`));

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body ?? []) {
      total += (chunk as Uint8Array).byteLength;
      if (total > bounds.maxBytes) throw new ConfigError(t.config.tooLarge(bounds.maxBytes));
      chunks.push(chunk as Uint8Array);
    }
    const body = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      body.set(chunk, at);
      at += chunk.byteLength;
    }
    return body;
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    const certificateFailure = [cause, cause instanceof Error ? cause.cause : undefined]
      .some(error => error instanceof Error && CERTIFICATE_ERRORS.has((error as NodeJS.ErrnoException).code ?? ""));
    throw new ConfigError(t.config.fetchFailed(source, certificateFailure ? t.config.connectionUnverified : t.config.transportFailed), { cause });
  }
}

/** UTF-8 or nothing. A body that is not text is not JSON, and says so as a `ConfigError`. */
export function decodeUtf8(body: Uint8Array, t: Messages): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (cause) {
    throw new ConfigError(t.config.notUtf8Body, { cause });
  }
}
