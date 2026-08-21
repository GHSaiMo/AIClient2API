import { isClientProbePath, handleClientProbeRequest, getAppVersion } from '../../src/handlers/probe-handler.js';

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
});
