import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Logger } from '../../src/utils/logger.js';
import { timingSafeCompareKey } from '../../src/plugins/default-auth/index.js';
import { handleStreamRequest } from '../../src/utils/common.js';
import requestContext from '../../src/utils/context.js';
import aiMonitorPlugin from '../../src/plugins/ai-monitor/index.js';
import { ProviderPoolManager } from '../../src/providers/provider-pool-manager.js';

describe('Full Gateway Optimizations Suite', () => {
    describe('1. Logger Base64 Redaction, Size Cap & Midnight Rotation', () => {
        it('should redact large base64 blobs and data URIs in objects and raw strings', () => {
            const testLogger = new Logger();
            testLogger.initialize({ outputMode: 'console', includeTimestamp: false });

            const hugeB64 = 'A'.repeat(4096);
            const objFormatted = testLogger.formatMessage('info', [{ type: 'image', blob: hugeB64 }], 'req-1');
            expect(objFormatted).toContain('<base64 len=4096>');
            expect(objFormatted).not.toContain(hugeB64);

            const rawJson = `{"type":"image","blob":"${hugeB64}"}`;
            const strFormatted = testLogger.formatMessage('info', [rawJson], 'req-2');
            expect(strFormatted).toContain('"blob":"<base64 redacted>"');
            expect(strFormatted).not.toContain(hugeB64);

            const dataUri = `data:image/jpeg;base64,${hugeB64}`;
            const uriFormatted = testLogger.formatMessage('info', [dataUri], 'req-3');
            expect(uriFormatted).toContain('<data-uri len=');
            expect(uriFormatted).not.toContain(hugeB64);
        });

        it('should enforce maxMessageLength truncation on oversized log lines', () => {
            const testLogger = new Logger();
            testLogger.initialize({ outputMode: 'console', includeTimestamp: false, maxMessageLength: 500 });

            const longText = 'x'.repeat(2000);
            const formatted = testLogger.formatMessage('info', [longText], null);
            expect(formatted).toContain('[truncated 1500 chars]');
            expect(formatted.length).toBeLessThan(600);
        });

        it('should rotate log file automatically when local date changes across midnight', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-log-test-'));
            const testLogger = new Logger();
            try {
                testLogger.initialize({ outputMode: 'file', logDir: tmpDir });
                // Simulate started on an old date
                testLogger.initializeFileLogging('2000-01-01');
                expect(path.basename(testLogger.currentLogFile)).toBe('app-2000-01-01.log');

                testLogger.checkAndRotateLogFile();
                expect(path.basename(testLogger.currentLogFile)).not.toBe('app-2000-01-01.log');
                expect(testLogger.currentDateStr).not.toBe('2000-01-01');
            } finally {
                testLogger.close();
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });

    describe('2. Timing-Safe API Key Verification', () => {
        it('should match identical keys and reject mismatched lengths or empty keys safely', () => {
            expect(timingSafeCompareKey('secret-key-123', 'secret-key-123')).toBe(true);
            expect(timingSafeCompareKey('secret-key-124', 'secret-key-123')).toBe(false);
            expect(timingSafeCompareKey('short', 'secret-key-123')).toBe(false);
            expect(timingSafeCompareKey(null, 'secret-key-123')).toBe(false);
            expect(timingSafeCompareKey('secret-key-123', '')).toBe(false);
        });
    });

    describe('3. Client Disconnect AbortSignal Propagation & Provider Immunity', () => {
        it('should abort upstream stream via requestContext signal on client close and NOT penalize provider', async () => {
            const mockRes = new EventEmitter();
            mockRes.writableEnded = false;
            mockRes.finished = false;
            mockRes.destroyed = false;
            mockRes.writeHead = jest.fn();
            mockRes.write = jest.fn(() => true);
            mockRes.end = jest.fn(() => { mockRes.writableEnded = true; });

            let capturedSignal = null;
            const mockService = {
                async *generateContentStream() {
                    capturedSignal = requestContext.get('upstreamAbortSignal');
                    yield { choices: [{ delta: { content: 'Hello' } }] };
                    // Wait until client disconnects and aborts signal
                    await new Promise((_, reject) => {
                        capturedSignal.addEventListener('abort', () => {
                            const err = new Error('Aborted by client');
                            err.isClientAbort = true;
                            reject(err);
                        }, { once: true });
                        // Simulate client hitting Stop Generating
                        setImmediate(() => mockRes.emit('close'));
                    });
                }
            };

            const mockPoolManager = {
                markProviderHealthy: jest.fn(),
                markProviderUnhealthy: jest.fn(),
                markProviderUnhealthyImmediately: jest.fn(),
                releaseSlot: jest.fn()
            };

            await handleStreamRequest(
                mockRes,
                mockService,
                'gpt-5.6-luna',
                { messages: [{ role: 'user', content: 'hi' }] },
                'openai',
                'openai',
                'none',
                '',
                mockPoolManager,
                'node-uuid-1',
                'Node 1',
                { CONFIG: { _monitorRequestId: 'test-abort-req' }, currentRetry: 0, maxRetries: 2 }
            );

            expect(capturedSignal).toBeDefined();
            expect(capturedSignal.aborted).toBe(true);
            expect(mockPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
            expect(mockPoolManager.markProviderUnhealthyImmediately).not.toHaveBeenCalled();
            expect(mockPoolManager.releaseSlot).toHaveBeenCalledWith('openai', 'node-uuid-1');
        });
    });

    describe('4. Deterministic AI Monitor Stream Cache Flush (No 2000ms Blind Timer)', () => {
        it('should immediately flush and delete streamCache entry on onStreamEnd', async () => {
            const reqId = 'stream-end-req-1';
            await aiMonitorPlugin.hooks.onStreamChunk({
                requestId: reqId,
                fromProvider: 'openai',
                toProvider: 'claude-kiro-oauth',
                nativeChunk: { delta: 'hi' },
                chunkToSend: { choices: [{ delta: { content: 'hi' } }] }
            });
            expect(aiMonitorPlugin.streamCache.has(reqId)).toBe(true);

            await aiMonitorPlugin.hooks.onStreamEnd({ requestId: reqId });
            expect(aiMonitorPlugin.streamCache.has(reqId)).toBe(false);
        });
    });

    describe('5. ProviderPoolManager Graceful Shutdown Flush', () => {
        it('should flush debounced pending saves immediately on shutdown()', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pool-flush-'));
            const poolsPath = path.join(tmpDir, 'provider_pools.json');
            const initialPools = {
                'openai-codex-oauth': [
                    { uuid: 'u-1', customName: 'Codex-1', isHealthy: true, isDisabled: false }
                ]
            };
            fs.writeFileSync(poolsPath, JSON.stringify(initialPools, null, 2));

            try {
                const manager = new ProviderPoolManager(initialPools, {
                    saveDebounceTime: 60000, // 60s debounce so timer won't fire on its own
                    saveMaxWaitTime: 60000,
                    globalConfig: { PROVIDER_POOLS_FILE_PATH: poolsPath }
                });

                manager.markProviderUnhealthyImmediately('openai-codex-oauth', { uuid: 'u-1' }, '401 token revoked');
                expect(manager.pendingSaves.has('openai-codex-oauth')).toBe(true);

                await manager.shutdown();
                expect(manager.pendingSaves.size).toBe(0);

                const persisted = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));
                expect(persisted['openai-codex-oauth'][0].isHealthy).toBe(false);
                expect(persisted['openai-codex-oauth'][0].lastErrorMessage).toBe('401 token revoked');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });
});
