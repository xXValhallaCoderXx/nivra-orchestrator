/**
 * Which preview answer the research dialog may show (D37): only the answer to its latest request, and only while
 * nothing changed since that request was made. A preview asked for before the latest edit, or before a later request,
 * is dropped when it arrives, so "Start research" is never bound to a selection the person has since changed. Pure, so
 * it is tested without a window.
 */
export class PreviewGuard {
  #latest = 0;

  /** An edit, the dialog opened again, or a start that failed: every answer still on its way is stale. */
  changed(): void {
    this.#latest++;
  }

  /** A new request: the token to check its answer with when it arrives. */
  asked(): number {
    return ++this.#latest;
  }

  /** Whether the answer to the request that got `token` may still be shown. */
  current(token: number): boolean {
    return token === this.#latest;
  }
}
