const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

chromium.use(stealth);

// ==========================================
// ĐỌC CẤU HÌNH TỪ WEB UI
// ==========================================
let UI_CONFIG = { viotpToken: "", accountCount: 1 };
if (fs.existsSync('ui_config.json')) {
    try {
        UI_CONFIG = JSON.parse(fs.readFileSync('ui_config.json', 'utf8'));
    } catch (e) {}
}

const VIOTP_API_TOKEN = UI_CONFIG.viotpToken;
const IS_MANUAL_MODE = process.argv[2] === 'manual';
if (!VIOTP_API_TOKEN && require.main === module && !IS_MANUAL_MODE) {
    console.error("[Lỗi] Chưa cấu hình API Token ViOTP. Vui lòng thiết lập trên giao diện!");
    process.exit(1);
}
const VIOTP_SERVICE_ID = 1234; // Thường OpenAI là số 7 trên ViOTP. Nếu sai bạn sửa ở đây.
const NEST_PROXY_API_BASE = 'https://nestproxy.com/api/client/proxy';

const BROWSER_LAYOUT = {
  targetWidth: 450,
  targetHeight: 850,
  minWidth: 320,
  gap: 8,
  fallbackScreenWidth: 1366,
  fallbackScreenHeight: 768
};
let screenSizeCache = null;
const OTP_ENTRY_GAP_MS = 1000;
let otpEntryQueue = Promise.resolve();
let lastOtpEntryAt = 0;

