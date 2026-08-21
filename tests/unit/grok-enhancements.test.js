import { describe, it, expect, beforeEach } from '@jest/globals';
import { grokReasoningCache } from '../../src/providers/grok/grok-reasoning-cache.js';
import {
    isProblematicGrokToolSchema,
    sanitizeGrokTools,
    filterInternalXSearchOutput,
    SAFE_FUNCTION_PARAMETERS
} from '../../src/providers/grok/grok-tool-sanitizer.js';

describe('Phase 2: Grok Reasoning Replay & Tool Governance Suite', () => {

    describe('1. Grok Reasoning Replay Cache (grok-reasoning-cache.js)', () => {
        beforeEach(() => {
            grokReasoningCache.cache.clear();
        });

        it('should build isolated scoped keys for different callers and models', () => {
            const key1 = grokReasoningCache.buildScopedKey('caller_a', 'session_1', 'grok-3');
            const key2 = grokReasoningCache.buildScopedKey('caller_b', 'session_1', 'grok-3');
            const key3 = grokReasoningCache.buildScopedKey('caller_a', 'session_1', 'grok-4.20');

            expect(key1).not.toBe(key2);
            expect(key1).not.toBe(key3);
            expect(key1).toContain('grok-3');
            expect(key1).toContain('session_1');
        });

        it('should generate stable session key from conversation messages', () => {
            const messages1 = [{ role: 'user', content: 'Help me write a Python script' }];
            const messages2 = [{ role: 'user', content: 'Help me write a Python script' }];
            const messages3 = [{ role: 'user', content: 'Different topic' }];

            const key1 = grokReasoningCache.generateSessionKeyFromMessages(messages1);
            const key2 = grokReasoningCache.generateSessionKeyFromMessages(messages2);
            const key3 = grokReasoningCache.generateSessionKeyFromMessages(messages3);

            expect(key1).toBe(key2);
            expect(key1).not.toBe(key3);
        });

        it('should cache and retrieve reasoning items correctly', () => {
            const scopedKey = 'caller1:grok-3:sess123';
            const reasoningItems = [
                { type: 'reasoning', encrypted_content: 'enc_data_xyz', summary: 'thinking...' }
            ];

            grokReasoningCache.set(scopedKey, reasoningItems);
            const retrieved = grokReasoningCache.get(scopedKey);

            expect(retrieved).not.toBeNull();
            expect(retrieved.length).toBe(1);
            expect(retrieved[0].encrypted_content).toBe('enc_data_xyz');
        });

        it('should inject cached reasoning items into input when input lacks reasoning', () => {
            const scopedKey = 'caller1:grok-3:sess123';
            const reasoningItems = [
                { type: 'reasoning', encrypted_content: 'enc_data_xyz' }
            ];
            grokReasoningCache.set(scopedKey, reasoningItems);

            const inputItems = [
                { role: 'user', content: 'Step 1' },
                { role: 'assistant', content: 'Response 1' },
                { role: 'user', content: 'Step 2' }
            ];

            const updatedInput = grokReasoningCache.applyReplayToInput(inputItems, scopedKey);
            expect(updatedInput.length).toBe(4);
            expect(updatedInput[1].type).toBe('reasoning');
            expect(updatedInput[1].encrypted_content).toBe('enc_data_xyz');
            expect(updatedInput[2].role).toBe('assistant');
        });

        it('should not duplicate reasoning items if input already has reasoning', () => {
            const scopedKey = 'caller1:grok-3:sess123';
            grokReasoningCache.set(scopedKey, [{ type: 'reasoning', encrypted_content: 'enc_new' }]);

            const inputItems = [
                { type: 'reasoning', encrypted_content: 'enc_existing' },
                { role: 'user', content: 'Step 1' }
            ];

            const updatedInput = grokReasoningCache.applyReplayToInput(inputItems, scopedKey);
            expect(updatedInput.length).toBe(2);
            expect(updatedInput[0].encrypted_content).toBe('enc_existing');
        });
    });

    describe('2. Grok Tool Sanitizer & Hang Mitigation (grok-tool-sanitizer.js)', () => {
        it('should identify problematic tools like automation_update or codex_app', () => {
            expect(isProblematicGrokToolSchema('codex_app.automation_update', {})).toBe(true);
            expect(isProblematicGrokToolSchema('automation_update', {})).toBe(true);
            expect(isProblematicGrokToolSchema('readFile', { type: 'object' })).toBe(false);
        });

        it('should replace problematic tool schemas with safe placeholder schema', () => {
            const tools = [
                {
                    type: 'function',
                    function: {
                        name: 'codex_app.automation_update',
                        description: 'Codex app automation',
                        parameters: {
                            type: 'object',
                            oneOf: [{ $ref: '#/definitions/complex' }]
                        }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'runTerminalCommand',
                        description: 'Run command in shell',
                        parameters: {
                            type: 'object',
                            properties: { command: { type: 'string' } }
                        }
                    }
                }
            ];

            const sanitized = sanitizeGrokTools(tools);

            // Problematic tool schema should be replaced
            expect(sanitized[0].function.parameters).toEqual(SAFE_FUNCTION_PARAMETERS);
            // Normal tool should be unchanged
            expect(sanitized[1].function.parameters.properties.command.type).toBe('string');
        });

        it('should filter internal x_search trace events from stream output', () => {
            const normalEvent = {
                type: 'response.output_item.added',
                item: { type: 'message', content: 'Search results here' }
            };
            const internalTraceEvent = {
                type: 'response.output_item.added',
                item: { type: 'internal_x_search_trace', query: 'telemetry query' }
            };

            expect(filterInternalXSearchOutput(normalEvent)).toEqual(normalEvent);
            expect(filterInternalXSearchOutput(internalTraceEvent)).toBeNull();
        });
    });
});
