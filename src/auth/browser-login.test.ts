import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { headedLogin, headlessLogin } from './browser-login.js';
import { writeTokenCache } from './session-store.js';
import { extractTokensFromLocalStorage } from './token-extractor.js';

vi.mock('playwright', () => ({ chromium: { launchPersistentContext: vi.fn() } }));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false) }));
vi.mock('../utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../browser/cookie-import.js', () => ({ importMicrosoftCookies: vi.fn() }));
vi.mock('./session-store.js', () => ({
  getBrowserProfileDir: vi.fn(() => '/unused-test-profile'),
  writeSessionState: vi.fn(), writeTokenCache: vi.fn(), clearSession: vi.fn(),
}));
vi.mock('./token-extractor.js', () => ({
  getOwaLocalStorage: vi.fn(() => []),
  extractTokensFromLocalStorage: vi.fn(),
}));

// Model Playwright's argument contract: options belong in the third argument,
// otherwise the default 30-second timeout applies. No browser or account needed.
function browserWithTokenDelay(tokenDelayMs: number, redirectedToLogin = false) {
  const frame = { url: () => 'https://login.microsoftonline.com/' };
  const page = {
    mainFrame: () => frame,
    on: vi.fn(), off: vi.fn(),
    goto: vi.fn(async () => {
      if (redirectedToLogin) {
        for (const [, handler] of page.on.mock.calls) handler(frame);
      }
    }),
    waitForTimeout: vi.fn((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))),
    waitForFunction: vi.fn((_predicate: unknown, _arg?: unknown, options?: { timeout?: number }) => {
      const timeout = options?.timeout ?? 30_000;
      return new Promise<void>((resolve, reject) => setTimeout(() => {
        if (tokenDelayMs <= timeout) resolve();
        else reject(new Error('Token wait timed out'));
      }, Math.min(tokenDelayMs, timeout)));
    }),
    evaluate: vi.fn(async () => true),
  };
  const context = {
    pages: () => [page],
    on: vi.fn(),
    storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    close: vi.fn(async () => {}),
  };
  vi.mocked(chromium.launchPersistentContext).mockResolvedValue(context as any);
  return { page, context };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv('MSOUTLOOK_BROWSER', 'chrome');
  vi.mocked(extractTokensFromLocalStorage).mockResolvedValue({
    owaToken: 'test-token', owaTokenExpiry: new Date(Date.now() + 3_600_000),
    refreshToken: 'test-refresh-token', upn: 'test@example.com',
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('browser login token wait', () => {
  it.each([true, false])('allows sign-in taking more than 30 seconds (login redirect: %s)', async redirected => {
    const { context } = browserWithTokenDelay(45_000, redirected);
    const result = headedLogin();
    await vi.runAllTimersAsync();

    expect(await result).toEqual({ upn: 'test@example.com', method: 'headed-browser' });
    expect(writeTokenCache).toHaveBeenCalledWith(expect.objectContaining({ owaToken: 'test-token' }));
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('stops waiting after the five-minute interactive login limit', async () => {
    const { context } = browserWithTokenDelay(Infinity, true);
    const start = Date.now();
    const result = headedLogin();
    await vi.runAllTimersAsync();

    expect(await result).toBeNull();
    expect(Date.now() - start).toBe(300_000);
    expect(writeTokenCache).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('honors the shorter session-check timeout for headless login', async () => {
    const { context } = browserWithTokenDelay(6_000);
    const start = Date.now();
    const result = headlessLogin();
    await vi.runAllTimersAsync();

    expect(await result).toBeNull();
    // Five seconds for redirect detection, then five seconds for the token wait.
    expect(Date.now() - start).toBe(10_000);
    expect(writeTokenCache).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
  });
});
