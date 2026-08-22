import { describe, it, expect } from '@jest/globals';
import { isRetryableNetworkError, RETRYABLE_NETWORK_ERRORS, handleError } from '../../src/utils/common.js';

describe('Stream Lifecycle & Network Error Safety Suite', () => {

    describe('1. Non-Fatal Stream Error Classification in isRetryableNetworkError', () => {
        it('should classify ERR_STREAM_WRITE_AFTER_END as non-fatal network/stream error', () => {
            const err = new Error('write after end');
            err.code = 'ERR_STREAM_WRITE_AFTER_END';
            expect(isRetryableNetworkError(err)).toBe(true);
        });

        it('should classify ERR_STREAM_DESTROYED and ERR_STREAM_PREMATURE_CLOSE as non-fatal', () => {
            const err1 = { code: 'ERR_STREAM_DESTROYED', message: 'Cannot call write after a stream was destroyed' };
            const err2 = { code: 'ERR_STREAM_PREMATURE_CLOSE', message: 'Premature close' };
            expect(isRetryableNetworkError(err1)).toBe(true);
            expect(isRetryableNetworkError(err2)).toBe(true);
        });

        it('should classify ERR_HTTP_HEADERS_SENT as non-fatal stream error', () => {
            const err = { code: 'ERR_HTTP_HEADERS_SENT', message: 'Cannot set headers after they are sent to the client' };
            expect(isRetryableNetworkError(err)).toBe(true);
        });

        it('should recognize errors with nested cause', () => {
            const err = new Error('fetch failed');
            err.cause = { code: 'ECONNRESET', message: 'read ECONNRESET' };
            expect(isRetryableNetworkError(err)).toBe(true);
        });
    });

    describe('2. Response Writable Safety in handleError', () => {
        it('should not throw or write when res.writableEnded is true (fromProvider branch)', () => {
            const mockRes = {
                writableEnded: true,
                destroyed: false,
                finished: true,
                headersSent: true,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            const err = new Error('Some upstream stream error');
            expect(() => {
                handleError(mockRes, err, 'claude-kiro-oauth', 'openai');
            }).not.toThrow();

            expect(mockRes.writeHead).not.toHaveBeenCalled();
            expect(mockRes.end).not.toHaveBeenCalled();
        });

        it('should not throw or write when res.writableEnded is true (default branch)', () => {
            const mockRes = {
                writableEnded: true,
                destroyed: false,
                finished: true,
                headersSent: true,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            const err = new Error('Some upstream stream error');
            expect(() => {
                handleError(mockRes, err, 'claude-kiro-oauth');
            }).not.toThrow();

            expect(mockRes.writeHead).not.toHaveBeenCalled();
            expect(mockRes.end).not.toHaveBeenCalled();
        });
    });
});
