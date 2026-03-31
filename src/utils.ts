/** Generate a cryptographically-random alphanumeric string of given length */
export function randomAlpha(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map(b => chars[b % chars.length])
    .join('');
}

/** CORS headers for all responses */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Token',
  'Access-Control-Max-Age': '86400',
};

/** Build a JSON response */
export function jsonResponse(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

/** Build an error JSON response */
export function errorResponse(message: string, code = 400): Response {
  return jsonResponse({ success: false, error: message, code }, code);
}

/** Convert a ReadableStream to ArrayBuffer */
export async function streamToArrayBuffer(stream: ReadableStream): Promise<ArrayBuffer> {
  const response = new Response(stream);
  return response.arrayBuffer();
}

/** Get plain text snippet from HTML or plain text */
export function buildSnippet(text: string, html: string, maxLen = 120): string {
  let raw = text || '';
  if (!raw && html) {
    raw = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return raw.length > maxLen ? raw.slice(0, maxLen) + '…' : raw;
}

/** Extract headers object as JSON-safe record */
export function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/** Check if a string is a valid UUID */
export function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}
