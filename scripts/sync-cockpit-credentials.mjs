import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const COCKPIT_DIR = '/Users/hal9000/.antigravity_cockpit';
const KEY_PATH = path.join(COCKPIT_DIR, 'secure-account-storage.key');
const ACCOUNTS_DIR = path.join(COCKPIT_DIR, 'accounts');
const KIRO_DIR = path.join(COCKPIT_DIR, 'kiro_accounts');

const LOCAL_CONFIGS_DIR = path.resolve(ROOT, 'configs');
const LOCAL_ANTI_DIR = path.join(LOCAL_CONFIGS_DIR, 'antigravity');
const LOCAL_KIRO_DIR = path.join(LOCAL_CONFIGS_DIR, 'kiro');
const LOCAL_POOLS_PATH = path.join(LOCAL_CONFIGS_DIR, 'provider_pools.json');

if (!fs.existsSync(KEY_PATH)) {
  console.error(`[Error] Cockpit secure storage key not found at ${KEY_PATH}`);
  process.exit(1);
}

const keyB64 = fs.readFileSync(KEY_PATH, 'utf8').trim();
const rawKey = Buffer.from(keyB64, 'base64');

function decrypt(item) {
  const nonce = Buffer.from(item.nonce, 'base64');
  const ciphertext = Buffer.from(item.ciphertext, 'base64');
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', rawKey, nonce);
  decipher.setAuthTag(tag);
  return JSON.parse(decipher.update(encrypted, null, 'utf8') + decipher.final('utf8'));
}

function extractEmailFromIdToken(idToken) {
  if (!idToken) return null;
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload.email || null;
  } catch {
    return null;
  }
}

