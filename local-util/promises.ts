
export async function promiseAllBatch<T, R>(
  arr: T[],
  cb: (element: T) => Promise<R> | R,
  batchSize = 10,
  sleep = 0,
): Promise<Awaited<R>[]> {
  const results: Awaited<R>[] = [];

  for (let i = 0; i < arr.length; i += batchSize) {
    const batch = arr.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(cb));
    results.push(...batchResults);

    if (sleep > 0 && i + batchSize < arr.length) {
      await new Promise((resolve) => setTimeout(resolve, sleep));
    }
  }

  return results;
}
// import type { PrismaClient } from '@prisma/client';

export async function promiseAllSettledBatch<T, R>(
  arr: T[],
  cb: (element: T, index: number) => Promise<R> | R,
  batchSize = 10,
  sleepMs = 1,
  afterBatchCb?: (batchResults: PromiseSettledResult<Awaited<R>>[], total: number) => Promise<any>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];

  for (let i = 0; i < arr.length; i += batchSize) {
    const batch = arr.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(cb));
    results.push(...batchResults);
    await afterBatchCb?.(batchResults, i + batchSize).catch((err: unknown) =>
      console.error(`Error during promiseAllSettledBatch.afterBatchCb: (SHOULD_NOT_HAPPEN)`, err),
    );

    if (sleepMs > 0 && i + batchSize < arr.length) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  return results;
}
