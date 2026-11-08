import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { autoLinkProviderConfigs } from '../src/services/service-manager.js';
import { CONFIG } from '../src/core/config-manager.js';

function parseJwt(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

function sanitizeFilenamePart(value) {
    const sanitized = String(value || 'default')
        .trim()
        .replace(/[^a-zA-Z0-9@._+-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 120);
    return sanitized || 'default';
}

async function main() {
    const homeDir = os.homedir();
    const cockpitDir = path.join(homeDir, '.antigravity_cockpit');
    const storageKeyFile = path.join(cockpitDir, 'secure-account-storage.key');
    const accountsIndexFile = path.join(cockpitDir, 'codex_accounts.json');
    const accountsDir = path.join(cockpitDir, 'codex_accounts');

    if (!fs.existsSync(storageKeyFile)) {
        throw new Error(`Cockpit storage key not found at ${storageKeyFile}`);
    }
    if (!fs.existsSync(accountsIndexFile)) {
        throw new Error(`Cockpit accounts index not found at ${accountsIndexFile}`);
    }

    const keyBase64 = (await fs.promises.readFile(storageKeyFile, 'utf8')).trim();
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) {
        throw new Error(`Invalid storage key length: ${key.length} (expected 32)`);
    }

    const indexContent = await fs.promises.readFile(accountsIndexFile, 'utf8');
    const indexData = JSON.parse(indexContent);
    const accounts = Array.isArray(indexData.accounts) ? indexData.accounts : [];

    console.log(`[Cockpit Migrate] Found ${accounts.length} Codex account(s) in index.`);

    const targetDir = path.join(process.cwd(), 'configs', 'codex');
    await fs.promises.mkdir(targetDir, { recursive: true });

    const migratedFiles = [];

    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        const accFilePath = path.join(accountsDir, `${acc.id}.json`);
        if (!fs.existsSync(accFilePath)) {
            console.warn(`[Cockpit Migrate] Account file ${accFilePath} not found, skipping.`);
            continue;
        }

        const raw = JSON.parse(await fs.promises.readFile(accFilePath, 'utf8'));
        let detail;

        if (raw.ciphertext && raw.nonce) {
            const nonce = Buffer.from(raw.nonce, 'base64');
            const ciphertextAndTag = Buffer.from(raw.ciphertext, 'base64');
            const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
            const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);

            const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
            decipher.setAuthTag(tag);
            const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            detail = JSON.parse(decrypted.toString('utf8'));
        } else {
            detail = raw;
        }

        const tokens = detail.tokens || detail.token || {};
        const accessToken = tokens.access_token;
        const refreshToken = tokens.refresh_token || '';
        const idToken = tokens.id_token || '';

        if (!accessToken) {
            console.warn(`[Cockpit Migrate] Account ${acc.id} (${acc.email}) has no access_token, skipping.`);
            continue;
        }

        const accessClaims = parseJwt(accessToken);
        const idClaims = parseJwt(idToken);
        const claims = idClaims || accessClaims || {};
        const authClaims = claims['https://api.openai.com/auth'] || {};
        const profileClaims = claims['https://api.openai.com/profile'] || {};

        const accountId = detail.account_id ||
            authClaims.chatgpt_account_id ||
            claims.sub ||
            tokens.account_id;

        const email = detail.email ||
            acc.email ||
            profileClaims.email ||
            claims.email ||
            `codex-${accountId}`;

        let expired = null;
        if (accessClaims?.exp) {
            expired = new Date(accessClaims.exp * 1000).toISOString();
        } else if (acc.subscription_active_until) {
            expired = new Date(acc.subscription_active_until).toISOString();
        } else {
            expired = new Date(Date.now() + 3600 * 1000).toISOString();
        }

        const credentials = {
            id_token: idToken,
            access_token: accessToken,
            refresh_token: refreshToken,
            account_id: accountId,
            last_refresh: detail.token_updated_at
                ? new Date(detail.token_updated_at * 1000).toISOString()
                : new Date().toISOString(),
            email: email,
            name: email,
            type: 'codex',
            expired: expired,
            access_token_only: !refreshToken
        };

        const safeEmail = sanitizeFilenamePart(email);
        const timestamp = Date.now() + i * 10;
        const filename = `${timestamp}_codex-${safeEmail}_oauth_creds.json`;
        const destPath = path.join(targetDir, filename);

        await fs.promises.writeFile(destPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
        migratedFiles.push({ email, path: path.relative(process.cwd(), destPath) });
        console.log(`[Cockpit Migrate] ✅ Migrated: ${email} -> ${filename}`);
    }

    console.log(`\n[Cockpit Migrate] Successfully migrated ${migratedFiles.length} credentials to configs/codex/.`);

    // Auto-link into provider_pools.json
    console.log('[Cockpit Migrate] Auto-linking into provider pools...');
    await autoLinkProviderConfigs(CONFIG);
    console.log('[Cockpit Migrate] Auto-link complete!');
}

main().catch(err => {
    console.error('[Cockpit Migrate] Fatal error:', err);
    process.exit(1);
});
