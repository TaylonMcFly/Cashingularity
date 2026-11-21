import { afterEach, expect, it, vi } from 'vitest';
import { resolvePaytacaBcmrMetadata } from './bcmrService.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shares concurrent metadata requests and retries fallback entries after expiry', async () => {
  vi.useFakeTimers();
  const id = 'a1'.repeat(32);
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ categoryId: id, symbol: 'QA', decimals: 0, isVerified: true }));
  vi.stubGlobal('fetch', fetchMock);
  const batch = await Promise.all(Array.from({ length: 12 }, () => resolvePaytacaBcmrMetadata(id)));
  expect(batch.every(token => token.symbol === 'UNKNOWN')).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await resolvePaytacaBcmrMetadata(id);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(30_001);
  await expect(resolvePaytacaBcmrMetadata(id)).resolves.toMatchObject({ symbol: 'QA', isVerified: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
