/**
 * tests/unit/undici-client.test.js
 * UndiciHttpClient 单元测试
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'http';
import { UndiciHttpClient, HttpError } from '../../src/utils/undici-client.js';
import { getUndiciDispatcherForUrl } from '../../src/utils/proxy-utils.js';

describe('UndiciHttpClient and HttpError Tests', () => {
    let server;
    let serverUrl;

    beforeAll((done) => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://${req.headers.host}`);
            
            if (url.pathname === '/hello') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'world' }));
            } else if (url.pathname === '/echo') {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ received: JSON.parse(body || '{}'), headers: req.headers }));
                });
            } else if (url.pathname === '/binary') {
                res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                res.end(Buffer.from([0x01, 0x02, 0x03, 0x04]));
            } else if (url.pathname === '/text') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('plain text response');
            } else if (url.pathname === '/error-400') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Bad request param' } }));
            } else if (url.pathname === '/error-500') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Internal error' }));
            } else if (url.pathname === '/slow') {
                setTimeout(() => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ done: true }));
                }, 1000);
            } else if (url.pathname === '/sse') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                });
                res.write('data: {"count": 1}\n\n');
                setTimeout(() => {
                    res.write('data: {"count": 2}\n\n');
                    setTimeout(() => {
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }, 50);
                }, 50);
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            serverUrl = `http://127.0.0.1:${port}`;
            done();
        });
    });

    afterAll((done) => {
        if (server) {
            server.close(done);
        } else {
            done();
        }
    });

    describe('HttpError', () => {
        it('should correctly format HttpError with Axios compatibility', () => {
            const err = new HttpError('Request failed with status code 404', {
                status: 404,
                statusText: 'Not Found',
                headers: { 'content-type': 'text/plain' },
                data: 'Not Found',
                code: 'ERR_BAD_RESPONSE_404',
                request: { url: 'http://example.com/api', method: 'GET' }
            });

            expect(err.name).toBe('HttpError');
            expect(err.status).toBe(404);
            expect(err.statusText).toBe('Not Found');
            expect(err.code).toBe('ERR_BAD_RESPONSE_404');
            expect(err.isAxiosError).toBe(true);
            expect(err.response).toBeDefined();
            expect(err.response.status).toBe(404);
            expect(err.response.data).toBe('Not Found');
            expect(err.request).toEqual({ url: 'http://example.com/api', method: 'GET' });
        });
    });

    describe('UndiciHttpClient Operations', () => {
        it('should perform GET request and parse JSON', async () => {
            const client = new UndiciHttpClient({ baseURL: serverUrl });
            const res = await client.get('/hello');

            expect(res.status).toBe(200);
            expect(res.data).toEqual({ message: 'world' });
            expect(res.headers['content-type']).toContain('application/json');
        });

        it('should perform POST request with body', async () => {
            const client = new UndiciHttpClient({ baseURL: serverUrl });
            const res = await client.post('/echo', { foo: 'bar' });

            expect(res.status).toBe(200);
            expect(res.data.received).toEqual({ foo: 'bar' });
        });

        it('should support arraybuffer responseType', async () => {
            const client = new UndiciHttpClient({ baseURL: serverUrl });
            const res = await client.get('/binary', { responseType: 'arraybuffer' });

            expect(res.status).toBe(200);
            expect(Buffer.isBuffer(res.data)).toBe(true);
            expect(res.data).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
        });

        it('should support text responseType', async () => {
            const client = new UndiciHttpClient({ baseURL: serverUrl });
            const res = await client.get('/text', { responseType: 'text' });

            expect(res.status).toBe(200);
            expect(res.data).toBe('plain text response');
        });

        it('should throw HttpError on 400 with API error message', async () => {
            const client = new UndiciHttpClient({ baseURL: serverUrl });

            await expect(client.get('/error-400')).rejects.toThrow('Bad request param');
            try {
                await client.get('/error-400');
            } catch (err) {
                expect(err.name).toBe('HttpError');
                expect(err.status).toBe(400);
                expect(err.response.status).toBe(400);
                expect(err.response.data.error.message).toBe('Bad request param');
            }
        });

        it('should throw HttpError on 500 server error', async () => {
            const client = new UndiciHttpClient({ baseURL: serverUrl });

            try {
                await client.get('/error-500');
                expect(true).toBe(false);
            } catch (err) {
                expect(err.name).toBe('HttpError');
                expect(err.status).toBe(500);
                expect(err.response.status).toBe(500);
                expect(err.response.data.message).toBe('Internal error');
            }
        });

        it('should handle request timeout', async () => {
            const client = new UndiciHttpClient({ baseURL: serverUrl, timeout: 100 });

            try {
                await client.get('/slow');
                expect(true).toBe(false);
            } catch (err) {
                expect(err.name).toBe('HttpError');
                expect(err.status).toBe(408);
                expect(err.code).toBe('ETIMEDOUT');
            }
        });

        it('should handle manual AbortController cancellation', async () => {
            const client = new UndiciHttpClient({ baseURL: serverUrl });
            const controller = new AbortController();

            const promise = client.get('/slow', { signal: controller.signal });
            setTimeout(() => controller.abort(), 50);

            try {
                await promise;
                expect(true).toBe(false);
            } catch (err) {
                expect(err.name).toBe('HttpError');
                expect(err.code).toBe('ECONNABORTED');
            }
        });

        it('should support streaming SSE via stream()', async () => {
            const client = new UndiciHttpClient({ baseURL: serverUrl });
            const lines = [];

            for await (const line of client.stream('/sse', null, { method: 'GET' })) {
                if (line.trim()) {
                    lines.push(line.trim());
                }
            }

            expect(lines).toContain('data: {"count": 1}');
            expect(lines).toContain('data: {"count": 2}');
            expect(lines).toContain('data: [DONE]');
        });

        it('should handle early break in stream() and cancel reader cleanly', async () => {
            const client = new UndiciHttpClient({ baseURL: serverUrl });
            const lines = [];

            for await (const line of client.stream('/sse', null, { method: 'GET' })) {
                if (line.trim()) {
                    lines.push(line.trim());
                    break; // Early break after first line
                }
            }

            expect(lines.length).toBe(1);
            expect(lines[0]).toBe('data: {"count": 1}');
        });

        it('should return localDispatcher instance', () => {
            const dispatcher = UndiciHttpClient.getLocalDispatcher();
            expect(dispatcher).toBeDefined();
            expect(typeof dispatcher.dispatch).toBe('function');
        });

        it('should create SOCKS5 Undici Dispatcher with custom connect bridge', () => {
            const dispatcher = getUndiciDispatcherForUrl('socks5://127.0.0.1:1080', 'test-socks');
            expect(dispatcher).toBeDefined();
            expect(typeof dispatcher.dispatch).toBe('function');
        });
    });
});