async function runWithOtpEntryDelay(threadId, label, action) {
  const queued = otpEntryQueue.then(async () => {
    const waitMs = Math.max(0, OTP_ENTRY_GAP_MS - (Date.now() - lastOtpEntryAt));
    if (waitMs > 0) {
      console.log(`[WAIT] [Luồng ${threadId}] Chờ ${waitMs}ms trước khi nhập OTP ${label}...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    lastOtpEntryAt = Date.now();
    return action();
  });

  otpEntryQueue = queued.catch(() => {});
  return queued;
}

function positiveInt(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function getNestProxyKeys() {
  const raw = UI_CONFIG.nestProxyKeys || "";
  return raw
    .split(/[\s,;]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function formatProxyServer(proxy) {
  if (!proxy) return null;
  if (/^https?:\/\//i.test(proxy) || /^socks[45]?:\/\//i.test(proxy)) return proxy;
  return `http://${proxy}`;
}

async function fetchNestProxyJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {}

  if (!res.ok) {
    throw new Error(`NestProxy HTTP ${res.status}: ${text}`);
  }

  return json;
}

async function rotateNestProxy(proxyKey, threadId, taskIndex) {
  if (!proxyKey) return null;

  const encodedKey = encodeURIComponent(proxyKey);
  try {
    console.log(`[ACTION] [Luồng ${threadId}] Đang xoay NestProxy cho tài khoản ${taskIndex}...`);
    await fetchNestProxyJson(`${NEST_PROXY_API_BASE}/remove?proxy_key=${encodedKey}`, { method: 'POST' }).catch(error => {
      console.log(`[WARN] [Luồng ${threadId}] Không remove proxy cũ được: ${error.message}`);
    });

    const json = await fetchNestProxyJson(`${NEST_PROXY_API_BASE}/available?proxy_key=${encodedKey}`);
    const proxy = json?.data?.proxy || json?.proxy || json?.data;
    if (!proxy || typeof proxy !== 'string') {
      throw new Error(`Response không có proxy hợp lệ: ${JSON.stringify(json)}`);
    }

    console.log(`[SUCCESS] [Luồng ${threadId}] NestProxy mới: ${proxy}`);
    return proxy;
  } catch (error) {
    console.log(`[WARN] [Luồng ${threadId}] Không lấy được NestProxy: ${error.message}. Sẽ chạy không proxy.`);
    return null;
  }
}

async function resetNestProxy(proxyKey, threadId, taskIndex) {
  if (!proxyKey) return;

  const encodedKey = encodeURIComponent(proxyKey);
  try {
    console.log(`[ACTION] [Luồng ${threadId}] Reset NestProxy sau tài khoản ${taskIndex}...`);
    await fetchNestProxyJson(`${NEST_PROXY_API_BASE}/remove?proxy_key=${encodedKey}`, { method: 'POST' });
    console.log(`[SUCCESS] [Luồng ${threadId}] Đã reset NestProxy.`);
  } catch (error) {
    console.log(`[WARN] [Luồng ${threadId}] Reset NestProxy thất bại: ${error.message}`);
  }
}

function isProxyConnectionError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return [
    'proxy',
    'err_proxy_connection_failed',
    'err_tunnel_connection_failed',
    'err_socks_connection_failed',
    'err_internet_disconnected',
    'no internet',
    'address is incorrect'
  ].some(text => message.includes(text));
}

function readLinuxScreenSize() {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return null;

  try {
    const output = execFileSync('xrandr', ['--current'], { encoding: 'utf8', timeout: 1000 });
    const match = output.match(/\bcurrent\s+(\d+)\s+x\s+(\d+)/);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  } catch (e) {}

  try {
    const output = execFileSync('xdpyinfo', { encoding: 'utf8', timeout: 1000 });
    const match = output.match(/dimensions:\s+(\d+)x(\d+)\s+pixels/);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  } catch (e) {}

  return null;
}

function getScreenSize() {
  if (screenSizeCache) return screenSizeCache;

  const envWidth = positiveInt(process.env.BROWSER_SCREEN_WIDTH);
  const envHeight = positiveInt(process.env.BROWSER_SCREEN_HEIGHT);
  if (envWidth && envHeight) {
    screenSizeCache = { width: envWidth, height: envHeight };
    return screenSizeCache;
  }

  screenSizeCache = readLinuxScreenSize() || {
    width: BROWSER_LAYOUT.fallbackScreenWidth,
    height: BROWSER_LAYOUT.fallbackScreenHeight
  };
  return screenSizeCache;
}

function getBrowserWindowLayout(threadId, threadCount) {
  const screen = getScreenSize();
  const count = Math.max(1, positiveInt(threadCount) || 1);
  const index = Math.max(0, (positiveInt(threadId) || 1) - 1);
  const maxColumns = Math.max(1, Math.floor((screen.width + BROWSER_LAYOUT.gap) / (BROWSER_LAYOUT.minWidth + BROWSER_LAYOUT.gap)));
  const columns = Math.min(count, maxColumns);
  const rows = Math.ceil(count / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  const width = Math.min(
    BROWSER_LAYOUT.targetWidth,
    Math.floor((screen.width - BROWSER_LAYOUT.gap * (columns - 1)) / columns)
  );
  const height = Math.min(
    BROWSER_LAYOUT.targetHeight,
    Math.floor((screen.height - BROWSER_LAYOUT.gap * (rows - 1)) / rows)
  );

  return {
    x: column * (width + BROWSER_LAYOUT.gap),
    y: row * (height + BROWSER_LAYOUT.gap),
    width,
    height,
    viewportWidth: Math.max(240, width),
    viewportHeight: Math.max(300, height - 80)
  };
}

async function rentPhoneNumber() {
    const url = `https://api.viotp.com/request/getv2?token=${VIOTP_API_TOKEN}&serviceId=${VIOTP_SERVICE_ID}&network=VINAPHONE`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status_code === 200 && json.success) {
        return {
            phoneNumber: json.data.phone_number,
            requestId: json.data.request_id
        };
    }
    throw new Error("Không thể thuê số: " + json.message);
}

async function waitForSmsCode(requestId) {
    console.log(`[WAIT] Đang chờ mã OTP SMS (Timeout: 4 phút)...`);
    const url = `https://api.viotp.com/session/getv2?requestId=${requestId}&token=${VIOTP_API_TOKEN}`;
    for (let i = 0; i < 80; i++) {
        await new Promise(res => setTimeout(res, 3000));
        try {
            const res = await fetch(url);
            const json = await res.json();
            if (json.status_code === 200 && json.data) {
                if (json.data.Status === 1) return json.data.Code;
                if (json.data.Status === 2) throw new Error("Hết hạn thuê số");
            }
        } catch (e) { }
    }
    throw new Error("Hết thời gian chờ mã OTP SMS.");
}

// ==========================================
// CẤU HÌNH OAUTH CỦA OPENAI (Dựa trên 9router)
// ==========================================
const CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scope: "openid profile email offline_access",
  port: 1455,
  get redirectUri() {
    return `http://localhost:${this.port}/auth/callback`;
  }
};

// ==========================================
// HÀM HỖ TRỢ PKCE (Tạo chuỗi bảo mật)
// ==========================================
function base64URLEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generatePKCE() {
  const verifier = base64URLEncode(crypto.randomBytes(32));
  const challenge = base64URLEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ==========================================
// HÀM PARSE VÀ FORMAT TOKEN DATA
// ==========================================
function decodeJwtPayload(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

function formatProfileData(tokens, priority = 1) {
  const decodedIdToken = decodeJwtPayload(tokens.id_token || tokens.access_token);
  const email = decodedIdToken?.email || decodedIdToken?.["https://api.openai.com/profile"]?.email || "";
  const authData = decodedIdToken?.["https://api.openai.com/auth"] || {};
  
  const now = new Date();
  const expiresIn = tokens.expires_in || 863999;
  const expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();
  
  return {
      "id": crypto.randomUUID(), 
      "provider": "codex",
      "authType": "oauth",
      "name": email,
      "priority": priority,
      "isActive": true,
      "createdAt": now.toISOString(),
      "updatedAt": now.toISOString(),
      "email": email,
      "accessToken": tokens.access_token,
      "refreshToken": tokens.refresh_token,
      "expiresAt": expiresAt,
      "testStatus": "active",
      "expiresIn": expiresIn,
      "providerSpecificData": {
        "chatgptAccountId": authData.chatgpt_account_id || "",
        "chatgptPlanType": authData.chatgpt_plan_type || ""
      },
      "lastUsedAt": null,
      "consecutiveUseCount": 0,
      "lastError": null,
      "lastErrorAt": null,
      "errorCode": null,
      "backoffLevel": 0
  };
}

function get9RouterDbPath() {
  return process.env.NINE_ROUTER_DB_PATH || path.join(os.homedir(), ".9router", "db", "data.sqlite");
}

function loadBetterSqlite3() {
  try {
    return require("better-sqlite3");
  } catch (e) {
    const runtimeModule = path.join(os.homedir(), ".9router", "runtime", "node_modules", "better-sqlite3");
    if (fs.existsSync(runtimeModule)) {
      return require(runtimeModule);
    }
    return null;
  }
}

function get9RouterMaxPriority(dbPath = get9RouterDbPath()) {
  if (!fs.existsSync(dbPath)) return 0;

  const Database = loadBetterSqlite3();
  if (!Database) return 0;

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT MAX(priority) AS maxPriority FROM providerConnections WHERE provider = ?").get("codex");
    return row?.maxPriority || 0;
  } catch (error) {
    console.warn(`[WARN] Không thể đọc priority từ 9router DB: ${error.message}`);
    return 0;
  } finally {
    if (db) db.close();
  }
}

function to9RouterConnectionData(profileData) {
  const {
    accessToken,
    refreshToken,
    expiresAt,
    testStatus,
    expiresIn,
    providerSpecificData,
    lastUsedAt,
    consecutiveUseCount,
    lastError,
    lastErrorAt,
    errorCode,
    backoffLevel
  } = profileData;

  return {
    accessToken,
    refreshToken,
    expiresAt,
    testStatus,
    expiresIn,
    providerSpecificData,
    lastUsedAt,
    consecutiveUseCount,
    lastError,
    lastErrorAt,
    errorCode,
    backoffLevel
  };
}

function saveProfileTo9RouterDb(profileData, dbPath = get9RouterDbPath()) {
  if (!fs.existsSync(dbPath)) {
    console.warn(`[WARN] Không tìm thấy 9router DB tại ${dbPath}. Bỏ qua lưu vào 9router.`);
    return false;
  }

  const Database = loadBetterSqlite3();
  if (!Database) {
    console.warn("[WARN] Không tìm thấy better-sqlite3. Bỏ qua lưu vào 9router.");
    return false;
  }

  let db;
  try {
    db = new Database(dbPath);
    db.pragma("busy_timeout = 5000");
    db.prepare(`
      INSERT INTO providerConnections (
        id,
        provider,
        authType,
        name,
        email,
        priority,
        isActive,
        data,
        createdAt,
        updatedAt
      ) VALUES (
        @id,
        @provider,
        @authType,
        @name,
        @email,
        @priority,
        @isActive,
        @data,
        @createdAt,
        @updatedAt
      )
    `).run({
      id: profileData.id,
      provider: profileData.provider,
      authType: profileData.authType,
      name: profileData.name,
      email: profileData.email,
      priority: profileData.priority,
      isActive: profileData.isActive ? 1 : 0,
      data: JSON.stringify(to9RouterConnectionData(profileData)),
      createdAt: profileData.createdAt,
      updatedAt: profileData.updatedAt
    });
    return true;
  } catch (error) {
    console.warn(`[WARN] Không thể lưu token vào 9router DB: ${error.message}`);
    return false;
  } finally {
    if (db) db.close();
  }
}

async function exchangeCodeForTokens(code, verifier) {
  const tokenResponse = await fetch(CONFIG.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CONFIG.clientId,
      code,
      redirect_uri: CONFIG.redirectUri,
      code_verifier: verifier
    })
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    throw new Error(`Lỗi đổi token: ${errText}`);
  }

  return tokenResponse.json();
}

