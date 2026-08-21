import { describe, it, expect } from '@jest/globals';
import { sanitizeJsonSchema, sanitizeToolSpecification } from '../../src/utils/schema-sanitizer.js';
import { processToolsWithLongDescriptions, DEFAULT_TOOL_DESCRIPTION_MAX_LENGTH } from '../../src/utils/tool-doc-offloader.js';
import {
    saveToolTruncation,
    getToolTruncation,
    saveContentTruncation,
    getContentTruncation,
    generateTruncationToolResult,
    generateTruncationUserMessage,
    injectTruncationRecovery
} from '../../src/providers/claude/kiro-truncation-recovery.js';
import { ensureAssistantBeforeToolResults } from '../../src/providers/claude/claude-kiro.js';

describe('Phase 1: Kiro Robustness & Compatibility Suite', () => {

    describe('1. Schema Sanitizer (schema-sanitizer.js)', () => {
        it('should recursively strip additionalProperties from all levels', () => {
            const rawSchema = {
                type: 'object',
                additionalProperties: false,
                properties: {
                    user: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                            name: { type: 'string' }
                        }
                    }
                }
            };

            const sanitized = sanitizeJsonSchema(rawSchema);
            expect(sanitized.additionalProperties).toBeUndefined();
            expect(sanitized.properties.user.additionalProperties).toBeUndefined();
            expect(sanitized.properties.user.properties.name.type).toBe('string');
        });

        it('should remove empty required arrays but preserve non-empty ones', () => {
            const rawSchema = {
                type: 'object',
                required: [],
                properties: {
                    config: {
                        type: 'object',
                        required: ['key', 'value'],
                        properties: {
                            key: { type: 'string' },
                            value: { type: 'string' }
                        }
                    }
                }
            };

            const sanitized = sanitizeJsonSchema(rawSchema);
            expect(sanitized.required).toBeUndefined();
            expect(sanitized.properties.config.required).toEqual(['key', 'value']);
        });

        it('should sanitize nested schemas in anyOf, oneOf, allOf, and items', () => {
            const rawSchema = {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: []
                },
                anyOf: [
                    { type: 'string', additionalProperties: false },
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            count: { type: 'number' }
                        }
                    }
                ]
            };

            const sanitized = sanitizeJsonSchema(rawSchema);
            expect(sanitized.items.additionalProperties).toBeUndefined();
            expect(sanitized.items.required).toBeUndefined();
            expect(sanitized.anyOf[0].additionalProperties).toBeUndefined();
            expect(sanitized.anyOf[1].additionalProperties).toBeUndefined();
            expect(sanitized.anyOf[1].properties.count.type).toBe('number');
        });

        it('should sanitize toolSpecification object correctly', () => {
            const toolSpec = {
                name: 'readFile',
                description: 'Read file contents',
                inputSchema: {
                    json: {
                        type: 'object',
                        additionalProperties: false,
                        required: [],
                        properties: {
                            path: { type: 'string' }
                        }
                    }
                }
            };

            const sanitized = sanitizeToolSpecification(toolSpec);
            expect(sanitized.inputSchema.json.additionalProperties).toBeUndefined();
            expect(sanitized.inputSchema.json.required).toBeUndefined();
            expect(sanitized.inputSchema.json.properties.path.type).toBe('string');
        });
    });

    describe('2. Tool Description Offloader (tool-doc-offloader.js)', () => {
        it('should leave short descriptions untouched', () => {
            const tools = [
                {
                    name: 'getWeather',
                    description: 'Get current weather for a city',
                    input_schema: { type: 'object' }
                }
            ];

            const { processedTools, toolDocumentation } = processToolsWithLongDescriptions(tools, { maxLength: 100 });
            expect(processedTools[0].description).toBe('Get current weather for a city');
            expect(toolDocumentation).toBe('');
        });

        it('should offload long descriptions to system prompt and insert anchor', () => {
            const longDesc = 'A'.repeat(500);
            const tools = [
                {
                    name: 'complexCodeRunner',
                    description: longDesc,
                    input_schema: { type: 'object' }
                },
                {
                    name: 'shortTool',
                    description: 'Short desc',
                    input_schema: { type: 'object' }
                }
            ];

            const { processedTools, toolDocumentation } = processToolsWithLongDescriptions(tools, { maxLength: 200 });

            // The long tool should have description replaced
            expect(processedTools[0].description).toContain("[Full documentation in system prompt under '## Tool: complexCodeRunner']");
            // The short tool should be unchanged
            expect(processedTools[1].description).toBe('Short desc');
            // Tool documentation should contain the original long description
            expect(toolDocumentation).toContain('## Tool: complexCodeRunner');
            expect(toolDocumentation).toContain(longDesc);
        });

        it('should handle Kiro toolSpecification format', () => {
            const longDesc = 'B'.repeat(300);
            const tools = [
                {
                    toolSpecification: {
                        name: 'kiro_long_tool',
                        description: longDesc,
                        inputSchema: { json: {} }
                    }
                }
            ];

            const { processedTools, toolDocumentation } = processToolsWithLongDescriptions(tools, { maxLength: 100 });
            expect(processedTools[0].toolSpecification.description).toContain("[Full documentation in system prompt under '## Tool: kiro_long_tool']");
            expect(toolDocumentation).toContain('## Tool: kiro_long_tool');
            expect(toolDocumentation).toContain(longDesc);
        });
    });

    describe('3. Truncation Recovery System (kiro-truncation-recovery.js)', () => {
        it('should save and consume tool truncation info once', () => {
            const callId = 'call_test_123';
            saveToolTruncation(callId, 'writeFile', { size: 5000 });

            const retrieved = getToolTruncation(callId);
            expect(retrieved).not.toBeNull();
            expect(retrieved.toolName).toBe('writeFile');
            expect(retrieved.diagnostics.size).toBe(5000);

            // Second retrieval should be null (consumed)
            expect(getToolTruncation(callId)).toBeNull();
        });

        it('should save and consume content truncation by hash', () => {
            const content = 'This is a truncated assistant reply that ended abruptly...';
            const hash = saveContentTruncation(content);
            expect(hash).toBeTruthy();

            const retrieved = getContentTruncation(content);
            expect(retrieved).not.toBeNull();
            expect(retrieved.hash).toBe(hash);

            // Second retrieval should be null
            expect(getContentTruncation(content)).toBeNull();
        });

        it('should generate properly formatted synthetic truncation tool_result', () => {
            const result = generateTruncationToolResult('editFile', 'call_abc');
            expect(result.type).toBe('tool_result');
            expect(result.tool_use_id).toBe('call_abc');
            expect(result.is_error).toBe(true);
            expect(result.content).toContain('[API Limitation]');
            expect(result.content).toContain('editFile');
            expect(result.content).toContain('smaller chunks');
        });

        it('should inject truncation recovery notice into matching tool_results', () => {
            const callId = 'call_truncated_456';
            saveToolTruncation(callId, 'largeWriteTool', {});

            const incomingMessages = [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: callId,
                            content: 'Error: Unexpected EOF'
                        },
                        {
                            type: 'tool_result',
                            tool_use_id: 'call_normal_789',
                            content: 'Success'
                        }
                    ]
                }
            ];

            const enhancedMessages = injectTruncationRecovery(incomingMessages);
            const userContent = enhancedMessages[0].content;

            expect(userContent[0].content).toContain('[API Limitation]');
            expect(userContent[0].content).toContain('largeWriteTool');
            expect(userContent[0].content).toContain('[Original Execution Result]:\nError: Unexpected EOF');
            expect(userContent[0].is_error).toBe(true);

            // Untruncated tool result should remain normal
            expect(userContent[1].content).toBe('Success');
        });
    });

    describe('4. Orphan Tool Result Repair (ensureAssistantBeforeToolResults)', () => {
        it('should synthesize an assistant tool_use message if user tool_result has no preceding assistant', () => {
            const messages = [
                { role: 'user', content: 'Hello' },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'call_1', content: 'file data' }
                    ]
                }
            ];

            const fixed = ensureAssistantBeforeToolResults(messages);
            expect(fixed.length).toBe(3);
            expect(fixed[0].role).toBe('user');
            expect(fixed[1].role).toBe('assistant');
            expect(fixed[1].content[0].type).toBe('tool_use');
            expect(fixed[1].content[0].id).toBe('call_1');
            expect(fixed[2].role).toBe('user');
        });

        it('should not add synthetic assistant if preceding assistant has tool_use', () => {
            const messages = [
                {
                    role: 'assistant',
                    content: [
                        { type: 'tool_use', id: 'call_1', name: 'readFile', input: {} }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'call_1', content: 'file data' }
                    ]
                }
            ];

            const fixed = ensureAssistantBeforeToolResults(messages);
            expect(fixed.length).toBe(2);
            expect(fixed[0].role).toBe('assistant');
            expect(fixed[1].role).toBe('user');
        });
    });
});
