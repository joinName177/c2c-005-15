import { describe, expect, it } from 'vitest';
import { BrowserShareAdapter } from '../browser-share.adapter';
import { coverPresetFor } from '../../core/cover-presets';
import type { VoiceMeme } from '../../core/models';
const meme = (): VoiceMeme => ({ id: '1', title: '笑声', emotion: '元气满满', confidence: .8, features: { loudness:.7,dynamics:.5,pitch:.8,zeroCrossing:.6,pauseRatio:.1,tempoVariation:.6 }, audio: new Blob(['a'], {type:'audio/webm'}), duration: 1, cover: new Blob(['p'], {type:'image/png'}), coverConfig: coverPresetFor('元气满满'), createdAt: '2026-10-05' });

describe('BrowserShareAdapter', () => {
  it('uses file share when supported', async () => {
    let shared = false; const adapter = new BrowserShareAdapter({ canShare: () => true, share: async () => { shared = true; }, download: () => {} });
    expect(await adapter.share(meme())).toEqual({ kind: 'shared' }); expect(shared).toBe(true);
  });
  it('treats user cancel as cancelled without downloading', async () => {
    const downloads: string[] = []; const adapter = new BrowserShareAdapter({ canShare: () => true, share: async () => { throw new DOMException('cancelled', 'AbortError'); }, download: (_, name) => downloads.push(name) });
    expect(await adapter.share(meme())).toEqual({ kind: 'cancelled' }); expect(downloads).toEqual([]);
  });
  it('keeps the reason on real failures and does not download', async () => {
    const downloads: string[] = []; const adapter = new BrowserShareAdapter({ canShare: () => true, share: async () => { throw new Error('network offline'); }, download: (_, name) => downloads.push(name) });
    expect(await adapter.share(meme())).toEqual({ kind: 'failed', reason: 'network offline' }); expect(downloads).toEqual([]);
  });
  it('falls back to per-file downloads only when sharing is unavailable', async () => {
    const downloads: string[] = []; const adapter = new BrowserShareAdapter({ canShare: () => false, share: async () => {}, download: (_, name) => downloads.push(name) });
    const outcome = await adapter.share(meme());
    expect(outcome).toEqual({ kind: 'unavailable', downloads: [
      { file: 'audio', name: '笑声.webm', started: true },
      { file: 'cover', name: '笑声.png', started: true },
    ] });
    expect(downloads).toEqual(['笑声.webm', '笑声.png']);
  });
  it('reports each download attempt separately so a single failure can be retried alone', async () => {
    const downloads: string[] = []; const adapter = new BrowserShareAdapter({ canShare: () => false, share: async () => {}, download: (_, name) => { if (name.endsWith('.png')) throw new Error('popup blocked'); downloads.push(name); } });
    const outcome = await adapter.share(meme());
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.downloads).toEqual([
      { file: 'audio', name: '笑声.webm', started: true },
      { file: 'cover', name: '笑声.png', started: false, error: 'popup blocked' },
    ]);
    const retry = adapter.downloadFiles(meme(), ['cover']);
    expect(retry).toEqual([{ file: 'cover', name: '笑声.png', started: false, error: 'popup blocked' }]);
    expect(downloads).toEqual(['笑声.webm']); // 重试只触及封面，未重复发起音频
  });
});