function saveTokens(tokens) {
  const fileName = 'openai_tokens_manual.json';
  let existingData = [];
  if (fs.existsSync(fileName)) {
    try {
      const fileContent = fs.readFileSync(fileName, 'utf8');
      const parsed = JSON.parse(fileContent);
      existingData = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      existingData = [];
    }
  }

  const maxPriority = Math.max(
    existingData.reduce((max, item) => Math.max(max, item.priority || 0), 0),
    get9RouterMaxPriority()
  );
  const formattedData = formatProfileData(tokens, maxPriority + 1);

  existingData.push(formattedData);

  console.log("\n[SYSTEM] HOÀN TẤT! Dưới đây là thông tin Token của bạn:\n");
  console.log(JSON.stringify(formattedData, null, 2));

  fs.writeFileSync(fileName, JSON.stringify(existingData, null, 2));
  console.log(`\n[SUCCESS] Token đã được lưu (Tổng tài khoản: ${existingData.length}) vào file ${fileName}`);

  if (saveProfileTo9RouterDb(formattedData)) {
    console.log("[SUCCESS] Token đã được thêm vào 9router DB (~/.9router/db/data.sqlite)");
  }

  return formattedData;
}

// ==========================================
// GLOBAL OAUTH SERVER (HỖ TRỢ ĐA LUỒNG)
// ==========================================
const pendingCallbacks = new Map();
const oauthApp = express();
let globalServerStarted = false;