async function main() {
  console.log('=== Syncing Cockpit Credentials to AIClient2API ===');

  if (!fs.existsSync(LOCAL_ANTI_DIR)) fs.mkdirSync(LOCAL_ANTI_DIR, { recursive: true });
  if (!fs.existsSync(LOCAL_KIRO_DIR)) fs.mkdirSync(LOCAL_KIRO_DIR, { recursive: true });

  const pools = JSON.parse(fs.readFileSync(LOCAL_POOLS_PATH, 'utf8'));
  if (!pools['gemini-antigravity']) pools['gemini-antigravity'] = [];
  if (!pools['claude-kiro-oauth']) pools['claude-kiro-oauth'] = [];

  // ==========================================
  // 1. Process Antigravity Accounts
  // ==========================================
  console.log('\n--- 1. Processing Antigravity Credentials ---');
  const antiFiles = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.bak'));
  const cockpitAntiAccounts = [];
  for (const f of antiFiles) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, f), 'utf8'));
      const acc = decrypt(raw);
      if (acc.disabled) {
        console.log(`[Antigravity] Account ${acc.email || acc.id} is disabled in cockpit, skipping.`);
        continue;
      }
      if (!acc.token || !acc.token.refresh_token) {
        console.log(`[Antigravity] Account ${acc.email || acc.id} has no refresh token, skipping.`);
        continue;
      }
      cockpitAntiAccounts.push(acc);
    } catch (e) {
      console.warn(`[Antigravity] Failed to decrypt ${f}:`, e.message);
    }
  }

  // Scan local existing files
  const localAntiFiles = fs.readdirSync(LOCAL_ANTI_DIR).filter(f => f.endsWith('.json'));
  const localAntiMap = new Map();
  for (const f of localAntiFiles) {
    const filePath = path.join(LOCAL_ANTI_DIR, f);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const email = extractEmailFromIdToken(data.id_token);
      if (email) {
        localAntiMap.set(email.toLowerCase(), { file: f, path: filePath, data });
      }
    } catch (e) {
      console.warn(`[Antigravity] Could not read local file ${f}:`, e.message);
    }
  }

  let antiTimestampBase = Date.now();
  let antiUpdatedCount = 0;
  let antiCreatedCount = 0;

  for (const acc of cockpitAntiAccounts) {
    const email = (acc.email || (acc.token && acc.token.email) || '').toLowerCase();
    if (!email) continue;

    let targetFileName;
    let targetFilePath;
    const existing = localAntiMap.get(email);

    if (existing) {
      targetFileName = existing.file;
      targetFilePath = existing.path;
      antiUpdatedCount++;
      console.log(`[Antigravity] Updating credentials for ${email} in ${targetFileName}`);
    } else {
      antiTimestampBase += 10;
      targetFileName = `${antiTimestampBase}_oauth_creds.json`;
      targetFilePath = path.join(LOCAL_ANTI_DIR, targetFileName);
      antiCreatedCount++;
      console.log(`[Antigravity] Creating new credentials for ${email} in ${targetFileName}`);
    }

    const credsContent = {
      access_token: acc.token.access_token || '',
      scope: acc.token.scope || 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform openid',
      token_type: acc.token.token_type || 'Bearer',
      id_token: acc.token.id_token || '',
      expiry_date: acc.token.expiry_timestamp ? acc.token.expiry_timestamp * 1000 : (Date.now() + 3600 * 1000),
      refresh_token: acc.token.refresh_token
    };

    fs.writeFileSync(targetFilePath, JSON.stringify(credsContent, null, 2) + '\n', 'utf8');

    // Update or add in provider_pools.json
    const relativePath = `./configs/antigravity/${targetFileName}`;
    let poolEntry = pools['gemini-antigravity'].find(item =>
      item.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH === relativePath ||
      (item.email && item.email.toLowerCase() === email)
    );

    if (poolEntry) {
      poolEntry.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH = relativePath;
      poolEntry.email = email;
      poolEntry.isHealthy = true;
      poolEntry.isDisabled = false;
      poolEntry.needsRefresh = false;
      poolEntry.errorCount = 0;
      poolEntry.lastErrorMessage = null;
      poolEntry.lastRefreshTime = Date.now();
    } else {
      pools['gemini-antigravity'].push({
        ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: relativePath,
        uuid: crypto.randomUUID(),
        checkModelName: 'gemini-2.5-computer-use-preview-10-2025',
        checkHealth: false,
        isHealthy: true,
        isDisabled: false,
        lastUsed: null,
        usageCount: 0,
        errorCount: 0,
        lastErrorTime: null,
        lastHealthCheckTime: new Date().toISOString(),
        lastHealthCheckModel: 'gemini-2.5-computer-use-preview-10-2025',
        lastErrorMessage: null,
        PROJECT_ID: '',
        needsRefresh: false,
        refreshCount: 0,
        customName: null,
        _lastSelectionSeq: 0,
        lastRefreshTime: Date.now(),
        scheduledRecoveryTime: null,
        email: email
      });
    }
  }

  // ==========================================
  // 2. Process Kiro Accounts
  // ==========================================
  console.log('\n--- 2. Processing Kiro Credentials ---');
  const kiroFiles = fs.readdirSync(KIRO_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.bak'));
  const cockpitKiroAccounts = [];
  for (const f of kiroFiles) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(KIRO_DIR, f), 'utf8'));
      const acc = decrypt(raw);
      if (acc.status === 'disabled') {
        console.log(`[Kiro] Account ${acc.email || acc.id} is disabled in cockpit, skipping.`);
        continue;
      }
      const rawToken = acc.kiro_auth_token_raw || {};
      const rToken = acc.refresh_token || rawToken.refreshToken;
      if (!rToken) {
        console.log(`[Kiro] Account ${acc.email || acc.id} has no refresh token, skipping.`);
        continue;
      }
      cockpitKiroAccounts.push(acc);
    } catch (e) {
      console.warn(`[Kiro] Failed to decrypt ${f}:`, e.message);
    }
  }

  // Scan local existing kiro folders
  const localKiroDirs = fs.readdirSync(LOCAL_KIRO_DIR).filter(f => {
    try {
      return fs.statSync(path.join(LOCAL_KIRO_DIR, f)).isDirectory();
    } catch {
      return false;
    }
  });

  const localKiroList = [];
  for (const d of localKiroDirs) {
    const jsonPath = path.join(LOCAL_KIRO_DIR, d, `${d}.json`);
    if (fs.existsSync(jsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        localKiroList.push({
          dir: d,
          jsonPath,
          email: data.email ? data.email.toLowerCase() : '',
          provider: (data.socialProvider || data.provider || '').toLowerCase(),
          userId: data.userId || ''
        });
      } catch (e) {
        console.warn(`[Kiro] Could not read ${jsonPath}:`, e.message);
      }
    }
  }

  let kiroTimestampBase = Date.now() + 1000;
  let kiroUpdatedCount = 0;
  let kiroCreatedCount = 0;

  for (const acc of cockpitKiroAccounts) {
    const rawToken = acc.kiro_auth_token_raw || {};
    const email = (acc.email || rawToken.email || '').toLowerCase();
    const cUserId = acc.user_id || acc.userId || rawToken.userId || rawToken.user_id || '';
    const rawProvider = acc.login_provider || rawToken.provider || rawToken.socialProvider || 'Google';
    const normalizedProvider = rawProvider.charAt(0).toUpperCase() + rawProvider.slice(1).toLowerCase();

    // Match by userId or (email + provider)
    let match = null;
    if (cUserId) {
      match = localKiroList.find(l => l.userId === cUserId);
    }
    if (!match && email) {
      match = localKiroList.find(l => l.email === email && l.provider === normalizedProvider.toLowerCase());
    }

    let targetDir;
    let targetFileName;
    let targetJsonPath;

    if (match) {
      targetDir = path.join(LOCAL_KIRO_DIR, match.dir);
      targetFileName = `${match.dir}.json`;
      targetJsonPath = match.jsonPath;
      kiroUpdatedCount++;
      console.log(`[Kiro] Updating credentials for ${email} (${normalizedProvider}) in ${match.dir}`);
    } else {
      kiroTimestampBase += 10;
      const newDirName = `${kiroTimestampBase}_kiro-auth-token`;
      targetDir = path.join(LOCAL_KIRO_DIR, newDirName);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      targetFileName = `${newDirName}.json`;
      targetJsonPath = path.join(targetDir, targetFileName);
      kiroCreatedCount++;
      console.log(`[Kiro] Creating new credentials for ${email} (${normalizedProvider}) in ${newDirName}`);
    }

    const credsContent = {
      accessToken: rawToken.accessToken || acc.access_token || '',
      refreshToken: rawToken.refreshToken || acc.refresh_token,
      profileArn: rawToken.profileArn || (acc.kiro_profile_raw && acc.kiro_profile_raw.arn) || 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK',
      expiresAt: rawToken.expiresAt || (acc.expires_at ? new Date(acc.expires_at * 1000).toISOString() : new Date().toISOString()),
      authMethod: rawToken.authMethod || 'social',
      provider: normalizedProvider,
      region: rawToken.region || 'us-east-1',
      socialProvider: normalizedProvider,
      email: email,
      userId: cUserId
    };

    fs.writeFileSync(targetJsonPath, JSON.stringify(credsContent, null, 2) + '\n', 'utf8');

    // Update or add in provider_pools.json
    const relativeDir = path.basename(targetDir);
    const relativePath = `./configs/kiro/${relativeDir}/${targetFileName}`;

    let poolEntry = pools['claude-kiro-oauth'].find(item =>
      item.KIRO_OAUTH_CREDS_FILE_PATH === relativePath ||
      (item.email && item.email.toLowerCase() === email && item.socialProvider && item.socialProvider.toLowerCase() === normalizedProvider.toLowerCase())
    );

    if (poolEntry) {
      poolEntry.KIRO_OAUTH_CREDS_FILE_PATH = relativePath;
      poolEntry.email = email;
      poolEntry.socialProvider = normalizedProvider;
      poolEntry.provider = normalizedProvider;
      poolEntry.authMethod = 'social';
      poolEntry.isHealthy = true;
      poolEntry.isDisabled = false;
      poolEntry.needsRefresh = false;
      poolEntry.errorCount = 0;
      poolEntry.lastErrorMessage = null;
      poolEntry.lastRefreshTime = Date.now();
    } else {
      pools['claude-kiro-oauth'].push({
        KIRO_OAUTH_CREDS_FILE_PATH: relativePath,
        uuid: crypto.randomUUID(),
        checkModelName: 'claude-haiku-4-5',
        checkHealth: false,
        isHealthy: true,
        isDisabled: false,
        lastUsed: null,
        usageCount: 0,
        errorCount: 0,
        lastErrorTime: null,
        lastHealthCheckTime: new Date().toISOString(),
        lastHealthCheckModel: 'claude-haiku-4-5',
        lastErrorMessage: null,
        needsRefresh: false,
        refreshCount: 0,
        customName: null,
        _lastSelectionSeq: 0,
        lastRefreshTime: Date.now(),
        scheduledRecoveryTime: null,
        socialProvider: normalizedProvider,
        authMethod: 'social',
        email: email,
        provider: normalizedProvider
      });
    }
  }

  // Save provider_pools.json locally
  fs.writeFileSync(LOCAL_POOLS_PATH, JSON.stringify(pools, null, 2) + '\n', 'utf8');
  console.log(`\n[Local Pools] Successfully updated configs/provider_pools.json`);
  console.log(`  - gemini-antigravity: total ${pools['gemini-antigravity'].length} accounts (updated: ${antiUpdatedCount}, created: ${antiCreatedCount})`);
  console.log(`  - claude-kiro-oauth: total ${pools['claude-kiro-oauth'].length} accounts (updated: ${kiroUpdatedCount}, created: ${kiroCreatedCount})`);

  // ==========================================
  // 3. Sync to NAS Production & Restart
  // ==========================================
  console.log('\n--- 3. Syncing to NAS Production (192.168.50.39) ---');
  try {
    console.log('[NAS Sync] Syncing configs/antigravity/ ...');
    execSync(`rsync -avz configs/antigravity/ nas:/vol1/1000/apps/AIClient2API/configs/antigravity/`, { stdio: 'inherit', cwd: ROOT });

    console.log('[NAS Sync] Syncing configs/kiro/ ...');
    execSync(`rsync -avz configs/kiro/ nas:/vol1/1000/apps/AIClient2API/configs/kiro/`, { stdio: 'inherit', cwd: ROOT });

    console.log('[NAS Sync] Syncing configs/provider_pools.json ...');
    execSync(`scp configs/provider_pools.json nas:/vol1/1000/apps/AIClient2API/configs/provider_pools.json`, { stdio: 'inherit', cwd: ROOT });

    console.log('[NAS Sync] Restarting systemd service aiclient2api on NAS ...');
    execSync(`ssh nas "echo jz0305 | sudo -S systemctl restart aiclient2api"`, { stdio: 'inherit', cwd: ROOT });

    console.log('\n[NAS Sync] Completed successfully!');
  } catch (err) {
    console.error('[NAS Sync Error]', err.message);
  }
}

main().catch(err => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
