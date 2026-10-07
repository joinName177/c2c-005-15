import { describe, expect, it } from 'vitest';
import { BrowserShareAdapter } from '../browser-share.adapter';
import { coverPresetFor } from '../../core/cover-presets';
import type { VoiceMeme } from '../../core/models';
const meme = (title = '笑声'): VoiceMeme => ({ id: '1', title, emotion: '元气满满', confidence: .8, features: { loudness:.7,dynamics:.5,pitch:.8,zeroCrossing:.6,pauseRatio:.1,tempoVariation:.6 }, audio: new Blob(['a'], {type:'audio/webm'}), duration: 1, cover: new Blob(['p'], {type:'image/png'}), coverConfig: coverPresetFor('元气满满'), createdAt: '2026-10-05' });

describe('BrowserShareAdapter', () => {
  it('uses file share when supported', async () => {
    let shared = false; const adapter = new BrowserShareAdapter({ canShare: () => true, share: async () => { shared = true; }, download: () => {} });
    expect(await adapter.share(meme())).toEqual({ kind: 'shared' }); expect(shared).toBe(true);
  });
  it('reports cancellation without falling back to download', async () => {
    let downloads = 0; const adapter = new BrowserShareAdapter({ canShare: () => true, share: async () => { throw new DOMException('cancelled', 'AbortError'); }, download: () => { downloads += 1; } });
    expect(await adapter.share(meme())).toEqual({ kind: 'cancelled' }); expect(downloads).toBe(0);
  });
  it('reports unavailable when file share is unsupported or canShare throws', async () => {
    let downloads = 0; const download = () => { downloads += 1; };
    expect(await new BrowserShareAdapter({ canShare: () => false, share: async () => {}, download }).share(meme())).toEqual({ kind: 'unavailable' });
    expect(await new BrowserShareAdapter({ canShare: () => { throw new Error('bad data'); }, share: async () => {}, download }).share(meme())).toEqual({ kind: 'unavailable' });
    expect(downloads).toBe(0);
  });
  it('keeps the original reason for real share failures', async () => {
    const adapter = new BrowserShareAdapter({ canShare: () => true, share: async () => { throw new DOMException('share already in progress', 'InvalidStateError'); }, download: () => {} });
    expect(await adapter.share(meme())).toEqual({ kind: 'failed', reason: 'share already in progress' });
  });
  it('initiates both file downloads and reports names', async () => {
    const downloads: string[] = []; const adapter = new BrowserShareAdapter({ canShare: () => false, share: async () => {}, download: (_, name) => downloads.push(name) });
    expect(await adapter.download(meme())).toEqual({ initiated: ['笑声.webm', '笑声.png'], failed: [] }); expect(downloads).toEqual(['笑声.webm', '笑声.png']);
  });
  it('reports a failed file without disturbing the other', async () => {
    const adapter = new BrowserShareAdapter({ canShare: () => false, share: async () => {}, download: (_, name) => { if (name.endsWith('.png')) throw new Error('popup blocked'); } });
    const report = await adapter.download(meme());
    expect(report.initiated).toEqual(['笑声.webm']); expect(report.failed).toEqual([{ name: '笑声.png', reason: 'popup blocked' }]);
  });
  it('retries only the requested files', async () => {
    const downloads: string[] = []; const adapter = new BrowserShareAdapter({ canShare: () => false, share: async () => {}, download: (_, name) => downloads.push(name) });
    const report = await adapter.download(meme(), ['笑声.png']);
    expect(downloads).toEqual(['笑声.png']); expect(report.initiated).toEqual(['笑声.png']);
  });
});