oauthApp.get('/auth/callback', (req, res) => {
    const { code, state, error } = req.query;
    if (pendingCallbacks.has(state)) {
        const { resolve, reject } = pendingCallbacks.get(state);
        pendingCallbacks.delete(state);
        
        if (error) {
            res.send(`<h1>Lỗi đăng nhập!</h1><p>${error}</p>`);
            return reject(new Error(error));
        }
        res.send(`<h1>Đăng nhập thành công!</h1><p>Vui lòng quay lại Terminal.</p><script>window.close();</script>`);
        resolve(code);
    } else {
        res.send(`<h1>Lỗi</h1><p>Phiên OAuth không tồn tại hoặc đã hết hạn.</p>`);
    }
});

async function startGlobalServer() {
    if (globalServerStarted) return;
    globalServerStarted = true;
    return new Promise(resolve => {
        const server = http.createServer(oauthApp);
        server.listen(CONFIG.port, () => {
            console.log(`[SYSTEM] Global OAuth Server đang chạy tại http://localhost:${CONFIG.port}`);
            resolve();
        });
    });
}

function startTryAgainWatcher(page, threadId, label = '') {
  let clicking = false;
  const prefix = label ? `[${label}] ` : '';
  const timer = setInterval(async () => {
    if (clicking || page.isClosed()) return;

    clicking = true;
    try {
      const tryAgainBtn = page.getByRole('button', { name: /try again/i });
      if (await tryAgainBtn.first().isVisible().catch(() => false)) {
        console.log(`[WARN] [Luồng ${threadId}] ${prefix}Thấy nút Try again, đang bấm lại...`);
        await tryAgainBtn.first().click();
      }
    } catch (e) {
    } finally {
      clicking = false;
    }
  }, 2500);

  return () => clearInterval(timer);
}

