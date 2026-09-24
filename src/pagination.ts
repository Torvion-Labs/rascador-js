import type { Response } from "./types.ts"

type FetchPage<T> = (offset: number | undefined) => Promise<Response<T[]>>

/**
 * A single page you can `await`, or every item you can `for await`.
 *
 * `await list(...)` makes exactly one request. Iterating makes as many as
 * `meta.pagination.has_more` calls for, starting from the offset you passed.
 */
export class PagePromise<T> implements PromiseLike<Response<T[]>>, AsyncIterable<T> {
  readonly #fetchPage: FetchPage<T>
  readonly #startOffset: number | undefined
  #first: Promise<Response<T[]>> | undefined

  constructor(fetchPage: FetchPage<T>, startOffset: number | undefined) {
    this.#fetchPage = fetchPage
    this.#startOffset = startOffset
  }

  // Lazy, so a list you only iterate doesn't also fire a request for `then`.
  #firstPage(): Promise<Response<T[]>> {
    this.#first ??= this.#fetchPage(this.#startOffset)
    return this.#first
  }

  then<R1 = Response<T[]>, R2 = never>(
    onfulfilled?: ((value: Response<T[]>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return this.#firstPage().then(onfulfilled, onrejected)
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<Response<T[]> | R> {
    return this.#firstPage().catch(onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<Response<T[]>> {
    return this.#firstPage().finally(onfinally)
  }

  /** Every page, in order. */
  async *pages(): AsyncGenerator<Response<T[]>, void, undefined> {
    let page = await this.#firstPage()
    for (;;) {
      yield page
      const p = page.meta.pagination
      if (!p?.has_more || p.limit <= 0) return
      // Advance by the page size, not by what came back: with `only_new` a page
      // can be shorter than `limit` without the listing being exhausted.
      page = await this.#fetchPage(p.offset + p.limit)
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for await (const page of this.pages()) yield* page.data
  }
}
