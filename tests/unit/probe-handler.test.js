import {
    isClientProbePath,
    handleClientProbeRequest,
    getAppVersion,
    isHermesClient,
    isHermesProbeRequest,
    getEstimatedModelContextLength
} from '../../src/handlers/probe-handler.js';
import { handleModelDetailRequest } from '../../src/utils/common.js';

describe('Client Probe Handler Suite', () => {
    test('should identify known client probe paths correctly', () => {
        expect(isClientProbePath('GET', '/version')).toBe(true);
        expect(isClientProbePath('GET', '/api/version')).toBe(true);
        expect(isClientProbePath('GET', '/props')).toBe(true);
        expect(isClientProbePath('GET', '/v1/props')).toBe(true);
        expect(isClientProbePath('GET', '/api/tags')).toBe(true);
        expect(isClientProbePath('GET', '/api/ps')).toBe(true);
        expect(isClientProbePath('POST', '/api/show')).toBe(true);

        expect(isClientProbePath('GET', '/v1/chat/completions')).toBe(false);
        expect(isClientProbePath('POST', '/v1/messages')).toBe(false);
        expect(isClientProbePath('GET', '/v1/models')).toBe(false);
    });

    test('should return valid app version', () => {
        const version = getAppVersion();
        expect(typeof version).toBe('string');
        expect(version.length).toBeGreaterThan(0);
    });

    test('should handle GET /version and /api/version with 200 JSON', () => {
        const mockRes = {
            writeHead: jest.fn(),
            end: jest.fn()
        };
        const handled = handleClientProbeRequest('GET', '/version', {}, mockRes);
        expect(handled).toBe(true);
        expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const parsed = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(parsed.status).toBe('ok');
        expect(parsed.version).toBeDefined();
    });

    test('should handle GET /props and /v1/props with 200 JSON', () => {
        const mockRes = {
            writeHead: jest.fn(),
            end: jest.fn()
        };
        const handled = handleClientProbeRequest('GET', '/v1/props', {}, mockRes);
        expect(handled).toBe(true);
        expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const parsed = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(parsed.total_slots).toBe(1);
    });

    test('should handle GET /api/tags with empty models array', () => {
        const mockRes = {
            writeHead: jest.fn(),
            end: jest.fn()
        };
        const handled = handleClientProbeRequest('GET', '/api/tags', {}, mockRes);
        expect(handled).toBe(true);
        expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const parsed = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(Array.isArray(parsed.models)).toBe(true);
    });

    test('should handle POST /api/show with standard Ollama payload', () => {
        const mockRes = {
            writeHead: jest.fn(),
            end: jest.fn()
        };
        const handled = handleClientProbeRequest('POST', '/api/show', {}, mockRes);
        expect(handled).toBe(true);
        expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const parsed = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(parsed.details).toBeDefined();
        expect(parsed.details.family).toBe('llama');
    });

    test('should return false for unhandled non-probe paths', () => {
        const mockRes = {
            writeHead: jest.fn(),
            end: jest.fn()
        };
        const handled = handleClientProbeRequest('POST', '/v1/chat/completions', {}, mockRes);
        expect(handled).toBe(false);
        expect(mockRes.writeHead).not.toHaveBeenCalled();
    });

    test('should identify Hermes clients correctly via User-Agent', () => {
        expect(isHermesClient({ headers: { 'user-agent': 'HermesAgent/1.0' } })).toBe(true);
        expect(isHermesClient({ headers: { 'user-agent': 'python-httpx/0.28.1' } })).toBe(true);
        expect(isHermesClient({ headers: { 'user-agent': 'python-requests/2.32.3' } })).toBe(true);
        expect(isHermesClient({ headers: { 'user-agent': 'Python-urllib/3.11' } })).toBe(true);
        expect(isHermesClient({ headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)' } })).toBe(false);
        expect(isHermesClient({ headers: { 'user-agent': 'curl/8.1.2' } })).toBe(false);
        expect(isHermesClient({})).toBe(false);
    });

    test('should accurately identify Hermes and unauthenticated model probe requests', () => {
        const hermesReq = { headers: { 'user-agent': 'python-httpx/0.28.1' } };
        const unauthReq = { headers: {} };
        const authReq = { headers: { 'user-agent': 'curl/8.1.2', authorization: 'Bearer token123' } };

        expect(isHermesProbeRequest('GET', '/v1/models', hermesReq)).toBe(true);
        expect(isHermesProbeRequest('GET', '/v1/models/gemini-3.8-flash', hermesReq)).toBe(true);
        expect(isHermesProbeRequest('GET', '/api/v1/models', hermesReq)).toBe(true);
        expect(isHermesProbeRequest('GET', '/v1beta/models', hermesReq)).toBe(true);

        // Unauthenticated model request is also treated as probe
        expect(isHermesProbeRequest('GET', '/v1/models', unauthReq)).toBe(true);
        expect(isHermesProbeRequest('GET', '/v1/models/gemini-3.8-flash', unauthReq)).toBe(true);

        // Authenticated non-Hermes model request is not a probe (goes through standard auth)
        expect(isHermesProbeRequest('GET', '/v1/models', authReq)).toBe(false);

        // Non-GET requests (such as chat completions) are never probe requests
        expect(isHermesProbeRequest('POST', '/v1/chat/completions', hermesReq)).toBe(false);
        expect(isHermesProbeRequest('POST', '/v1/models', hermesReq)).toBe(false);
    });

    test('should correctly estimate context length for various models', () => {
        expect(getEstimatedModelContextLength('gemini-3.8-flash')).toBe(1048576);
        expect(getEstimatedModelContextLength('gemini-1.5-pro')).toBe(2097152);
        expect(getEstimatedModelContextLength('claude-3-5-sonnet-20241022')).toBe(200000);
        expect(getEstimatedModelContextLength('claude-3-haiku-20240307')).toBe(200000);
        expect(getEstimatedModelContextLength('grok-2-latest')).toBe(131072);
        expect(getEstimatedModelContextLength('deepseek-chat')).toBe(65536);
        expect(getEstimatedModelContextLength('gpt-4o')).toBe(128000);
    });

    test('should handle Hermes GET /v1/models probe with 200 JSON and context_length', () => {
        const mockRes = {
            writeHead: jest.fn(),
            end: jest.fn()
        };
        const req = { headers: { 'user-agent': 'python-httpx/0.28.1' } };
        const handled = handleClientProbeRequest('GET', '/v1/models', req, mockRes);
        expect(handled).toBe(true);
        expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const parsed = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(parsed.object).toBe('list');
        expect(Array.isArray(parsed.data)).toBe(true);
        expect(parsed.data.length).toBeGreaterThan(0);
        expect(parsed.data[0].context_length).toBeDefined();
        expect(parsed.data[0].context_length).toBeGreaterThan(0);
    });

    test('should handle Hermes GET /v1/models/:model probe with 200 JSON and correct context length', () => {
        const mockRes = {
            writeHead: jest.fn(),
            end: jest.fn()
        };
        const req = { headers: { 'user-agent': 'python-httpx/0.28.1' } };
        const handled = handleClientProbeRequest('GET', '/v1/models/gemini-3.8-flash', req, mockRes);
        expect(handled).toBe(true);
        expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const parsed = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(parsed.id).toBe('gemini-3.8-flash');
        expect(parsed.object).toBe('model');
        expect(parsed.context_length).toBe(1048576);
        expect(parsed.max_input_tokens).toBe(1048576);
    });

    test('should handle authenticated GET /v1/models/:model via handleModelDetailRequest with 200 JSON', async () => {
        const mockRes = {
            writeHead: jest.fn(),
            end: jest.fn()
        };
        const req = { headers: { authorization: 'Bearer test' } };
        await handleModelDetailRequest(req, mockRes, '/v1/models/gemini-3.8-flash', { MODEL_PROVIDER: 'gemini-antigravity' }, null);
        expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const parsed = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(parsed.id).toBe('gemini-3.8-flash');
        expect(parsed.object).toBe('model');
        expect(parsed.context_length).toBe(1048576);
        expect(parsed.max_input_tokens).toBe(1048576);
    });
});