// ==========================================
// CHƯƠNG TRÌNH CHÍNH
// ==========================================
async function loginToOpenAI(threadId = 1, threadCount = 1, proxy = null) {
  console.log(`[SYSTEM] [Luồng ${threadId}] Bắt đầu quá trình đăng nhập OpenAI...`);

  // 1. Khởi tạo mã PKCE và State
  const pkce = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  // 2. Tạo đường dẫn Authorization URL
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: CONFIG.clientId,
    redirect_uri: CONFIG.redirectUri,
    scope: CONFIG.scope,
    state: state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    originator: "openai_native", 
  });
  
  const authUrl = `${CONFIG.authorizeUrl}?${authParams.toString()}`;

  // 3. Đăng ký Callback
  const codePromise = new Promise((resolve, reject) => {
      pendingCallbacks.set(state, { resolve, reject });
  });

  // 4. Mở trình duyệt bằng Playwright
  console.log(`[ACTION] [Luồng ${threadId}] Đang mở trình duyệt ẨN DANH...`);
  const windowLayout = getBrowserWindowLayout(threadId, threadCount);
  console.log(`[SYSTEM] [Luồng ${threadId}] Vị trí cửa sổ: ${windowLayout.width}x${windowLayout.height}+${windowLayout.x}+${windowLayout.y}`);
  const launchOptions = {
      headless: false,
      args: [
          '--incognito',
          `--window-size=${windowLayout.width},${windowLayout.height}`,
          `--window-position=${windowLayout.x},${windowLayout.y}`
      ]
  };
  const proxyServer = formatProxyServer(proxy);
  if (proxyServer) {
      launchOptions.proxy = {
          server: proxyServer,
          bypass: 'localhost,127.0.0.1'
      };
      console.log(`[SYSTEM] [Luồng ${threadId}] Đang dùng proxy: ${proxyServer}`);
  }
  const browser = await chromium.launch(launchOptions); 
  const context = await browser.newContext({
      viewport: { width: windowLayout.viewportWidth, height: windowLayout.viewportHeight }
  });
  const page = await context.newPage();
  const stopTryAgainWatcher = startTryAgainWatcher(page, threadId);
  
  try {
    try {
      await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      if (proxyServer && isProxyConnectionError(error)) {
        throw new Error(`Proxy lỗi khi mở OpenAI: ${error.message}`);
      }
      throw error;
    }

    if (proxyServer) {
      const chromeError = page.url().startsWith('chrome-error://') || await page.locator('text=/No internet|proxy server|address is incorrect/i').first().isVisible().catch(() => false);
      if (chromeError) {
        throw new Error('Proxy lỗi khi mở OpenAI: No internet / proxy server / address is incorrect');
      }
    }

    // --- PHẦN TỰ ĐỘNG HÓA THEO YÊU CẦU ---
    // Hàm tạo email ngẫu nhiên
    function generateRandomEmail() {
      const randomPart = crypto.randomBytes(8).toString('base64url').slice(0, 12).toLowerCase();
      return `${randomPart}@pixpress.art`;
    }

    // Hàm gọi API lấy mã xác nhận
    async function waitForEmailCode(email) {
      console.log(`[WAIT] Đang chờ email chứa mã xác nhận gửi tới ${email}...`);
      const inboxUrl = `https://temp-mail.starkduong.workers.dev/inbox?email=${email}`;
      
      for (let i = 0; i < 30; i++) { // Thử tối đa 30 lần (90 giây)
        await new Promise(res => setTimeout(res, 3000)); // Delay 3 giây mỗi vòng
        try {
          const res = await fetch(inboxUrl);
          const inbox = await res.json();
          if (inbox && inbox.length > 0) {
            // Lấy id của thư trên cùng
            const topMailId = inbox[0].id;
            
            // Gọi API lấy nội dung chi tiết của mail
            const messageUrl = `https://temp-mail.starkduong.workers.dev/message?email=${email}&id=${topMailId}`;
            const msgRes = await fetch(messageUrl);
            const mailDetail = await msgRes.json();

            if (mailDetail && mailDetail.body) {
              // Dùng Regex tìm 6 chữ số liên tiếp
              const match = mailDetail.body.match(/\b(\d{6})\b/);
              if (match) {
                console.log(`[SUCCESS] Đã lấy được mã xác nhận: ${match[1]}`);
                return match[1];
              }
            }
          }
        } catch (e) {
          // Bỏ qua lỗi fetch và thử lại
        }
      }
      throw new Error("Không nhận được mã xác nhận sau 90 giây.");
    }

    console.log(`[ACTION] [Luồng ${threadId}] Đang bấm vào link đăng ký...`);
    const emailInputSelector = 'input[name="email"], input[type="email"]';
    const signUpSelector = [
      'a:has-text("Sign up")',
      'a:has-text("Create account")',
      'a:has-text("Đăng ký")',
      'a[href*="signup"]',
      'a[href*="register"]'
    ].join(', ');
    const signUpLink = page.locator(signUpSelector).first();
    if (await signUpLink.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) {
      await signUpLink.click();
    } else {
      await page.waitForSelector(emailInputSelector, { timeout: 5000 });
    }

    console.log("� Đang tạo email ngẫu nhiên...");
    const randomEmail = generateRandomEmail();
    console.log(`[INFO] => Email mới: ${randomEmail}`);

    console.log("[ACTION] Đang điền Email và ấn Enter...");
    await page.waitForSelector(emailInputSelector, { timeout: 15000 });
    // Chờ một chút để ô input sẵn sàng
    await page.waitForTimeout(500);
    await page.fill(emailInputSelector, randomEmail);
    await page.press(emailInputSelector, 'Enter');

    // Hàm tạo password ngẫu nhiên (ít nhất 12 ký tự)
    function generateRandomPassword() {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
      let pass = '';
      for (let i = 0; i < 14; i++) {
        pass += chars[Math.floor(Math.random() * chars.length)];
      }
      return pass + 'A1!'; // Đảm bảo luôn có chữ hoa, số và ký tự đặc biệt
    }

    console.log("[PROCESS] Đang tạo mật khẩu ngẫu nhiên...");
    const randomPassword = generateRandomPassword();
    console.log(`[INFO] => Mật khẩu mới: ${randomPassword}`);

    console.log("[WAIT] Đang chờ ô nhập Mật khẩu...");
    // Selector của ô nhập mật khẩu. Dùng type="password" vì ID react-aria là ID tự động thay đổi
    const passwordSelector = 'input[type="password"], input[name="password"]';
    await page.waitForSelector(passwordSelector, { timeout: 15000 });
    await page.waitForTimeout(1000); // Chờ animation chuyển cảnh
    await page.fill(passwordSelector, randomPassword);
    await page.press(passwordSelector, 'Enter');

    console.log("[PROCESS] Đang lưu tài khoản và mật khẩu vào file accounts.json...");
    const accountsFile = 'accounts.json';
    let accountsList = [];
    if (fs.existsSync(accountsFile)) {
      try {
        accountsList = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
        if (!Array.isArray(accountsList)) accountsList = [accountsList];
      } catch (e) {
        accountsList = [];
      }
    }
    accountsList.push({
      email: randomEmail,
      password: randomPassword,
      createdAt: new Date().toISOString()
    });
    fs.writeFileSync(accountsFile, JSON.stringify(accountsList, null, 2));
    console.log("[SUCCESS] Đã lưu xong vào accounts.json!");

    // Chờ và lấy mã OTP từ API mail
    const verificationCode = await waitForEmailCode(randomEmail);

    console.log("[ACTION] Đang tự động điền mã xác nhận...");
    // Ô OTP thường là các ô input có type="text" hoặc inputmode="numeric".
    // Playwright sẽ tự động phân phát chuỗi 6 ký tự vào các ô nếu focus vào ô đầu tiên.
    const otpSelector = 'input[inputmode="numeric"], input[name="code"]';
    await page.waitForSelector(otpSelector, { timeout: 15000 });
    await page.waitForTimeout(1000);
    await runWithOtpEntryDelay(threadId, 'Email', async () => {
      await page.fill(otpSelector, verificationCode);
      await page.press(otpSelector, 'Enter');
    });

    console.log("[SUCCESS] Đã điền xong mã xác nhận Email. Đang chờ chuyển sang bước nhập SĐT...");
    
    // ==========================================
    // BƯỚC XÁC MINH SỐ ĐIỆN THOẠI (ViOTP)
    // ==========================================
    
    // --- VÒNG LẶP LẤY SỐ & CHỜ SMS ---
    let smsCode = null;
    let maxRetries = 1; // Không đổi số khác: lỗi SMS thì bỏ tài khoản này
    const phoneInputSelector = '.PhoneInputInput input, input[type="tel"]';

    async function waitForPhoneInput(timeout = 15000) {
        await page.locator(phoneInputSelector).first().waitFor({ state: 'visible', timeout });
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`\n[RETRY] [Lần ${attempt}] Đang xử lý màn hình nhập số điện thoại...`);
        
        await waitForPhoneInput(15000);
        
        // 0. Xóa số cũ (nếu có) TRƯỚC KHI chọn quốc gia
        // Nếu không xóa, lúc chọn VN xong nó sẽ tự nhảy lại +1 (do nhận diện số Mỹ cũ)
        await page.fill(phoneInputSelector, '');
        await page.waitForTimeout(200);

        // 1. Luôn luôn chọn lại quốc gia Việt Nam (phòng trường hợp form bị reset khi quay lại)
        const countryDropdownButton = 'button[aria-haspopup="listbox"]';
        console.log("[ACTION] Đang chọn quốc gia Việt Nam...");
        await page.waitForSelector(countryDropdownButton, { timeout: 20000 });
        await page.click(countryDropdownButton);
        await page.waitForTimeout(500);
        
        await page.keyboard.press('v');
        await page.waitForTimeout(500);
        for (let i = 0; i < 20; i++) {
            const vietnamOption = page.getByRole('option', { name: /Vietnam/i });
            if (await vietnamOption.isVisible()) {
                await vietnamOption.click();
                break;
            }
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(100);
        }
        await page.waitForTimeout(500);
        
        // 2. Lấy số điện thoại từ ViOTP
        const phoneData = await rentPhoneNumber();
        console.log(`[INFO] => Đã thuê được số: ${phoneData.phoneNumber}`);

        // 3. Điền số điện thoại
        await page.fill(phoneInputSelector, phoneData.phoneNumber);
        
        // Tạo "bẫy" để bắt luồng API xem OpenAI có chê số này không
        const responsePromise = page.waitForResponse(
          response => response.url().includes('add-phone/send') && response.request().method() === 'POST',
          { timeout: 15000 }
        ).catch(() => null);

        // Bấm gửi số
        await page.press(phoneInputSelector, 'Enter');
        
        // Chờ kết quả từ API của OpenAI
        const response = await responsePromise;
        if (response && response.status() === 400) {
            throw new Error("OpenAI từ chối số này (Lỗi 400). Bỏ tài khoản này.");
        }

        // Nếu API trả về thành công (thường là 200), tiến hành chờ OTP
        try {
            smsCode = await waitForSmsCode(phoneData.requestId);
            console.log(`[SUCCESS] Đã lấy được mã SMS: ${smsCode}`);
            break; // Lấy thành công thì thoát vòng lặp
        } catch (e) {
            throw new Error(`Lỗi chờ OTP SMS: ${e.message}. Bỏ tài khoản này.`);
        }
    }

    if (!smsCode) {
        throw new Error("Không lấy được mã SMS. Bỏ tài khoản này.");
    }

    // Điền mã OTP SMS vào web
    console.log("[ACTION] Đang điền mã SMS OTP...");
    // Tránh việc nhầm với ô OTP email lúc nãy bằng cách lấy ô nhập mã cuối cùng xuất hiện trên trang
    const smsOtpInputs = await page.locator('input[inputmode="numeric"]');
    await smsOtpInputs.last().waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1000);
    await runWithOtpEntryDelay(threadId, 'SMS', async () => {
      await smsOtpInputs.last().fill(smsCode);
      await smsOtpInputs.last().press('Enter');
    });

    console.log("[SUCCESS] Đã điền xong mã SMS! Trình duyệt đang chờ hoàn tất quá trình tạo tài khoản...");
    let code;
    
    // ==========================================
    // BƯỚC HOÀN TẤT PROFILE (Tên & Ngày Sinh)
    // ==========================================
    console.log("[WAIT] Đang chờ trang điền thông tin cá nhân (Tên & Tuổi)...");
    
    // Chờ cho form nhập tên xuất hiện
    await page.waitForSelector('input[type="text"]', { timeout: 20000 });
    
    // 1. Nhập Tên random
    const firstNames = ["John", "David", "Michael", "Chris", "Sarah", "Anna", "Emily", "James", "Robert", "Linda"];
    const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis"];
    const randomName = firstNames[Math.floor(Math.random() * firstNames.length)] + " " + lastNames[Math.floor(Math.random() * lastNames.length)];
    
    console.log(` Đang điền tên: ${randomName}`);
    const nameInput = page.locator('input[type="text"]');
    await nameInput.first().fill(randomName);

    // 2. Nhập Tuổi random (18 - 60 tuổi)
    const randomAge = Math.floor(Math.random() * (60 - 18 + 1)) + 18;
    console.log(` Đang điền số tuổi: ${randomAge}...`);
    
    // Sử dụng selector input có name="age" hoặc type="number" như trong ảnh bạn cung cấp
    const ageInput = page.locator('input[name="age"], input[type="number"]');
    const hasAgeInput = await ageInput.first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (hasAgeInput) {
        await ageInput.first().fill(randomAge.toString());
        
        // Nhấn Enter để gửi form
        await ageInput.first().press('Enter');
    } else {
        console.log(`[WAIT] [Luồng ${threadId}] Không thấy ô tuổi sau 5s. Vui lòng thao tác thủ công trên trình duyệt đang mở...`);
        console.log(`[WAIT] [Luồng ${threadId}] Script sẽ chờ đến khi nhận Authorization Code.`);
        code = await codePromise;
    }

    if (!code) {
        console.log(`[ACTION] [Luồng ${threadId}] Đang xử lý các màn hình Onboarding cuối cùng...`);
        
        // Vòng lặp xử lý Onboarding & Bẫy lỗi Duplicate Auth
        async function handleOnboarding() {
            for (let i = 0; i < 20; i++) { // Thử tối đa 20 vòng (khoảng 40 giây)
                try {
                    // 1. Nếu có lỗi Duplicate Auth, ưu tiên bấm Try again trước
                    const tryAgainBtn = page.getByRole('button', { name: /try again/i });
                    if (await tryAgainBtn.isVisible()) {
                        console.log(`[WARN] [Luồng ${threadId}] Gặp lỗi Duplicate Auth, đang bấm Try again...`);
                        await tryAgainBtn.click();
                        await page.waitForTimeout(3000);
                        continue; 
                    }

                    // 2. Bấm nút Continue (Xác nhận) liên tục nếu nó xuất hiện
                    const confirmBtn = page.locator('div[class*="_ctas_"] button');
                    if (await confirmBtn.last().isVisible()) {
                        console.log(`[ACTION] [Luồng ${threadId}] Đang bấm nút Xác nhận (Continue)...`);
                        await confirmBtn.last().click();
                        await page.waitForTimeout(2000);
                        continue;
                    }
                } catch (e) {}
                
                await page.waitForTimeout(1500);
            }
            console.log(`[WAIT] [Luồng ${threadId}] Onboarding chưa xong sau 40s. Vui lòng thao tác thủ công trên trình duyệt đang mở...`);
            console.log(`[WAIT] [Luồng ${threadId}] Script sẽ chờ đến khi nhận Authorization Code.`);
            return codePromise;
        }

        // Chạy song song: vừa rình bấm nút (Continue hoặc Try again), vừa chờ nhận Auth Code
        code = await Promise.race([
            codePromise,
            handleOnboarding()
        ]);
    }

    console.log(`[SUCCESS] [Luồng ${threadId}] HOÀN TẤT ĐĂNG KÝ PROFILE! Đã nhận Authorization Code.`);

  // ------------------------------------
  // ĐỔI TOKEN
  // ------------------------------------

    // 6. Đóng trình duyệt
    await browser.close();

    // 7. Gọi API đổi Code lấy Token và lưu
    const tokens = await exchangeCodeForTokens(code, pkce.verifier);
    saveTokens(tokens);

  } catch (error) {
    console.error("[FATAL] Xảy ra lỗi:", error.message);
    await browser.close();
    throw error; // Ném lỗi ra ngoài để vòng lặp biết
  } finally {
    stopTryAgainWatcher();
  }
}

