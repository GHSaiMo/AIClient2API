import { describe, it, expect, jest, afterEach } from '@jest/globals';
import http from 'http';
import { ProviderPoolManager } from '../../src/providers/provider-pool-manager.js';
import { getTLSSidecar } from '../../src/utils/tls-sidecar.js';
import { UndiciHttpClient } from '../../src/utils/undici-client.js';

function makeManager(options = {}) {
    const pools = {
        'openai-custom': [
            { uuid: 'a', isHealthy: true, usageCount: 0 },
            { uuid: 'b', isHealthy: true, usageCount: 0 },
            { uuid: 'c', isHealthy: true, usageCount: 0 },
        ],
    };
    const mgr = new ProviderPoolManager(pools, { logLevel: 'error', ...options });
    // 构造/初始化阶段可能已排入保存定时器，清理后再观察被测行为
    clearTimeout(mgr.saveTimer);
    mgr.saveTimer = null;
    mgr.saveDeadline = 0;
    mgr.firstPendingAt = 0;
    mgr.pendingSaves.clear();
    mgr._flushPendingSaves = jest.fn();
    return mgr;
}

describe('provider pool: selection & debounced save', () => {
    afterEach(() => jest.useRealTimers());

    it('selection round-robins across nodes without re-sorting the pool', () => {
        const mgr = makeManager();
        const order = mgr.providerStatus['openai-custom'].map(p => p.uuid);
        const picked = [];
        for (let i = 0; i < 6; i++) {
            picked.push(mgr._doSelectProvider('openai-custom', null, {}).uuid);
        }
        expect(new Set(picked.slice(0, 3)).size).toBe(3);
        expect(picked.slice(0, 3)).toEqual(picked.slice(3, 6));
        expect(mgr.providerStatus['openai-custom'].map(p => p.uuid)).toEqual(order);
        clearTimeout(mgr.saveTimer);
    });

    it('debounce is capped by max wait under continuous updates', () => {
        jest.useFakeTimers();
        const mgr = makeManager({ saveDebounceTime: 1000, saveMaxWaitTime: 5000 });
        // 每 500ms 一次更新，纯尾部防抖永远不会触发
        for (let i = 0; i < 12; i++) {
            mgr._debouncedSave('openai-custom');
            jest.advanceTimersByTime(500);
        }
        expect(mgr._flushPendingSaves).toHaveBeenCalled();
    });

    it('urgent save pulls forward a lazy pending save', () => {
        jest.useFakeTimers();
        const mgr = makeManager();
        mgr._debouncedSave('openai-custom', 3000);
        jest.advanceTimersByTime(1100);
        expect(mgr._flushPendingSaves).not.toHaveBeenCalled();
        mgr._debouncedSave('openai-custom'); // 默认 1s
        jest.advanceTimersByTime(1000);
        expect(mgr._flushPendingSaves).toHaveBeenCalledTimes(1);
    });
});

describe('tls sidecar agent reuse', () => {
    it('reuses a single keep-alive agent across requests', () => {
        const sidecar = getTLSSidecar();
        sidecar.isReady = () => true; // 不启动真实 sidecar，仅验证配置包装
        const a = sidecar.wrapAxiosConfig({ url: 'https://example.com/x', headers: {} }, null);
        const b = sidecar.wrapAxiosConfig({ url: 'https://example.com/y', headers: {} }, null);
        expect(a.agent).toBeDefined();
        expect(a.agent).toBe(b.agent);
    });
});

describe('undici client: keep-alive default dispatcher & line splitting', () => {
    it('streams SSE lines correctly across chunk boundaries', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: one\n');
            setTimeout(() => res.write('\ndata: tw'), 10);
            setTimeout(() => res.write('o\n\ndata: three'), 20);
            setTimeout(() => res.end('\n'), 30);
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const { port } = server.address();
        const client = new UndiciHttpClient({ baseURL: `http://127.0.0.1:${port}` });
        const lines = [];
        for await (const l of client.stream('/s', {})) lines.push(l);
        server.close();
        expect(lines).toEqual(['data: one', '', 'data: two', '', 'data: three']);
    });

    it('reuses the connection between sequential requests (no 4s default keep-alive)', async () => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            sockets.add(req.socket);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Keep-Alive': 'timeout=30' });
            res.end('{}');
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const { port } = server.address();
        const client = new UndiciHttpClient({ baseURL: `http://127.0.0.1:${port}` });
        await client.get('/a');
        await new Promise(r => setTimeout(r, 300));
        await client.get('/b');
        expect(sockets.size).toBe(1);
        server.closeAllConnections?.();
        server.close();
    });
});
