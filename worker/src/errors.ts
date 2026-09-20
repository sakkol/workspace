/** An error that maps directly to an HTTP response. `code` is safe to show to the client. */
export class HttpErr extends Error {
  constructor(public status: number, public code: string, public retryAfter?: string | null) {
    super(code);
  }
}
/** Input validation failure (HTTP 400). */
export class Bad extends HttpErr {
  constructor(code: string) {
    super(400, code);
  }
}
