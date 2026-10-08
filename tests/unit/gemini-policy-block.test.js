import { describe, test, expect } from 'bun:test';
import { ConverterFactory } from '../../src/converters/ConverterFactory.js';
import { MODEL_PROTOCOL_PREFIX } from '../../src/utils/constants.js';
import '../../src/converters/register-converters.js';

describe('Gemini Content Policy Block and FinishReason Mapping Suite', () => {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);

    test('toOpenAIResponse: should map PROHIBITED_CONTENT promptFeedback blockReason to content_filter finish_reason', () => {
        const geminiBlockedResponse = {
            usageMetadata: {
                promptTokenCount: 9333,
                totalTokenCount: 9333
            },
            promptFeedback: {
                blockReason: 'PROHIBITED_CONTENT',
                blockReasonMessage: "The prompt could not be submitted. The prompt contains sensitive words that violate Google's Generative AI Prohibited Use policy."
            }
        };

        const result = converter.toOpenAIResponse(geminiBlockedResponse, 'gemini-3.8-flash');
        expect(result).toBeDefined();
        expect(result.choices).toBeDefined();
        expect(result.choices.length).toBe(1);
        expect(result.choices[0].finish_reason).toBe('content_filter');
    });

    test('toOpenAIResponse: should map SAFETY candidate finishReason to content_filter', () => {
        const geminiSafetyResponse = {
            candidates: [{
                finishReason: 'SAFETY',
                content: {
                    parts: [{ text: 'Partial text before safety block' }]
                }
            }],
            usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 10,
                totalTokenCount: 110
            }
        };

        const result = converter.toOpenAIResponse(geminiSafetyResponse, 'gemini-3.8-flash');
        expect(result.choices[0].finish_reason).toBe('content_filter');
        expect(result.choices[0].message.content).toBe('Partial text before safety block');
    });

    test('toOpenAIResponse: should map normal STOP candidate to stop', () => {
        const geminiNormalResponse = {
            candidates: [{
                finishReason: 'STOP',
                content: {
                    parts: [{ text: 'Hello, world!' }]
                }
            }]
        };

        const result = converter.toOpenAIResponse(geminiNormalResponse, 'gemini-3.8-flash');
        expect(result.choices[0].finish_reason).toBe('stop');
        expect(result.choices[0].message.content).toBe('Hello, world!');
    });

    test('toOpenAIResponse: should map MAX_TOKENS to length', () => {
        const geminiLengthResponse = {
            candidates: [{
                finishReason: 'MAX_TOKENS',
                content: {
                    parts: [{ text: 'Truncated output...' }]
                }
            }]
        };

        const result = converter.toOpenAIResponse(geminiLengthResponse, 'gemini-3.8-flash');
        expect(result.choices[0].finish_reason).toBe('length');
    });

    test('toClaudeResponse: should map PROHIBITED_CONTENT promptFeedback to refusal stop_reason', () => {
        const geminiBlockedResponse = {
            promptFeedback: {
                blockReason: 'PROHIBITED_CONTENT'
            }
        };

        const result = converter.toClaudeResponse(geminiBlockedResponse, 'gemini-3.8-flash');
        expect(result.stop_reason).toBe('refusal');
    });

    test('toClaudeResponse: should map SAFETY candidate finishReason to refusal stop_reason', () => {
        const geminiSafetyResponse = {
            candidates: [{
                finishReason: 'SAFETY',
                content: {
                    parts: [{ text: 'Filtered' }]
                }
            }]
        };

        const result = converter.toClaudeResponse(geminiSafetyResponse, 'gemini-3.8-flash');
        expect(result.stop_reason).toBe('refusal');
    });
});
