import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import axios from 'axios';
import { EventEmitter } from 'events';
import { handleGrokAssetsProxy } from '../../src/utils/grok-assets-proxy.js';

jest.mock('axios');
jest.mock('../../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }
}));
jest.mock('../../src/utils/proxy-utils.js', () => ({
    __esModule: true,
    configureAxiosProxy: jest.fn(cfg => cfg)
}));

describe('handleGrokAssetsProxy timeout and retry tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should use default 60000ms timeout when GROK_ASSETS_TIMEOUT is not configured', async () => {
        const streamMock = new EventEmitter();
        streamMock.pipe = jest.fn();

        axios.mockResolvedValueOnce({
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
            data: streamMock
        });

        const req = {
            url: '/api/grok/assets?url=https://imagine-public.x.ai/imagine-public/images/test.jpg&uuid=grok-node-1',
            headers: { host: '127.0.0.1:3005' }
        };
        const res = {
            writeHead: jest.fn(),
            end: jest.fn(),
            headersSent: false
        };

        const config = {};
        const mockProviderPool = {
            findProviderByUuid: jest.fn(() => ({ GROK_COOKIE_TOKEN: 'token-123' }))
        };

        await handleGrokAssetsProxy(req, res, config, mockProviderPool);

        expect(axios).toHaveBeenCalledTimes(1);
        expect(axios.mock.calls[0][0].timeout).toBe(60000);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'image/jpeg'
        }));
    });

    it('should respect custom GROK_ASSETS_TIMEOUT from config', async () => {
        const streamMock = new EventEmitter();
        streamMock.pipe = jest.fn();

        axios.mockResolvedValueOnce({
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
            data: streamMock
        });

        const req = {
            url: '/api/grok/assets?url=https://imagine-public.x.ai/imagine-public/images/test.jpg&uuid=grok-node-1',
            headers: { host: '127.0.0.1:3005' }
        };
        const res = {
            writeHead: jest.fn(),
            end: jest.fn(),
            headersSent: false
        };

        const config = { GROK_ASSETS_TIMEOUT: 90000 };
        const mockProviderPool = {
            findProviderByUuid: jest.fn(() => ({ GROK_COOKIE_TOKEN: 'token-123' }))
        };

        await handleGrokAssetsProxy(req, res, config, mockProviderPool);

        expect(axios).toHaveBeenCalledTimes(1);
        expect(axios.mock.calls[0][0].timeout).toBe(90000);
    });

    it('should retry on timeout error (ECONNABORTED / timeout of ... exceeded) and succeed on subsequent attempt', async () => {
        const timeoutError = new Error('timeout of 60000ms exceeded');
        timeoutError.code = 'ECONNABORTED';

        const streamMock = new EventEmitter();
        streamMock.pipe = jest.fn();

        axios
            .mockRejectedValueOnce(timeoutError)
            .mockResolvedValueOnce({
                status: 200,
                headers: { 'content-type': 'image/jpeg' },
                data: streamMock
            });

        const req = {
            url: '/api/grok/assets?url=https://imagine-public.x.ai/imagine-public/images/test.jpg&uuid=grok-node-1',
            headers: { host: '127.0.0.1:3005' }
        };
        const res = {
            writeHead: jest.fn(),
            end: jest.fn(),
            headersSent: false
        };

        const config = {};
        const mockProviderPool = {
            findProviderByUuid: jest.fn(() => ({ GROK_COOKIE_TOKEN: 'token-123' }))
        };

        await handleGrokAssetsProxy(req, res, config, mockProviderPool);

        expect(axios).toHaveBeenCalledTimes(2);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'image/jpeg'
        }));
    });

    it('should retry on transient 502/503/504 upstream error and succeed', async () => {
        const streamMock = new EventEmitter();
        streamMock.pipe = jest.fn();

        axios
            .mockResolvedValueOnce({
                status: 503,
                headers: {},
                data: new EventEmitter()
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: { 'content-type': 'image/jpeg' },
                data: streamMock
            });

        const req = {
            url: '/api/grok/assets?url=https://imagine-public.x.ai/imagine-public/images/test.jpg&uuid=grok-node-1',
            headers: { host: '127.0.0.1:3005' }
        };
        const res = {
            writeHead: jest.fn(),
            end: jest.fn(),
            headersSent: false
        };

        const config = {};
        const mockProviderPool = {
            findProviderByUuid: jest.fn(() => ({ GROK_COOKIE_TOKEN: 'token-123' }))
        };

        await handleGrokAssetsProxy(req, res, config, mockProviderPool);

        expect(axios).toHaveBeenCalledTimes(2);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'image/jpeg'
        }));
    });

    it('should handle HEAD request properly without piping response body', async () => {
        axios.mockResolvedValueOnce({
            status: 200,
            headers: { 'content-type': 'image/jpeg', 'content-length': '12345' },
            data: null
        });

        const req = {
            method: 'HEAD',
            url: '/api/grok/assets?url=https://imagine-public.x.ai/imagine-public/images/test.jpg&uuid=grok-node-1',
            headers: { host: '127.0.0.1:3005' }
        };
        const res = {
            writeHead: jest.fn(),
            end: jest.fn(),
            headersSent: false
        };

        const config = {};
        const mockProviderPool = {
            findProviderByUuid: jest.fn(() => ({ GROK_COOKIE_TOKEN: 'token-123' }))
        };

        await handleGrokAssetsProxy(req, res, config, mockProviderPool);

        expect(axios).toHaveBeenCalledTimes(1);
        expect(axios.mock.calls[0][0].method).toBe('head');
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'image/jpeg',
            'Content-Length': '12345'
        }));
        expect(res.end).toHaveBeenCalled();
    });

    it('should reject unallowed hostnames with 403 Forbidden without retrying', async () => {
        const req = {
            url: '/api/grok/assets?url=https://malicious.com/images/test.jpg&uuid=grok-node-1',
            headers: { host: '127.0.0.1:3005' }
        };
        const res = {
            writeHead: jest.fn(),
            end: jest.fn(),
            headersSent: false
        };

        const config = {};
        const mockProviderPool = {
            findProviderByUuid: jest.fn(() => ({ GROK_COOKIE_TOKEN: 'token-123' }))
        };

        await handleGrokAssetsProxy(req, res, config, mockProviderPool);

        expect(axios).not.toHaveBeenCalled();
        expect(res.writeHead).toHaveBeenCalledWith(403, expect.objectContaining({
            'Content-Type': 'application/json'
        }));
    });
});