async function manualLoginToOpenAI() {
  await startGlobalServer();
  console.log("[SYSTEM] Bắt đầu đăng nhập thủ công OpenAI...");

  const pkce = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: CONFIG.clientId,
    redirect_uri: CONFIG.redirectUri,
    scope: CONFIG.scope,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    originator: "openai_native",
  });
  const authUrl = `${CONFIG.authorizeUrl}?${authParams.toString()}`;

  const codePromise = new Promise((resolve, reject) => {
    pendingCallbacks.set(state, { resolve, reject });
  });

  console.log("[ACTION] Đang mở cửa sổ đăng nhập thủ công...");
  const browser = await chromium.launch({
    headless: false,
    args: ['--incognito', '--window-size=500,850']
  });

  try {
    const context = await browser.newContext({ viewport: { width: 500, height: 770 } });
    const page = await context.newPage();
    await page.goto(authUrl);

    console.log("[WAIT] Vui lòng tự đăng nhập trong cửa sổ vừa mở...");
    const code = await codePromise;
    console.log("[SUCCESS] Đã nhận Authorization Code từ đăng nhập thủ công.");

    await browser.close();
    const tokens = await exchangeCodeForTokens(code, pkce.verifier);
    saveTokens(tokens);
  } catch (error) {
    console.error("[FATAL] Xảy ra lỗi đăng nhập thủ công:", error.message);
    await browser.close();
    throw error;
  }
}

