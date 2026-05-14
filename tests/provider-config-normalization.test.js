import { normalizeProviderConfigFields } from '../src/utils/provider-config-normalizer.js';

describe('normalizeProviderConfigFields', () => {
    test('normalizes proxy provider lists and TLS boolean values round-tripped through text inputs', () => {
        const input = {
            customName: 'Codex OAuth',
            PROXY_ENABLED_PROVIDERS: 'openai-codex-oauth',
            TLS_SIDECAR_ENABLED: 'false',
            TLS_SIDECAR_ENABLED_PROVIDERS: '[]'
        };

        const normalized = normalizeProviderConfigFields(input);

        expect(normalized).toMatchObject({
            customName: 'Codex OAuth',
            PROXY_ENABLED_PROVIDERS: ['openai-codex-oauth'],
            TLS_SIDECAR_ENABLED: false,
            TLS_SIDECAR_ENABLED_PROVIDERS: []
        });
        expect(input.PROXY_ENABLED_PROVIDERS).toBe('openai-codex-oauth');
    });

    test('supports comma-separated and JSON array strings for known provider-list fields', () => {
        const normalized = normalizeProviderConfigFields({
            DEFAULT_MODEL_PROVIDERS: 'gemini-cli-oauth, openai-codex-oauth',
            PROXY_ENABLED_PROVIDERS: '["openai-codex-oauth", "gemini-cli-oauth", ""]',
            TLS_SIDECAR_ENABLED_PROVIDERS: ['openai-codex-oauth', ' ', 'gemini-cli-oauth']
        });

        expect(normalized.DEFAULT_MODEL_PROVIDERS).toEqual(['gemini-cli-oauth', 'openai-codex-oauth']);
        expect(normalized.PROXY_ENABLED_PROVIDERS).toEqual(['openai-codex-oauth', 'gemini-cli-oauth']);
        expect(normalized.TLS_SIDECAR_ENABLED_PROVIDERS).toEqual(['openai-codex-oauth', 'gemini-cli-oauth']);
    });

    test('normalizes truthy TLS sidecar string values', () => {
        expect(normalizeProviderConfigFields({ TLS_SIDECAR_ENABLED: 'true' }).TLS_SIDECAR_ENABLED).toBe(true);
        expect(normalizeProviderConfigFields({ TLS_SIDECAR_ENABLED: '1' }).TLS_SIDECAR_ENABLED).toBe(true);
        expect(normalizeProviderConfigFields({ TLS_SIDECAR_ENABLED: 'off' }).TLS_SIDECAR_ENABLED).toBe(false);
    });

    test('does not add typed fields that are absent from provider config', () => {
        const normalized = normalizeProviderConfigFields({ customName: 'plain provider' });

        expect(normalized).toEqual({ customName: 'plain provider' });
        expect(normalized).not.toHaveProperty('PROXY_ENABLED_PROVIDERS');
        expect(normalized).not.toHaveProperty('TLS_SIDECAR_ENABLED');
        expect(normalized).not.toHaveProperty('TLS_SIDECAR_ENABLED_PROVIDERS');
    });
});
