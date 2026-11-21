import { MODEL_PROTOCOL_PREFIX } from './constants.js';

export const ENDPOINT_TYPE = {
    OPENAI_CHAT: 'openai_chat',
    OPENAI_RESPONSES: 'openai_responses',
    GEMINI_CONTENT: 'gemini_content',
    CLAUDE_MESSAGE: 'claude_message',
    OPENAI_MODEL_LIST: 'openai_model_list',
    GEMINI_MODEL_LIST: 'gemini_model_list',
};

/**
 * Extracts the protocol prefix from a given model provider string.
 * This is used to determine if two providers belong to the same underlying protocol (e.g., gemini, openai, claude).
 * @param {string} provider - The model provider string (e.g., 'claude-kiro-oauth', 'openai-custom').
 * @returns {string} The protocol prefix (e.g., 'gemini', 'openai', 'claude').
 */
export function getProtocolPrefix(provider) {
    if (!provider || typeof provider !== 'string') {
        return '';
    }
    // Special case for Codex - it needs its own protocol
    if (provider === 'openai-codex-oauth') {
        return MODEL_PROTOCOL_PREFIX.CODEX;
    }
    // Grok CLI OAuth talks to xAI Responses API directly.
    if (provider === 'grok-cli-oauth' || provider.startsWith('grok-cli-oauth-')) {
        return MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
    }
    // Special cases for OpenAI-compatible dedicated providers.
    if (provider === 'atlascloud' || provider.startsWith('atlascloud-') ||
        provider === 'qiniu' || provider.startsWith('qiniu-') ||
        provider === 'fenno' || provider.startsWith('fenno-')) {
        return MODEL_PROTOCOL_PREFIX.OPENAI;
    }
    // ChatGPT Web
    if (provider === 'chatgpt-web' || provider.startsWith('chatgpt-web-')) {
        return MODEL_PROTOCOL_PREFIX.CHATGPT;
    }
    // Gemini Web (talks OpenAI format locally to sidecar)
    if (provider === 'gemini-web' || provider.startsWith('gemini-web-')) {
        return MODEL_PROTOCOL_PREFIX.OPENAI;
    }
    // Tencent Yuanbao Web (talks OpenAI format locally to runner)
    if (provider === 'yuanbao-web' || provider.startsWith('yuanbao-web-') || provider === 'yuanbao') {
        return MODEL_PROTOCOL_PREFIX.OPENAI;
    }

    const hyphenIndex = provider.indexOf('-');
    if (hyphenIndex !== -1) {
        return provider.substring(0, hyphenIndex);
    }
    return provider;
}