// Hàm chạy vòng lặp tạo nhiều tài khoản (Hỗ trợ Đa luồng)
async function runAutomation() {
    await startGlobalServer();
    
    const total = UI_CONFIG.accountCount || 1;
    const THREAD_COUNT = 2;
    const NEXT_ACCOUNT_DELAY_MS = 30000;
    const concurrentCount = Math.min(THREAD_COUNT, total);
    const proxyKeys = getNestProxyKeys();
    let nextTaskIndex = 1;
    
    console.log(`\n======================================================`);
    console.log(`[SYSTEM] BẮT ĐẦU CHẠY ${concurrentCount} LUỒNG - TỔNG: ${total} TÀI KHOẢN`);
    console.log(`[SYSTEM] Luồng nào xong sẽ nghỉ ${NEXT_ACCOUNT_DELAY_MS / 1000}s rồi mở tài khoản tiếp theo`);
    if (proxyKeys.length > 0) {
        console.log(`[SYSTEM] NestProxy bật: ${proxyKeys.length} proxy_key`);
        if (proxyKeys.length < THREAD_COUNT && total > 1) {
            console.log(`[WARN] Chỉ có ${proxyKeys.length} proxy_key. Hai luồng có thể dùng chung proxy.`);
        }
    }
    console.log(`======================================================\n`);
    
    function getNextTaskIndex() {
        if (nextTaskIndex > total) return null;
        const taskIndex = nextTaskIndex;
        nextTaskIndex += 1;
        return taskIndex;
    }

    const workers = [];
    for (let i = 0; i < concurrentCount; i++) {
        const threadId = i + 1;
        workers.push((async () => {
            if (threadId > 1) {
                await new Promise(r => setTimeout(r, 2000 * (threadId - 1)));
            }

            let isFirstTask = true;
            while (true) {
                const taskIndex = getNextTaskIndex();
                if (!taskIndex) break;

                if (!isFirstTask) {
                    console.log(`[WAIT] [Luồng ${threadId}] Nghỉ ${NEXT_ACCOUNT_DELAY_MS / 1000}s trước khi mở tài khoản tiếp theo...`);
                    await new Promise(r => setTimeout(r, NEXT_ACCOUNT_DELAY_MS));
                }
                isFirstTask = false;

                console.log(`\n[SYSTEM] [Luồng ${threadId}] BẮT ĐẦU TẠO TÀI KHOẢN THỨ ${taskIndex} / ${total}`);
                const proxyKey = proxyKeys.length > 0 ? proxyKeys[(taskIndex - 1) % proxyKeys.length] : null;

                const maxProxyRetries = proxyKey ? 3 : 1;
                for (let attempt = 1; attempt <= maxProxyRetries; attempt++) {
                    try {
                        const proxy = await rotateNestProxy(proxyKey, threadId, taskIndex);
                        await loginToOpenAI(threadId, concurrentCount, proxy);
                        console.log(`\n[SUCCESS] [Luồng ${threadId}] Thành công tài khoản thứ ${taskIndex}!`);
                        break;
                    } catch (e) {
                        const canRetryProxy = proxyKey && isProxyConnectionError(e) && attempt < maxProxyRetries;
                        if (canRetryProxy) {
                            console.log(`[WARN] [Luồng ${threadId}] Proxy lỗi ở tài khoản ${taskIndex} (lần ${attempt}/${maxProxyRetries}): ${e.message}`);
                            console.log(`[ACTION] [Luồng ${threadId}] Reset proxy, chờ 5s rồi thử lại tài khoản này...`);
                            await new Promise(r => setTimeout(r, 5000));
                            continue;
                        }

                        console.error(`\n[ERROR] [Luồng ${threadId}] Lỗi tài khoản ${taskIndex}:`, e.message);
                        console.log(`[WARN] [Luồng ${threadId}] Bỏ qua tài khoản lỗi.`);
                        break;
                    } finally {
                        await resetNestProxy(proxyKey, threadId, taskIndex);
                    }
                }
            }
        })());
    }

    await Promise.all(workers);
    
    console.log(`\n[SYSTEM] ĐÃ HOÀN TẤT ${total} TÀI KHOẢN!`);
    process.exit(0);
}

if (require.main === module) {
    if (IS_MANUAL_MODE) {
        manualLoginToOpenAI().then(() => process.exit(0)).catch(() => process.exit(1));
    } else {
        runAutomation();
    }
}

module.exports = {
  formatProfileData,
  get9RouterMaxPriority,
  manualLoginToOpenAI,
  saveTokens,
  saveProfileTo9RouterDb,
  to9RouterConnectionData
};
