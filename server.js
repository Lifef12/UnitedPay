const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const app = express();
app.set('trust proxy', 1);

// async route errors must never leave a page hanging (Express 4 does not catch them by itself)
['get', 'post'].forEach(function (m) {
    const orig = app[m].bind(app);
    app[m] = function (path) {
        const handlers = Array.prototype.slice.call(arguments, 1);
        if (!handlers.length) return orig(path);          // app.get('setting')
        return orig.apply(null, [path].concat(handlers.map(function (h) {
            if (typeof h !== 'function' || h.constructor.name !== 'AsyncFunction') return h;
            return function (req, res, next) {
                return h(req, res, next).catch(function (err) {
                    console.log('Route error', req.method, req.path, err);
                    if (res.headersSent) return;
                    if (req.path.indexOf('/api/') === 0 || req.method !== 'GET') {
                        res.status(500).json({ success: false, message: 'Server error. Please try again.' });
                    } else {
                        res.status(500).send('Server error. Please refresh in a few seconds.');
                    }
                });
            };
        })));
    };
});

// ================== SETTINGS ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "7482625921").trim();
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const VERCEL_APP_URL = process.env.VERCEL_APP_URL || "https://lite-core-0r7t.vercel.app/";

const MIN_WITHDRAW_TRX = 1;

if (!BOT_TOKEN) console.error('❌ BOT_TOKEN environment variable missing!');
if (!ADMIN_PASSWORD) console.error('❌ ADMIN_PASSWORD environment variable missing! Admin login disabled.');
if (!MONGO_URI) console.error('❌ MONGO_URI environment variable missing!');

// ================== HELPERS ==================
function esc(s) {
    return String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function validId(id) { return /^\d{1,20}$/.test(String(id || '')); }

// ================== SIMPLE USER ID (no Telegram signature check) ==================
// userId comes from the app (body / url). Website security is handled only in the frontend (Access Denied screen).
function requireTg(req, res, next) {
    const uid = String((req.body && req.body.userId) || (req.params && req.params.userId) || (req.query && req.query.userId) || '');
    if (!validId(uid)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    req.tgId = uid;
    const nm = req.body && req.body.username;
    req.tgName = nm && String(nm).length < 80 ? String(nm) : 'User';
    next();
}

// ================== MINING RULES ==================
const PLAN_DURATION_MS = 10 * 24 * 60 * 60 * 1000;
const PAID_RATE_PER_GHS_USD = 0.30;
const FREE_DAILY_USD = 0.01;

// ================== MULTI-COIN LIVE PRICES ==================
const STABLE = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD']);
const COIN_ALIASES = {
    TRON: 'TRX', LITECOIN: 'LTC', BITCOIN: 'BTC', ETHEREUM: 'ETH', DOGECOIN: 'DOGE',
    SOLANA: 'SOL', RIPPLE: 'XRP', TETHER: 'USDT', BINANCE: 'BNB', TONCOIN: 'TON', GRAM: 'TON',
    CARDANO: 'ADA', POLKADOT: 'DOT', AVALANCHE: 'AVAX', CHAINLINK: 'LINK', STELLAR: 'XLM'
};
const NETWORK_TOKENS = new Set(['BEP', 'TRC', 'ERC', 'BSC', 'POLYGON']);
const COINGECKO_IDS = {
    TRX: 'tron', LTC: 'litecoin', BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin',
    DOGE: 'dogecoin', SOL: 'solana', XRP: 'ripple', TON: 'the-open-network',
    MATIC: 'matic-network', ADA: 'cardano', DOT: 'polkadot', BCH: 'bitcoin-cash',
    AVAX: 'avalanche-2', LINK: 'chainlink', SHIB: 'shiba-inu', XLM: 'stellar',
    ATOM: 'cosmos', NEAR: 'near', APT: 'aptos', PEPE: 'pepe'
};

// "TRX (TRC-20)" -> TRX, "LTC (Litecoin)" -> LTC, "USDT (BEP-20)" / "BEP-20" -> USDT
function parseCoinSymbol(coin) {
    const s = String(coin || '').toUpperCase().trim();
    const tokens = s.match(/[A-Z0-9]+/g) || [];
    const isKnown = t => STABLE.has(t) || !!COINGECKO_IDS[t];
    // checks every word: "Solana (SOL)" -> SOL, "LTC (Litecoin)" -> LTC, "USDT (BEP-20)" -> USDT
    for (const t of tokens) {
        if (NETWORK_TOKENS.has(t)) continue;
        const a = COIN_ALIASES[t] || t;
        if (isKnown(a)) return a;
    }
    if (tokens.length && NETWORK_TOKENS.has(tokens[0])) return 'USDT';
    const first = tokens[0] || 'TRX';
    return COIN_ALIASES[first] || first;
}

function coinDecimals(sym) {
    if (STABLE.has(sym)) return 2;
    if (sym === 'BTC' || sym === 'ETH' || sym === 'BCH' || sym === 'BNB') return 8;
    return 6;
}
function roundCoin(n, sym) { return Number(Number(n).toFixed(coinDecimals(sym))); }
function fmtCoin(n, sym) {
    let s = Number(n).toFixed(coinDecimals(sym));
    if (s.includes('.')) {
        s = s.replace(/0+$/, '');
        const parts = s.split('.');
        s = parts[0] + '.' + (parts[1] || '').padEnd(2, '0');
    }
    return s;
}

const priceCache = {};
const priceInflight = {};
const PRICE_FRESH_MS = 20 * 1000;          // reuse a price for 20 seconds
const PRICE_STALE_MS = 15 * 60 * 1000;     // if every source is down, last good price is OK for 15 minutes

async function getJson(url) {
    const r = await fetch(url, {
        signal: AbortSignal.timeout(4500),
        headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; TronRichBot/1.0)' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
}

// Many independent sources: some exchanges block certain hosting regions (e.g. Binance on US servers),
// so we ask all of them at once and use the median of whatever answers.
const PRICE_SOURCES = [
    { name: 'binance',        get: async s => parseFloat((await getJson(`https://api.binance.com/api/v3/ticker/price?symbol=${s}USDT`)).price) },
    { name: 'binance-vision', get: async s => parseFloat((await getJson(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${s}USDT`)).price) },
    { name: 'coinbase',       get: async s => parseFloat((await getJson(`https://api.coinbase.com/v2/prices/${s}-USD/spot`)).data.amount) },
    { name: 'kraken',         get: async s => {
        const pair = (s === 'BTC' ? 'XBT' : s) + 'USD';
        const d = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
        const k = Object.keys(d.result || {})[0];
        return parseFloat(d.result[k].c[0]);
    } },
    { name: 'okx',            get: async s => parseFloat((await getJson(`https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT`)).data[0].last) },
    { name: 'bybit',          get: async s => parseFloat((await getJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${s}USDT`)).result.list[0].lastPrice) },
    { name: 'kucoin',         get: async s => parseFloat((await getJson(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${s}-USDT`)).data.price) },
    { name: 'cryptocompare',  get: async s => Number((await getJson(`https://min-api.cryptocompare.com/data/price?fsym=${s}&tsyms=USD`)).USD) },
    { name: 'coingecko',      get: async s => {
        const id = COINGECKO_IDS[s];
        if (!id) throw new Error('no coingecko id');
        const d = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
        return Number(d[id].usd);
    } }
];

function medianOf(arr) {
    const s = [...arr].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function fetchAllPrices(sym) {
    const settled = await Promise.allSettled(PRICE_SOURCES.map(async src => {
        const p = await src.get(sym);
        if (!(p > 0)) throw new Error('bad price');
        return { name: src.name, price: p };
    }));
    const ok = [];
    const failed = {};
    settled.forEach((r, i) => {
        if (r.status === 'fulfilled') ok.push(r.value);
        else failed[PRICE_SOURCES[i].name] = String((r.reason && r.reason.message) || r.reason);
    });
    let price = 0;
    if (ok.length) {
        const m0 = medianOf(ok.map(o => o.price));
        const near = ok.filter(o => Math.abs(o.price - m0) / m0 <= 0.03);   // drop outliers
        price = medianOf((near.length ? near : ok).map(o => o.price));
    }
    return { price, ok, failed };
}

async function getCoinPriceUsd(sym) {
    sym = String(sym || '').toUpperCase();
    if (STABLE.has(sym)) return 1;

    const cached = priceCache[sym];
    if (cached && Date.now() - cached.time < PRICE_FRESH_MS) return cached.price;

    if (!priceInflight[sym]) {
        priceInflight[sym] = (async () => {
            try {
                const { price, ok } = await fetchAllPrices(sym);
                if (price > 0) {
                    priceCache[sym] = { price, time: Date.now(), sources: ok.length };
                    return price;
                }
            } catch (e) { console.log('price fetch error', sym, e.message); }
            return 0;
        })().finally(() => { delete priceInflight[sym]; });
    }
    const fresh = await priceInflight[sym];
    if (fresh > 0) return fresh;

    if (cached && Date.now() - cached.time < PRICE_STALE_MS) return cached.price;
    if (sym === 'TRX') return 0.33;
    return 0;
}

async function getTrxPrice() {
    const p = await getCoinPriceUsd('TRX');
    return p > 0 ? p : 0.33;
}

function isPaidPlanActive(u, now = Date.now()) {
    return u.planActive !== false && Number(u.ghs) > 0 && !(u.planExpiryDate > 0 && now >= u.planExpiryDate);
}

function dailyUsdRate(u, now = Date.now()) {
    return isPaidPlanActive(u, now) ? Number(u.ghs) * PAID_RATE_PER_GHS_USD : FREE_DAILY_USD;
}

function accrueUsd(u, now = Date.now()) {
    const last = Number(u.lastClaimTime) || now;
    if (now <= last) return 0;
    let usd = 0;
    let cursor = last;
    if (u.planActive !== false && Number(u.ghs) > 0) {
        const paidEnd = (u.planExpiryDate > 0) ? Math.min(now, u.planExpiryDate) : now;
        if (paidEnd > cursor) {
            usd += ((paidEnd - cursor) / 1000) * (Number(u.ghs) * PAID_RATE_PER_GHS_USD / 86400);
            cursor = paidEnd;
        }
    }
    if (now > cursor) {
        usd += ((now - cursor) / 1000) * (FREE_DAILY_USD / 86400);
    }
    return usd;
}

function settleAccrual(u, now = Date.now()) {
    u.accruedUsd = Number(u.accruedUsd || 0) + accrueUsd(u, now);
    u.lastClaimTime = now;
}

function expireUserPlan(u, now = Date.now()) {
    settleAccrual(u, now);
    u.ghs = 0;
    u.planActive = false;
    u.planExpiryDate = 0;
    u.planStartDate = 0;
}

// ================== DATABASE ==================
mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ Connected to MongoDB Atlas Successfully!');

        const RESET_KEY = 'data_reset_v1';
        try {
            const metaCol = mongoose.connection.collection('meta');
            const alreadyReset = await metaCol.findOne({ _id: RESET_KEY });
            if (!alreadyReset) {
                await mongoose.model('User').deleteMany({});
                await mongoose.model('PendingRequest').deleteMany({});
                await metaCol.insertOne({ _id: RESET_KEY, at: Date.now() });
                console.log('🧹 ALL DATA RESET TO ZERO (one-time)!');
            }
        } catch (err) {
            console.log('Reset error:', err);
        }

        try {
            const currentTime = Date.now();
            const allUsers = await mongoose.model('User').find({});
            for (let u of allUsers) {
                if (u.planActive && u.ghs > 0 && (!u.planStartDate || u.planStartDate === 0)) {
                    if (u.deposits && Array.isArray(u.deposits)) {
                        const paidDep = u.deposits.find(d => d.status === 'PAID');
                        if (paidDep && paidDep.date) {
                            let parsedTime = Date.parse(paidDep.date);
                            if (!isNaN(parsedTime)) {
                                u.planStartDate = parsedTime;
                                u.planExpiryDate = parsedTime + PLAN_DURATION_MS;
                                await u.save();
                            }
                        }
                    }
                }

                if (u.planActive && u.planExpiryDate && u.planExpiryDate > 0 && currentTime >= u.planExpiryDate) {
                    expireUserPlan(u, currentTime);
                    await u.save();
                }
            }
            console.log('✅ All users plans & 10-day plan expiries auto-synced!');
        } catch (err) {
            console.log('Auto-sync error:', err);
        }
    })
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },
    ghs: { type: Number, default: 0 },
    lastClaimTime: { type: Number, default: Date.now },
    accruedUsd: { type: Number, default: 0 },
    deposits: { type: Array, default: [] },
    withdrawals: { type: Array, default: [] },
    isBanned: { type: Boolean, default: false },
    planActive: { type: Boolean, default: true },
    planStartDate: { type: Number, default: 0 },
    planExpiryDate: { type: Number, default: 0 },
    referredBy: { type: String, default: null },
    referrals: {
        level1: { type: Array, default: [] },
        level2: { type: Array, default: [] },
        level3: { type: Array, default: [] }
    },
    refEarnings: {
        level1: { type: Number, default: 0 },
        level2: { type: Number, default: 0 },
        level3: { type: Number, default: 0 }
    }
});
const User = mongoose.model('User', userSchema);

const pendingRequestSchema = new mongoose.Schema({
    reqId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    userId: { type: String, required: true },
    username: { type: String },
    amount: { type: String, required: true },      // display string in the user's chosen coin, e.g. "3.061200 TRX"
    usdtAmount: { type: Number, default: 1 },
    coin: { type: String },                        // e.g. "LTC (Litecoin)"
    coinSymbol: { type: String },                  // e.g. "LTC"
    coinAmount: { type: Number, default: 0 },      // exact amount in that coin
    trxAmount: { type: Number, default: 0 },       // withdraw: TRX deducted from balance (used for refunds)
    usdValue: { type: Number, default: 0 },
    price: { type: Number, default: 0 },           // live coin price (USD) at request time
    txHash: { type: String },
    address: { type: String },
    adminMsgId: { type: Number },
    status: { type: String, default: 'PENDING' }
});
const PendingRequest = mongoose.model('PendingRequest', pendingRequestSchema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        cookieHeader.split(';').forEach(cookie => {
            const parts = cookie.split('=');
            req.cookies[parts.shift().trim()] = decodeURIComponent(parts.join('='));
        });
    }
    next();
});

// the Mini App is hosted on another domain (Vercel), so CORS must allow it and its login header
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Tg-Init-Data');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Signed cookie sessions: still valid after the server sleeps/restarts (Render free plan restarts often)
const SESSION_SECRET = process.env.SESSION_SECRET || (String(BOT_TOKEN || '') + String(ADMIN_PASSWORD || '') + 'tr-session');
function signSession(exp) { return crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('hex'); }
function makeSession() { const exp = Date.now() + 24 * 60 * 60 * 1000; return exp + '.' + signSession(exp); }
function validSession(token) {
    try {
        if (!token) return false;
        const parts = String(token).split('.');
        if (parts.length !== 2) return false;
        const exp = Number(parts[0]);
        if (!(exp > Date.now())) return false;
        const a = Buffer.from(parts[1]);
        const b = Buffer.from(signSession(exp));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) { return false; }
}

const loginFails = {};
function loginBlocked(ip) { const f = loginFails[ip]; return !!(f && f.count >= 8 && Date.now() - f.last < 10 * 60 * 1000); }

function checkAdminAuth(req, res, next) {
    if (validSession(req.cookies.admin_session)) return next();
    if (req.method !== 'GET') return res.status(401).json({ success: false, message: "Session expired. Please login again." });
    return res.redirect('/admin/login');
}

// ================== TELEGRAM HELPERS (HTML mode - no more Markdown errors) ==================
function stripTags(t) { return String(t).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); }

async function tgCall(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return await r.json();
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
    try {
        let body = { chat_id: chatId, text: text, parse_mode: 'HTML' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        let data = await tgCall('sendMessage', body);
        if (!data.ok) {
            console.log('Telegram sendMessage failed:', data.description);
            // fallback: plain text, so admin/user always gets the message
            delete body.parse_mode;
            body.text = stripTags(text);
            data = await tgCall('sendMessage', body);
        }
        return data;
    } catch (e) {
        console.log("Telegram API Error:", e);
        return null;
    }
}

async function sendTelegramPhoto(chatId, photoUrl, caption = '', replyMarkup = null) {
    try {
        let body = { chat_id: chatId, photo: photoUrl, caption: caption, parse_mode: 'HTML' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        let data = await tgCall('sendPhoto', body);
        if (!data.ok) {
            console.log('Telegram sendPhoto failed:', data.description);
            delete body.parse_mode;
            body.caption = stripTags(caption);
            data = await tgCall('sendPhoto', body);
        }
        return data;
    } catch (e) {
        console.log("Telegram Photo Broadcast Error:", e);
        return null;
    }
}

async function editTelegramMessage(chatId, messageId, text, replyMarkup = null) {
    try {
        let body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        let data = await tgCall('editMessageText', body);
        if (!data.ok) {
            console.log('Telegram edit failed:', data.description);
            delete body.parse_mode;
            body.text = stripTags(text);
            data = await tgCall('editMessageText', body);
        }
        return data;
    } catch (e) {
        console.log("Telegram Edit Error:", e);
        return null;
    }
}

async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
    try {
        await tgCall('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text, show_alert: showAlert });
    } catch (e) {
        console.log("Callback Answer Error:", e);
    }
}

// ================== REQUEST TEXT (admin) ==================
function reqAmountLabel(r) {
    const a = String(r.amount || '');
    if (/[A-Za-z]/.test(a)) return a;
    return r.type === 'withdraw' ? `${a} TRX` : a;
}

function adminRequestText(r, statusLine) {
    const uname = r.username ? ` (${esc(r.username)})` : '';
    let t;
    if (r.type === 'deposit') {
        t = `📥 <b>Deposit Request</b>\n\n` +
            `👤 User: <code>${esc(r.userId)}</code>${uname}\n` +
            `🪙 Coin: <b>${esc(r.coin || r.coinSymbol || 'TRX')}</b>\n` +
            `💰 Amount: <b>${esc(reqAmountLabel(r))}</b>\n` +
            `💵 Worth: ≈ ${esc(r.usdtAmount)} USDT` +
            (r.price > 0 && r.coinSymbol && !STABLE.has(r.coinSymbol) ? `\n📈 Live Rate: 1 ${esc(r.coinSymbol)} = $${Number(r.price).toFixed(4)}` : '') +
            `\n🔑 TxHash: <code>${esc(r.txHash)}</code>`;
    } else {
        t = `📤 <b>Withdraw Request</b>\n\n` +
            `👤 User: <code>${esc(r.userId)}</code>${uname}\n` +
            `🪙 Coin: <b>${esc(r.coin || r.coinSymbol || 'TRX')}</b>\n` +
            `💰 Pay Amount: <b>${esc(reqAmountLabel(r))}</b>\n` +
            `💵 Value: <b>$${Number(r.usdValue || 0).toFixed(2)}</b> (deducted ${Number(r.trxAmount || parseFloat(r.amount) || 0).toFixed(4)} TRX)` +
            (r.price > 0 && r.coinSymbol && !STABLE.has(r.coinSymbol) ? `\n📈 Live Rate: 1 ${esc(r.coinSymbol)} = $${Number(r.price).toFixed(4)}` : '') +
            `\n🏦 Address:\n<code>${esc(r.address)}</code>`;
    }
    if (statusLine) t += `\n\n${statusLine}`;
    return t;
}

function approveRejectKeyboard(reqId) {
    return {
        inline_keyboard: [[
            { text: "✅ Approve", callback_data: `approve_${reqId}` },
            { text: "❌ Reject", callback_data: `reject_${reqId}` }
        ]]
    };
}

async function sendRequestToAdmin(reqDoc) {
    if (!ADMIN_ID) return;
    const res = await sendTelegramMessage(ADMIN_ID, adminRequestText(reqDoc), approveRejectKeyboard(reqDoc.reqId));
    if (res && res.ok && res.result && res.result.message_id) {
        await PendingRequest.updateOne({ reqId: reqDoc.reqId }, { $set: { adminMsgId: res.result.message_id } });
    }
}

// ================== PLAN EXPIRY BACKGROUND JOB ==================
setInterval(async () => {
    try {
        const currentTime = Date.now();
        const expiredUsers = await User.find({
            planActive: true,
            planExpiryDate: { $gt: 0, $lte: currentTime }
        });

        for (let u of expiredUsers) {
            expireUserPlan(u, currentTime);
            await u.save();

            sendTelegramMessage(
                u.id,
                `❌ <b>Plan Expired:</b> Your mining plan has expired. Please renew your plan to keep earning 🚀`
            );
        }
    } catch (err) {
        console.log("Background Plan Expiry Error:", err);
    }
}, 5 * 60 * 1000);

function getPlanDaysFormat(user) {
    if (!user.planActive || user.ghs <= 0) {
        return "N/A";
    }

    let startTimestamp = user.planStartDate;
    if (!startTimestamp || startTimestamp === 0) {
        if (user.deposits && Array.isArray(user.deposits)) {
            const paidDep = user.deposits.find(d => d.status === 'PAID');
            if (paidDep && paidDep.date) {
                let parsedTime = Date.parse(paidDep.date);
                if (!isNaN(parsedTime)) {
                    startTimestamp = parsedTime;
                }
            }
        }
    }
    if (!startTimestamp || startTimestamp === 0) {
        startTimestamp = Date.now();
    }

    const now = Date.now();
    const elapsed = now - startTimestamp;
    let daysPassed = Math.floor(elapsed / (1000 * 60 * 60 * 24)) + 1;
    if (daysPassed > 10) daysPassed = 10;
    if (daysPassed < 1) daysPassed = 1;

    return `${daysPassed}/10 Days`;
}

function setRequestStatus(list, reqId, pendingNames, newStatus) {
    let idx = list.findIndex(x => String(x.id) === String(reqId));
    if (idx !== -1) {
        list[idx].status = newStatus;
    } else {
        let p = list.find(x => pendingNames.includes(x.status));
        if (p) p.status = newStatus;
    }
}

function reqTrx(reqDoc) {
    const t = Number(reqDoc.trxAmount);
    if (t > 0) return t;
    return parseFloat(reqDoc.amount) || 0;
}

async function payReferralCommissions(depositUser, usdtAmount) {
    const rates = [0.15, 0.03, 0.01];
    let current = depositUser;
    const trxPrice = await getTrxPrice();
    const depositingUserId = depositUser.id;
    const seenUsers = new Set([depositingUserId]);

    for (let lvl = 1; lvl <= 3; lvl++) {
        if (!current.referredBy) break;
        const refUser = await User.findOne({ id: current.referredBy });
        if (!refUser) break;
        if (seenUsers.has(refUser.id)) break;      // never pay a loop
        seenUsers.add(refUser.id);

        const commUsdt = usdtAmount * rates[lvl - 1];
        const commTrx = commUsdt / trxPrice;

        refUser.balance += commTrx;
        refUser.refEarnings[`level${lvl}`] = (refUser.refEarnings[`level${lvl}`] || 0) + commTrx;
        refUser.markModified('refEarnings');

        if (!refUser.referrals[`level${lvl}`]) {
            refUser.referrals[`level${lvl}`] = [];
        }

        let refList = refUser.referrals[`level${lvl}`];
        let existingRefIndex = refList.findIndex(r => (typeof r === 'string' ? r === depositingUserId : r.id === depositingUserId));

        if (existingRefIndex !== -1) {
            if (typeof refList[existingRefIndex] === 'string') {
                refList[existingRefIndex] = {
                    id: depositingUserId,
                    joinedDate: 'Active',
                    bonusEarned: commTrx
                };
            } else {
                refList[existingRefIndex].bonusEarned = (Number(refList[existingRefIndex].bonusEarned) || 0) + commTrx;
            }
        } else {
            refList.push({
                id: depositingUserId,
                joinedDate: 'Active',
                bonusEarned: commTrx
            });
        }
        refUser.markModified(`referrals.level${lvl}`);

        await refUser.save();

        sendTelegramMessage(
            refUser.id,
            `🎁 Received +${commTrx.toFixed(4)} TRX ($${commUsdt.toFixed(2)} USDT) (${rates[lvl - 1] * 100}% Level ${lvl} Referral Commission)!`
        );

        current = refUser;
    }
}

async function approveRequest(reqDoc, u, reqId) {
    if (reqDoc.type === 'deposit' && u) {
        const depAmount = reqDoc.usdtAmount ? Number(reqDoc.usdtAmount) : 1;

        setRequestStatus(u.deposits, reqId, ['PENDING'], 'PAID');
        u.markModified('deposits');

        const now = Date.now();
        settleAccrual(u, now);

        const hadPaidPlan = isPaidPlanActive(u, now);
        u.ghs = hadPaidPlan ? Number(u.ghs) + depAmount : depAmount;
        u.planActive = true;
        u.planStartDate = now;
        u.planExpiryDate = now + PLAN_DURATION_MS;

        await u.save();
        await payReferralCommissions(u, depAmount);

        sendTelegramMessage(reqDoc.userId, `✅ Your deposit of <b>${esc(reqAmountLabel(reqDoc))}</b> has been approved!\n⚡ +${depAmount} GHS Mining Power added (Valid for 10 Days).\n⛏️ Mining is now active. Collect your profit anytime from the app.`);
    } else if (reqDoc.type === 'withdraw' && u) {
        setRequestStatus(u.withdrawals, reqId, ['PENDING', 'PEND1NG'], 'PAID');
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `✅ Your withdrawal of <b>${esc(reqAmountLabel(reqDoc))}</b> has been approved and sent!`);
    }
}

async function rejectRequest(reqDoc, u, reqId) {
    if (reqDoc.type === 'deposit' && u) {
        setRequestStatus(u.deposits, reqId, ['PENDING'], 'DECLINED');
        u.markModified('deposits');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `❌ Your deposit request was declined.`);
    } else if (reqDoc.type === 'withdraw' && u) {
        u.balance += reqTrx(reqDoc);
        setRequestStatus(u.withdrawals, reqId, ['PENDING', 'PEND1NG'], 'DECLINED');
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `❌ Your withdrawal request was declined and funds refunded.`);
    }
}

async function closeRequest(reqDoc, u, reqId) {
    if (reqDoc.type === 'deposit' && u) {
        setRequestStatus(u.deposits, reqId, ['PENDING'], 'CLOSED');
        u.markModified('deposits');
        await u.save();
    } else if (reqDoc.type === 'withdraw' && u) {
        u.balance += reqTrx(reqDoc);
        setRequestStatus(u.withdrawals, reqId, ['PENDING', 'PEND1NG'], 'CLOSED');
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `ℹ️ Your withdrawal request was closed and funds refunded.`);
    }
}

// One single place that handles approve / reject / close (used by BOT buttons and ADMIN PANEL)
async function processRequest(reqId, action, tgMsgId = null) {
    const reqDoc = await PendingRequest.findOneAndDelete({ reqId });
    if (!reqDoc) return { ok: false, message: "Request already handled!" };

    try {
        const u = await User.findOne({ id: reqDoc.userId });
        if (!u) throw new Error("User not found");

        let statusLine;
        if (action === 'approve') {
            await approveRequest(reqDoc, u, reqId);
            statusLine = '✅ <b>APPROVED</b>';
        } else if (action === 'reject') {
            await rejectRequest(reqDoc, u, reqId);
            statusLine = '❌ <b>REJECTED</b>';
        } else if (action === 'close') {
            await closeRequest(reqDoc, u, reqId);
            statusLine = '🚫 <b>CLOSED</b>';
        } else {
            throw new Error("Unknown action");
        }

        const msgId = tgMsgId || reqDoc.adminMsgId;
        if (msgId && ADMIN_ID) {
            await editTelegramMessage(ADMIN_ID, msgId, adminRequestText(reqDoc, statusLine));
        }
        return { ok: true, message: "Action executed successfully!" };
    } catch (err) {
        console.log("processRequest error:", err);
        // put the request back so the admin can try again
        try {
            const o = reqDoc.toObject();
            delete o._id; delete o.__v;
            await PendingRequest.create(o);
        } catch (e2) { console.log("Re-queue error:", e2); }
        return { ok: false, message: "Error: " + err.message };
    }
}

// ================== REFERRAL REGISTER (3 LEVELS) ==================
// The referrer must exist and must not be somebody in this user's own downline (no loops)
async function referrerIsValid(userId, referrerId) {
    userId = String(userId); referrerId = String(referrerId || '');
    if (!referrerId || referrerId === userId) return false;
    const ref = await User.findOne({ id: referrerId }, 'id referredBy');
    if (!ref) return false;
    let cur = ref.referredBy, hops = 0;
    while (cur && hops < 10) {
        if (String(cur) === userId) return false;
        const up = await User.findOne({ id: String(cur) }, 'referredBy');
        if (!up) break;
        cur = up.referredBy;
        hops++;
    }
    return true;
}

// A referrer can only be attached to a fresh account: no referrer yet, no deposits, no team of its own
function canAttachReferrer(user) {
    if (user.referredBy) return false;
    if (user.deposits && user.deposits.length) return false;
    const r = user.referrals || {};
    if ((r.level1 && r.level1.length) || (r.level2 && r.level2.length) || (r.level3 && r.level3.length)) return false;
    return true;
}

async function registerReferral(user) {
    try {
        if (!user || !user.referredBy) return;
        const chatId = String(user.id);
        let currentRefId = String(user.referredBy);

        for (let lvl = 1; lvl <= 3; lvl++) {
            if (!currentRefId || currentRefId === chatId) break;
            const refUser = await User.findOne({ id: currentRefId });
            if (!refUser) break;

            const key = `level${lvl}`;
            if (!refUser.referrals) refUser.referrals = { level1: [], level2: [], level3: [] };
            if (!Array.isArray(refUser.referrals[key])) refUser.referrals[key] = [];

            const exists = refUser.referrals[key].some(r => (typeof r === 'string' ? r === chatId : r.id === chatId));
            if (!exists) {
                refUser.referrals[key].push({ id: chatId, joinedDate: 'Active', joinedAt: Date.now(), bonusEarned: 0 });
                refUser.markModified(`referrals.${key}`);
                await refUser.save();
                sendTelegramMessage(refUser.id, `🎁 <b>New Level ${lvl} Referral Joined!</b>\n${esc(user.username || 'User')} · ID: <code>${esc(chatId)}</code>`);
            }
            currentRefId = refUser.referredBy ? String(refUser.referredBy) : null;
        }
    } catch (err) {
        console.log('registerReferral error:', err);
    }
}

// ================== TELEGRAM WEBHOOK ==================

async function handleWebhookLogic(req, res) {
    const update = req.body || {};
    res.sendStatus(200);

    try {
        if (update.message) {
            const msg = update.message;
            const chatId = String(msg.chat.id);
            const text = msg.text || '';

            let user = await User.findOne({ id: chatId });
            if (user && user.isBanned) {
                await sendTelegramMessage(chatId, "⚠️ <b>Access Denied:</b> Your account has been banned by the admin.");
                return;
            }

            if (text.startsWith('/start')) {
                let referrerId = null;
                const match = text.match(/\/start\s+(?:ref[_-]?)?(\d+)/i);
                if (match && match[1]) {
                    referrerId = String(match[1]).trim();
                }

                if (!user) {
                    const okRef = (referrerId && await referrerIsValid(chatId, referrerId)) ? referrerId : null;
                    user = new User({
                        id: chatId,
                        username: msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'User'),
                        referredBy: okRef
                    });
                    await user.save();
                } else {
                    let currentUsername = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'User');
                    if (user.username !== currentUsername) {
                        user.username = currentUsername;
                        await user.save();
                    }
                    if (referrerId && canAttachReferrer(user) && await referrerIsValid(chatId, referrerId)) {
                        user.referredBy = referrerId;
                        await user.save();
                    }
                }

                if (user.referredBy) {
                    await registerReferral(user);
                }

                const welcomeCaption =
`🎉 <b>Welcome to TRON RICH 🔥!</b>

<i>Mine TRX &amp; Crypto, invite friends and withdraw instantly.</i>

⛏️ Start mining with free power
🎁 Buy plans &amp; earn daily profit
👥 Invite friends &amp; earn 3-level commission
💸 Withdraw straight to your wallet

👇 <b>Join our official channel below!</b>`;
                const startPhotoUrl = "https://cryptologos.cc/logos/tron-trx-logo.png?v=032";

                const webAppMarkup = {
                    inline_keyboard: [
                        [{ text: "📢 Join Official Channel", url: "https://t.me/unitedPay115" }]
                    ]
                };

                await sendTelegramPhoto(chatId, startPhotoUrl, welcomeCaption, webAppMarkup);

            } else if (/^\/admin(@\w+)?$/i.test(text.trim())) {
                const fromId = String((msg.from && msg.from.id) || chatId);
                if (fromId === ADMIN_ID) {
                    const baseUrl = String(process.env.RENDER_EXTERNAL_URL || 'https://unitedpay.onrender.com').replace(/\/+$/, '');
                    await sendTelegramMessage(chatId, `👑 <b>TRON RICH Admin Access</b>\n\nClick below to open the login page:`, {
                        inline_keyboard: [[{ text: "🔐 Admin Login Panel", url: `${baseUrl}/admin/login` }]]
                    });
                } else {
                    await sendTelegramMessage(chatId, `⛔ <b>Admin only.</b>\nYour Telegram ID: <code>${esc(fromId)}</code>`);
                }
            } else if (/^\/myid(@\w+)?$/i.test(text.trim())) {
                await sendTelegramMessage(chatId, `🆔 Your Telegram ID: <code>${esc((msg.from && msg.from.id) || chatId)}</code>`);
            }
        } else if (update.callback_query) {
            const query = update.callback_query;
            const fromId = String(query.from.id);
            const data = query.data || '';
            const messageId = query.message ? query.message.message_id : null;

            if (data.startsWith('approve_') || data.startsWith('reject_')) {
                if (fromId !== ADMIN_ID) return answerCallbackQuery(query.id, "Unauthorized!", true);

                const isApprove = data.startsWith('approve_');
                const reqId = data.slice(isApprove ? 'approve_'.length : 'reject_'.length);

                const result = await processRequest(reqId, isApprove ? 'approve' : 'reject', messageId);
                return answerCallbackQuery(query.id, result.ok ? (isApprove ? "✅ Approved!" : "❌ Rejected!") : result.message, !result.ok);
            }

            return answerCallbackQuery(query.id, "");
        }
    } catch (err) {
        console.log("Webhook error:", err);
    }
}

app.post(`/api/webhook/${BOT_TOKEN}`, handleWebhookLogic);
app.post('/webhook', handleWebhookLogic);
app.post('/api/webhook/*', handleWebhookLogic);

app.get('/health', (req, res) => { res.type('text').send('ok'); });

app.get('/', (req, res) => {
    res.send(`<h1>TRON RICH Mining Backend Active</h1><p>Please launch via Telegram Bot (@TronRichMiningTg_Bot).</p>`);
});

// ================== ADMIN PANEL ==================
app.get('/admin/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Login - TRON RICH</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { box-sizing: border-box; font-family: 'Segoe UI', sans-serif; }
                body { background: #0c0a09; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .login-card { background: #1c1917; border: 1px solid #292524; padding: 30px; border-radius: 16px; width: 90%; max-width: 360px; text-align: center; }
                h2 { color: #f0b94d; margin-bottom: 20px; }
                input { width: 100%; padding: 12px; margin-bottom: 12px; background: #0c0a09; border: 1px solid #44403c; color: #fff; border-radius: 8px; }
                button { width: 100%; padding: 12px; background: #f0b94d; color: #000; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; }
            </style>
        </head>
        <body>
            <div class="login-card">
                <h2>🔐 Admin Login</h2>
                <form action="/admin/login" method="POST">
                    <input type="text" name="username" placeholder="Username" required>
                    <input type="password" name="password" placeholder="Password" required>
                    <button type="submit">Login</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    const ip = req.ip || 'unknown';
    if (loginBlocked(ip)) {
        return res.send(`<script>alert('Too many wrong attempts. Try again in 10 minutes.'); window.location.href='/admin/login';</script>`);
    }
    if (ADMIN_PASSWORD && username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        delete loginFails[ip];
        const secure = req.secure ? '; Secure' : '';
        res.setHeader('Set-Cookie', `admin_session=${makeSession()}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax${secure}`);
        return res.redirect('/admin/dashboard');
    }
    const f = loginFails[ip] || { count: 0, last: 0 };
    loginFails[ip] = { count: f.count + 1, last: Date.now() };
    res.send(`<script>alert('Invalid Credentials!'); window.location.href='/admin/login';</script>`);
});

app.get('/admin/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Max-Age=0');
    res.redirect('/admin/login');
});

app.get('/admin/dashboard', checkAdminAuth, async (req, res) => {
    const requests = await PendingRequest.find({});
    const totalUsers = await User.countDocuments();
    const allUsers = await User.find({});
    const liveTrxPrice = await getTrxPrice();

    let totalPaidOut = 0;
    let totalGlobalDepositUsdt = 0;
    let activeDepositUsersCount = 0;
    let activeDepositUsersList = [];

    allUsers.forEach(u => {
        let userActualDepositSum = 0;
        if (u.deposits) {
            u.deposits.forEach(d => {
                if (d.status === 'PAID') {
                    let depUsdtVal = parseFloat(d.usdtAmount || 1);
                    userActualDepositSum += depUsdtVal;
                    totalGlobalDepositUsdt += depUsdtVal;
                }
            });
        }

        if (userActualDepositSum >= 1 && u.planActive !== false) {
            activeDepositUsersCount++;
            activeDepositUsersList.push(u);
        }

        if (u.withdrawals) {
            u.withdrawals.forEach(w => {
                if (w.status === 'PAID') totalPaidOut += parseFloat(w.amount || 0);
            });
        }
    });

    let totalGlobalDepositTrx = totalGlobalDepositUsdt / liveTrxPrice;

    let searchId = req.query.search ? String(req.query.search).trim() : '';
    let searchedUser = null;
    let userTotalDepositUsdt = 0;
    let userTotalWithdrawTrx = 0;
    let userPaidWithdrawCount = 0;
    let totalRefEarn = 0;

    if (searchId) {
        const cleanName = searchId.replace('@', '');
        searchedUser = await User.findOne({
            $or: [{ id: searchId }, { username: cleanName }, { username: '@' + cleanName }]
        });

        if (searchedUser) {
            if (searchedUser.deposits) {
                searchedUser.deposits.forEach(d => {
                    if (d.status === 'PAID') {
                        userTotalDepositUsdt += parseFloat(d.usdtAmount || 1);
                    }
                });
            }
            if (searchedUser.withdrawals) {
                searchedUser.withdrawals.forEach(w => {
                    if (w.status === 'PAID') {
                        userTotalWithdrawTrx += parseFloat(w.amount || 0);
                        userPaidWithdrawCount++;
                    }
                });
            }
            let l1Earn = searchedUser.refEarnings?.level1 || 0;
            let l2Earn = searchedUser.refEarnings?.level2 || 0;
            let l3Earn = searchedUser.refEarnings?.level3 || 0;
            totalRefEarn = l1Earn + l2Earn + l3Earn;
        }
    }

    const searchIdJs = JSON.stringify(searchId).replace(/</g, '\\u003c');

    let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>TRON RICH Admin Panel</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
                body { background: #0c0a09; color: #f3f4f6; margin: 0; padding: 20px; }
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                .header h1 { color: #f0b94d; margin: 0; font-size: 24px; }
                .logout-btn { background: #ef4444; color: #fff; padding: 6px 12px; border-radius: 6px; text-decoration: none; font-size: 12px; font-weight: bold; }
                .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
                .stat-card { background: #1c1917; border: 1px solid #292524; border-radius: 12px; padding: 15px; text-align: left; }
                .stat-title { font-size: 11px; color: #a8a29e; text-transform: uppercase; letter-spacing: 0.5px; }
                .stat-value { font-size: 20px; font-weight: bold; color: #f0b94d; margin-top: 6px; }
                .nav-tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; background: #1c1917; padding: 10px; border-radius: 12px; border: 1px solid #292524; }
                .nav-tab { background: #292524; color: #a8a29e; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: bold; cursor: pointer; transition: 0.2s; }
                .nav-tab.active { background: #f0b94d; color: #000; }
                .tab-content { display: none; }
                .tab-content.active { display: block; }
                .card { background: #1c1917; border: 1px solid #292524; border-radius: 12px; padding: 18px; margin-bottom: 20px; overflow-x: auto; }
                .card h3 { color: #f0b94d; margin-top: 0; font-size: 16px; border-bottom: 1px solid #292524; padding-bottom: 8px; }
                .search-box { display: flex; gap: 10px; margin-bottom: 15px; }
                input, textarea { background: #0c0a09; border: 1px solid #44403c; color: #fff; padding: 10px; border-radius: 8px; width: 100%; font-size: 14px; }
                .btn { background: #f0b94d; color: #000; border: none; font-weight: bold; padding: 10px 18px; border-radius: 8px; cursor: pointer; }
                .btn-green { background: #22c55e; color: #fff; }
                .btn-red { background: #ef4444; color: #fff; }
                .btn-blue { background: #3b82f6; color: #fff; }
                .btn-gray { background: #6b7280; color: #fff; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { padding: 10px; text-align: left; border-bottom: 1px solid #292524; font-size: 12px; }
                th { color: #a8a29e; }
                code { word-break: break-all; }
                .user-details-box { background: #0c0a09; padding: 14px; border-radius: 8px; border: 1px solid #292524; margin-top: 10px; font-size: 13px; line-height: 1.8; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>👑 TRON RICH Admin Panel</h1>
                <div>
                    <a href="/admin/logout" class="logout-btn">Logout</a>
                </div>
            </div>

            <div style="background: #1c1917; border: 1px solid #292524; border-radius: 10px; padding: 10px 15px; margin-bottom: 15px; font-size: 13px; color: #f0b94d; display: flex; justify-content: space-between; align-items: center;">
                <span>📈 <b>Live TRX Price:</b> $${liveTrxPrice.toFixed(4)} USDT</span>
                <span style="font-size: 11px; color: #a8a29e;">Auto-updated</span>
            </div>

            <div class="stats-grid">
                <div class="stat-card"><div class="stat-title">Total Users</div><div class="stat-value">${totalUsers}</div></div>
                <div class="stat-card"><div class="stat-title">Total User Deposit</div><div class="stat-value">${totalGlobalDepositUsdt.toFixed(2)} USDT<br><span style="font-size:13px; color:#22c55e;">(${totalGlobalDepositTrx.toFixed(2)} TRX)</span></div></div>
                <div class="stat-card"><div class="stat-title">Total Active Plan Users ($1+)</div><div class="stat-value">${activeDepositUsersCount} Users</div></div>
                <div class="stat-card"><div class="stat-title">Paid Out</div><div class="stat-value">${totalPaidOut.toFixed(2)} TRX<br><span style="font-size:13px; color:#38bdf8;">($${(totalPaidOut * liveTrxPrice).toFixed(2)} USDT)</span></div></div>
                <div class="stat-card"><div class="stat-title">Pending Requests</div><div class="stat-value">${requests.length}</div></div>
            </div>

            <div class="nav-tabs">
                <div class="nav-tab active" onclick="switchTab('tab-users', this)">👥 Users & Plans</div>
                <div class="nav-tab" onclick="switchTab('tab-search', this)">🔍 Search & Manage</div>
                <div class="nav-tab" onclick="switchTab('tab-requests', this)">⏳ Pending Requests (${requests.length})</div>
                <div class="nav-tab" onclick="switchTab('tab-broadcast', this)">📢 Broadcast</div>
            </div>

            <div id="tab-users" class="tab-content active">
                <div class="card">
                    <h3>👥 Users With Active Plans ($1+ Deposits Only)</h3>
                    ${activeDepositUsersList.length === 0 ? `<p style="font-size:12px; color:#a8a29e;">No active plan users found.</p>` : `
                        <table>
                            <tr><th>User ID</th><th>Username</th><th>Total Deposit</th><th>GHS Power</th><th>Plan Expiry</th></tr>
                            ${activeDepositUsersList.map(depUser => {
                                let depTotalUsdt = 0;
                                if (depUser.deposits) {
                                    depUser.deposits.forEach(d => {
                                        if (d.status === 'PAID') depTotalUsdt += parseFloat(d.usdtAmount || 1);
                                    });
                                }
                                let depTotalTrx = depTotalUsdt / liveTrxPrice;
                                let displayUname = depUser.username ? (depUser.username.startsWith('@') ? depUser.username : '@' + depUser.username) : '@User';
                                let planDaysStr = getPlanDaysFormat(depUser);
                                return `
                                    <tr>
                                        <td><code>${esc(depUser.id)}</code></td>
                                        <td>${esc(displayUname)}</td>
                                        <td><b style="color:#22c55e;">${depTotalUsdt.toFixed(2)} USDT</b><br><span style="font-size:10px; color:#f0b94d;">(${depTotalTrx.toFixed(2)} TRX)</span></td>
                                        <td><b>${depUser.ghs} GHS</b></td>
                                        <td><b style="color:#f0b94d;">${planDaysStr}</b></td>
                                    </tr>
                                `;
                            }).join('')}
                        </table>
                    `}
                </div>
            </div>

            <div id="tab-search" class="tab-content">
                <div class="card">
                    <h3>🔍 Search User Details & Manage Plan</h3>
                    <form method="GET" action="/admin/dashboard" class="search-box">
                        <input type="text" name="search" placeholder="Enter Telegram User ID or Username" value="${esc(searchId)}">
                        <button type="submit" class="btn">Search</button>
                    </form>
                    ${searchedUser ? `
                        <div class="user-details-box">
                            <p>👤 <b>User Name:</b> ${esc(searchedUser.username.startsWith('@') ? searchedUser.username : '@' + searchedUser.username)} | <b>ID:</b> <code>${esc(searchedUser.id)}</code></p>
                            <p>💰 <b>Current Balance:</b> <span style="color:#f0b94d; font-weight:bold;">${searchedUser.balance.toFixed(4)} TRX</span> <span style="color:#22c55e;">($${(searchedUser.balance * liveTrxPrice).toFixed(2)} USDT)</span> | ⚡ <b>GHS Power:</b> ${searchedUser.ghs} GHS</p>
                            <p>🚫 <b>Account Status:</b> ${searchedUser.isBanned ? '<span style="color:#ef4444; font-weight:bold;">BANNED</span>' : '<span style="color:#22c55e; font-weight:bold;">ACTIVE</span>'}</p>
                            <p>⚡ <b>Mining Plan Status:</b> ${searchedUser.planActive !== false && searchedUser.ghs > 0 ? '<span style="color:#22c55e; font-weight:bold;">ACTIVE (' + getPlanDaysFormat(searchedUser) + ')</span>' : '<span style="color:#ef4444; font-weight:bold;">DEACTIVATED / EXPIRED</span>'}</p>
                            <p>📥 <b>Total Approved Deposit:</b> <span style="color:#22c55e; font-weight:bold;">${userTotalDepositUsdt.toFixed(2)} USDT</span> <span style="color:#f0b94d;">(${(userTotalDepositUsdt / liveTrxPrice).toFixed(2)} TRX)</span></p>
                            <p>📤 <b>Total Approved Withdraw:</b> <span style="color:#ef4444; font-weight:bold;">${userTotalWithdrawTrx.toFixed(4)} TRX</span> <span style="color:#f0b94d;">($${(userTotalWithdrawTrx * liveTrxPrice).toFixed(2)} USDT)</span> (<span style="color:#f0b94d;">${userPaidWithdrawCount} Times Paid</span>)</p>
                            <p>👥 <b>Referrals Count:</b> L1: ${searchedUser.referrals?.level1?.length || 0} | L2: ${searchedUser.referrals?.level2?.length || 0} | L3: ${searchedUser.referrals?.level3?.length || 0}</p>
                            <p>🎁 <b>Total Referral Commission:</b> <span style="color:#f0b94d; font-weight:bold;">${totalRefEarn.toFixed(4)} TRX</span> <span style="color:#22c55e;">($${(totalRefEarn * liveTrxPrice).toFixed(2)} USDT)</span></p>
                            <p>🔗 <b>Referred By ID:</b> ${esc(searchedUser.referredBy || 'Direct Join')}</p>
                            <hr style="border-color:#292524; margin:12px 0;">
                            <b>⚙️ Manage User Balance, Plan & Status:</b>
                            <div style="display:flex; gap:10px; margin-top:8px; flex-wrap:wrap;">
                                <input type="number" id="mod-amt" placeholder="Enter amount" style="flex:1; min-width:140px;">
                                <button class="btn btn-green" onclick="modifyBal('${esc(searchedUser.id)}', 'add')">+ Add</button>
                                <button class="btn btn-red" onclick="modifyBal('${esc(searchedUser.id)}', 'cut')">- Cut</button>
                                <button class="btn btn-blue" onclick="togglePlan('${esc(searchedUser.id)}', 'activate')">⚡ Activate Plan (10 Days)</button>
                                <button class="btn btn-red" onclick="togglePlan('${esc(searchedUser.id)}', 'deactivate')">❌ Deactivate Plan</button>
                                <button class="btn btn-red" onclick="toggleBan('${esc(searchedUser.id)}', 'ban')">🚫 Ban User</button>
                                <button class="btn btn-green" onclick="toggleBan('${esc(searchedUser.id)}', 'unban')">✅ Unban User</button>
                            </div>
                            <hr style="border-color:#292524; margin:12px 0;">
                            <b>✉️ Send Personal Message to this User:</b>
                            <div style="display:flex; gap:10px; margin-top:8px;">
                                <input type="text" id="single-msg" placeholder="Type message for this user..." style="flex:1;">
                                <button class="btn" onclick="sendSingleMsg('${esc(searchedUser.id)}')">Send Msg</button>
                            </div>
                        </div>
                    ` : searchId ? `<p style="color:#ef4444; font-size:12px;">User not found!</p>` : ''}
                </div>
            </div>

            <div id="tab-requests" class="tab-content">
                <div class="card">
                    <h3>⏳ Pending Requests</h3>
                    ${requests.length === 0 ? `<p style="font-size:12px; color:#a8a29e;">No pending requests right now.</p>` : `
                        <table>
                            <tr><th>Type</th><th>User</th><th>Coin</th><th>Amount (exact)</th><th>Details</th><th>Action</th></tr>
                            ${requests.map(r => `
                                <tr>
                                    <td style="color:${r.type==='deposit'?'#22c55e':'#ef4444'}; font-weight:bold;">${esc(r.type.toUpperCase())}</td>
                                    <td><code>${esc(r.userId)}</code>${r.username ? '<br>' + esc(r.username) : ''}</td>
                                    <td>${esc(r.coin || r.coinSymbol || 'TRX')}</td>
                                    <td><b>${esc(reqAmountLabel(r))}</b>${r.type === 'deposit' ? '<br><span style="color:#a8a29e;">(' + esc(r.usdtAmount) + ' USDT)</span>' : '<br><span style="color:#a8a29e;">($' + Number(r.usdValue || 0).toFixed(2) + ')</span>'}</td>
                                    <td style="max-width:260px;">${r.type === 'deposit' ? 'Tx: <code>' + esc(r.txHash) + '</code>' : 'Addr: <code>' + esc(r.address) + '</code>'}</td>
                                    <td style="white-space:nowrap;">
                                        <button class="btn btn-green" style="padding:4px 8px; font-size:11px;" onclick="handleReq('${esc(r.reqId)}', 'approve')">Approve</button>
                                        <button class="btn btn-red" style="padding:4px 8px; font-size:11px;" onclick="handleReq('${esc(r.reqId)}', 'reject')">Reject</button>
                                        <button class="btn btn-gray" style="padding:4px 8px; font-size:11px;" onclick="handleReq('${esc(r.reqId)}', 'close')">Close</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </table>
                    `}
                </div>
            </div>

            <div id="tab-broadcast" class="tab-content">
                <div class="card">
                    <h3>📢 Broadcast Message with Photo to All Users</h3>
                    <input type="text" id="bc-photo" placeholder="Enter Direct Image URL (Optional)" style="margin-bottom:10px;">
                    <textarea id="bc-msg" placeholder="Write message to send to all bot users..."></textarea>
                    <button class="btn" style="margin-top:10px; width:100%;" onclick="sendBroadcast()">Send Broadcast Message</button>
                </div>
            </div>

            <script>
                function switchTab(tabId, el) {
                    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
                    document.querySelectorAll('.nav-tab').forEach(nt => nt.classList.remove('active'));
                    document.getElementById(tabId).classList.add('active');
                    el.classList.add('active');
                }

                if (${searchIdJs} !== '') {
                    switchTab('tab-search', document.querySelectorAll('.nav-tab')[1]);
                }

                async function postJson(url, body) {
                    let res = await fetch(url, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(body)
                    });
                    return await res.json();
                }
                async function handleReq(reqId, action) {
                    let data = await postJson('/admin/action', { reqId, action });
                    alert(data.message);
                    location.reload();
                }
                async function modifyBal(userId, action) {
                    let amount = document.getElementById('mod-amt').value;
                    if(!amount) return alert("Enter amount!");
                    let data = await postJson('/admin/manage-balance', { userId, amount, action });
                    alert(data.message);
                    location.reload();
                }
                async function togglePlan(userId, action) {
                    let data = await postJson('/admin/manage-plan', { userId, action });
                    alert(data.message);
                    location.reload();
                }
                async function toggleBan(userId, action) {
                    let data = await postJson('/admin/ban-user', { userId, action });
                    alert(data.message);
                    location.reload();
                }
                async function sendSingleMsg(userId) {
                    let message = document.getElementById('single-msg').value;
                    if(!message) return alert("Enter message!");
                    let data = await postJson('/admin/send-single', { userId, message });
                    alert(data.message);
                    document.getElementById('single-msg').value = '';
                }
                async function sendBroadcast() {
                    let message = document.getElementById('bc-msg').value;
                    let photoUrl = document.getElementById('bc-photo').value;
                    if(!message && !photoUrl) return alert("Please enter message or photo URL!");
                    let data = await postJson('/admin/broadcast', { message, photoUrl });
                    alert(data.message);
                }
            </script>
        </body>
        </html>
    `;
    res.send(html);
});

app.post('/admin/manage-plan', checkAdminAuth, async (req, res) => {
    const { userId, action } = req.body;
    let u = await User.findOne({ id: userId });
    if (!u) return res.status(404).json({ success: false, message: "User not found!" });

    const now = Date.now();
    settleAccrual(u, now);

    if (action === 'activate') {
        u.planActive = true;
        if (u.ghs <= 0) u.ghs = 1;
        u.planStartDate = now;
        u.planExpiryDate = now + PLAN_DURATION_MS;
        await u.save();
        sendTelegramMessage(userId, `⚡ <b>Plan Activated:</b> Admin has activated your mining plan for 10 Days!`);
        res.json({ success: true, message: `Plan activated successfully for user ${userId}!` });
    } else {
        u.planActive = false;
        u.ghs = 0;
        u.planStartDate = 0;
        u.planExpiryDate = 0;
        await u.save();
        sendTelegramMessage(userId, `❌ <b>Plan Expired:</b> Your mining plan has expired. Please renew your plan to keep earning 🚀`);
        res.json({ success: true, message: `Plan deactivated successfully for user ${userId}!` });
    }
});

app.post('/admin/action', checkAdminAuth, async (req, res) => {
    const { reqId, action } = req.body;
    if (!['approve', 'reject', 'close'].includes(action)) {
        return res.status(400).json({ success: false, message: "Invalid action" });
    }
    const result = await processRequest(String(reqId), action);
    res.status(result.ok ? 200 : 404).json({ success: result.ok, message: result.message });
});

app.post('/admin/manage-balance', checkAdminAuth, async (req, res) => {
    const { userId, amount, action } = req.body;
    let u = await User.findOne({ id: userId });
    if (!u) return res.status(404).json({ success: false, message: "User not found!" });

    let amt = parseFloat(amount);
    if (!(amt > 0)) return res.status(400).json({ success: false, message: "Invalid amount!" });

    if (action === 'add') {
        u.balance += amt;
        sendTelegramMessage(userId, `🎁 Admin added +${amt} TRX to your balance!`);
    } else {
        u.balance = Math.max(0, u.balance - amt);
        sendTelegramMessage(userId, `⚠️ Admin deducted -${amt} TRX from your balance.`);
    }
    await u.save();
    res.json({ success: true, message: `Successfully ${action}ed ${amt} TRX for user ${userId}!` });
});

app.post('/admin/ban-user', checkAdminAuth, async (req, res) => {
    const { userId, action } = req.body;
    let u = await User.findOne({ id: userId });
    if (!u) return res.status(404).json({ success: false, message: "User not found!" });

    if (action === 'ban') {
        u.isBanned = true;
        await u.save();
        sendTelegramMessage(userId, `🚫 <b>Account Banned:</b> You have been banned by the admin.`);
        res.json({ success: true, message: `User ${userId} has been banned successfully!` });
    } else {
        u.isBanned = false;
        await u.save();
        sendTelegramMessage(userId, `✅ <b>Account Unbanned:</b> Your account has been unbanned by the admin.`);
        res.json({ success: true, message: `User ${userId} has been unbanned successfully!` });
    }
});

app.post('/admin/send-single', checkAdminAuth, async (req, res) => {
    const { userId, message } = req.body;
    let u = await User.findOne({ id: userId });
    if (!u) return res.status(404).json({ success: false, message: "User not found!" });

    await sendTelegramMessage(userId, `📩 <b>Message from Admin:</b>\n\n${esc(message)}`);
    res.json({ success: true, message: `Message sent to user ${userId} successfully!` });
});

app.post('/admin/broadcast', checkAdminAuth, async (req, res) => {
    const { message, photoUrl } = req.body;
    const users = await User.find({});
    let count = 0;
    for (let u of users) {
        if (photoUrl && photoUrl.trim() !== '') {
            await sendTelegramPhoto(u.id, photoUrl.trim(), esc(message || ''));
        } else if (message && message.trim() !== '') {
            await sendTelegramMessage(u.id, esc(message));
        }
        count++;
    }
    res.json({ success: true, message: `Broadcast sent to ${count} users successfully!` });
});

// ================== MINI APP API ==================
const teamCache = new Map();
// registered / active (made a paid deposit) per level + team deposits, for the Team tab and the invite task
async function getTeamStats(user) {
    const hit = teamCache.get(user.id);
    if (hit && Date.now() - hit.time < 15000) return hit.data;

    const idsByLevel = ['level1', 'level2', 'level3'].map(function (l) {
        return ((user.referrals && user.referrals[l]) || []).map(function (r) { return String(typeof r === 'string' ? r : r.id); });
    });
    const allIds = [].concat.apply([], idsByLevel).slice(0, 3000);
    const info = {};
    if (allIds.length) {
        const docs = await User.find({ id: { $in: allIds } }, 'id deposits withdrawals');
        docs.forEach(function (d) {
            let dep = 0, hasDep = false, hasWd = false;
            (d.deposits || []).forEach(function (x) { if (x.status === 'PAID') { hasDep = true; dep += Number(x.usdtAmount) || 0; } });
            (d.withdrawals || []).forEach(function (x) { if (x.status === 'PAID') hasWd = true; });
            info[d.id] = { dep: dep, hasDep: hasDep, hasWd: hasWd };
        });
    }
    const out = { registered: [0, 0, 0], active: [0, 0, 0], depositsUsd: 0, firstDeposits: 0, firstWithdrawals: 0 };
    idsByLevel.forEach(function (ids, i) {
        ids.forEach(function (id) {
            out.registered[i]++;
            const x = info[id];
            if (!x) return;
            out.depositsUsd += x.dep;
            if (x.hasDep) { out.active[i]++; out.firstDeposits++; }
            if (x.hasWd) out.firstWithdrawals++;
        });
    });
    teamCache.set(user.id, { time: Date.now(), data: out });
    return out;
}

app.get('/api/user/:userId', requireTg, async (req, res) => {
    const userId = req.tgId;
    let user = await User.findOne({ id: userId });

    if (user && user.isBanned) {
        return res.status(403).json({ success: false, isBanned: true, message: "Your account is banned by admin." });
    }

    const now = Date.now();

    if (!user) {
        user = new User({ id: userId, username: req.tgName });
        await user.save();
    } else if (user.planActive && user.planExpiryDate && user.planExpiryDate > 0 && now >= user.planExpiryDate) {
        expireUserPlan(user, now);
        await user.save();
    }

    const refParam = req.query.ref ? String(req.query.ref).replace(/\D/g, '') : '';
    if (refParam && canAttachReferrer(user) && await referrerIsValid(userId, refParam)) {
        user.referredBy = refParam;
        await user.save();
        await registerReferral(user);
    }

    const price = await getTrxPrice();
    const data = user.toObject();

    ['level1', 'level2', 'level3'].forEach(lvl => {
        if (data.referrals && Array.isArray(data.referrals[lvl])) {
            data.referrals[lvl] = data.referrals[lvl].map(r => {
                if (typeof r === 'string') {
                    return { id: r, joinedDate: 'Active', bonusEarned: 0 };
                }
                return {
                    id: r.id || r,
                    joinedDate: r.joinedDate || 'Active',
                    bonusEarned: Number(r.bonusEarned || 0)
                };
            });
        }
    });

    data.deposits = (data.deposits || []).map(d => ({
        ...d,
        displayText: /[A-Za-z]/.test(String(d.amount || '')) ? String(d.amount) : `${d.usdtAmount || d.amount} USDT`
    }));
    data.withdrawals = (data.withdrawals || []).map(w => ({
        ...w,
        displayText: Number(w.coinAmount) > 0 && w.coinSymbol
            ? `${fmtCoin(w.coinAmount, w.coinSymbol)} ${w.coinSymbol}`
            : `${w.amount} TRX`
    }));

    data.team = await getTeamStats(user);
    data.pendingUsd = Number(user.accruedUsd || 0) + accrueUsd(user, now);
    data.dailyUsd = dailyUsdRate(user, now);
    data.paidPlan = isPaidPlanActive(user, now);
    data.trxPrice = price;
    res.json(data);
});

// ===== LIVE QUOTE: same source the server uses for requests (public, no login needed) =====
// Deposit:  GET /api/quote?coin=LTC (Litecoin)&usdt=1      -> exact LTC to pay
// Withdraw: GET /api/quote?coin=LTC (Litecoin)&trx=10      -> exact LTC you will receive
app.get('/api/quote', async (req, res) => {
    const sym = parseCoinSymbol(req.query.coin || 'TRX');
    const price = await getCoinPriceUsd(sym);
    if (!(price > 0)) return res.status(503).json({ success: false, message: `Live price for ${sym} unavailable` });

    const trxPrice = await getTrxPrice();
    const out = { success: true, symbol: sym, priceUsd: price, trxPriceUsd: trxPrice };

    const usdt = parseFloat(req.query.usdt);
    if (usdt > 0) out.coinAmount = roundCoin(usdt / price, sym);

    const trx = parseFloat(req.query.trx);
    if (trx > 0) {
        out.usdValue = trx * trxPrice;
        out.coinAmount = sym === 'TRX' ? trx : roundCoin(out.usdValue / price, sym);
    }
    res.json(out);
});

// Diagnostics: open /api/price-check?coin=SOL to see which price sources answer from this server
app.get('/api/price-check', async (req, res) => {
    const sym = parseCoinSymbol(req.query.coin || 'TRX');
    const r = await fetchAllPrices(sym);
    res.json({ symbol: sym, price: r.price, sources: r.ok, failed: r.failed });
});

// Channel task: checks if the user really joined the channel (needs the bot to be an admin of that channel)
const TASK_CHANNEL = process.env.TASK_CHANNEL || '@unitedPay115';
app.get('/api/task/channel-status/:userId', requireTg, async (req, res) => {
    try {
        const d = await tgCall('getChatMember', { chat_id: TASK_CHANNEL, user_id: Number(req.tgId) });
        if (d && d.ok && d.result) {
            const st = d.result.status;
            const joined = ['creator', 'administrator', 'member'].includes(st) || (st === 'restricted' && d.result.is_member === true);
            return res.json({ success: true, verified: true, joined });
        }
        // bot cannot check (not an admin of the channel, wrong channel name, ...) -> app will trust the user
        console.log('channel-status not verifiable:', d && d.description);
        return res.json({ success: true, verified: false, joined: false });
    } catch (e) {
        return res.json({ success: true, verified: false, joined: false });
    }
});

app.post('/api/update-ghs', requireTg, async (req, res) => {
    let u = await User.findOne({ id: req.tgId });
    if (u && u.isBanned) return res.status(403).json({ success: false, isBanned: true, message: "Your account is banned." });
    res.json({ success: true, ghs: u ? u.ghs : 0 });
});

app.post('/api/claim', requireTg, async (req, res) => {
    const userId = req.tgId;
    const u = await User.findOne({ id: userId });
    if (!u || u.isBanned) return res.status(400).json({ success: false, message: "User not found or banned" });

    const now = Date.now();
    const totalUsd = Number(u.accruedUsd || 0) + accrueUsd(u, now);
    if (!(totalUsd > 0)) return res.status(400).json({ success: false, message: "Nothing to collect yet" });

    const price = await getTrxPrice();
    const trxAmount = totalUsd / price;

    const updated = await User.findOneAndUpdate(
        { id: userId, lastClaimTime: u.lastClaimTime },
        { $inc: { balance: trxAmount }, $set: { accruedUsd: 0, lastClaimTime: now } },
        { new: true }
    );
    if (!updated) return res.status(409).json({ success: false, message: "Please try again." });

    res.json({
        success: true,
        balance: updated.balance,
        lastClaimTime: updated.lastClaimTime,
        claimedTrx: trxAmount,
        claimedUsd: totalUsd,
        trxPrice: price
    });
});

// ================== DEPOSIT (coin-wise exact live amount) ==================
app.post('/api/deposit', requireTg, async (req, res) => {
    const userId = req.tgId;
    const { amount, usdtAmount, coin, txHash } = req.body;
    if (!txHash) {
        return res.status(400).json({ success: false, message: "Invalid deposit data." });
    }

    const cleanTxHash = String(txHash).trim();
    if (cleanTxHash.length < 6 || cleanTxHash.length > 200) {
        return res.status(400).json({ success: false, message: "Invalid TxHash." });
    }

    const existingPending = await PendingRequest.findOne({ txHash: cleanTxHash });
    if (existingPending) {
        return res.status(400).json({
            success: false,
            message: "This TxHash has already been submitted and is currently pending!"
        });
    }

    const existingUserHash = await User.findOne({ "deposits.txHash": cleanTxHash });
    if (existingUserHash) {
        return res.status(400).json({
            success: false,
            message: "This TxHash has already been used! Please provide a new transaction hash."
        });
    }

    let u = await User.findOne({ id: userId });
    if (u && u.isBanned) return res.status(403).json({ success: false, isBanned: true, message: "Your account is banned." });
    if (!u) u = new User({ id: userId, username: req.tgName });

    if (req.tgName && req.tgName !== 'User') {
        u.username = req.tgName;
    }

    const coinRaw = String(coin || 'TRX (TRC-20)').slice(0, 60);
    const sym = parseCoinSymbol(coinRaw);
    let exactUsdtVal = Number(usdtAmount) > 0 ? Number(usdtAmount) : 1;
    if (exactUsdtVal < 1 || exactUsdtVal > 10000) {
        return res.status(400).json({ success: false, message: "Deposit amount must be between 1 and 10000." });
    }

    const price = await getCoinPriceUsd(sym);
    if (!(price > 0)) {
        return res.status(503).json({ success: false, message: `Live price for ${sym} is unavailable right now. Please try again.` });
    }

    // exact amount of the chosen coin for this USDT value
    const liveAmount = roundCoin(exactUsdtVal / price, sym);
    // if the app already showed the user an amount (within 15% of live), keep that exact number; otherwise use live
    const clientAmount = parseFloat(String(amount || '').replace(/,/g, ''));
    const coinAmount = (clientAmount > 0 && Math.abs(clientAmount - liveAmount) / liveAmount <= 0.15)
        ? roundCoin(clientAmount, sym)
        : liveAmount;
    const amountStr = `${fmtCoin(coinAmount, sym)} ${sym}`;

    const reqId = 'dep_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

    u.deposits.unshift({
        id: reqId,
        amount: amountStr,
        coinAmount: coinAmount,
        coinSymbol: sym,
        usdtAmount: exactUsdtVal,
        coin: coinRaw,
        txHash: cleanTxHash,
        status: 'PENDING',
        date: new Date().toLocaleDateString()
    });
    u.markModified('deposits');
    await u.save();

    const reqDoc = await PendingRequest.create({
        reqId,
        type: 'deposit',
        userId,
        username: u.username,
        amount: amountStr,
        usdtAmount: exactUsdtVal,
        coin: coinRaw,
        coinSymbol: sym,
        coinAmount: coinAmount,
        price: price,
        usdValue: exactUsdtVal,
        txHash: cleanTxHash,
        status: 'PENDING'
    });

    await sendRequestToAdmin(reqDoc);

    res.json({ success: true, message: "Deposit request submitted successfully", amount: amountStr, coinAmount, coinSymbol: sym });
});

// ================== WITHDRAW (coin-wise exact live amount) ==================
// Body: { address, coin: "LTC (Litecoin)", trxAmount (TRX to deduct)  OR  amount (in chosen coin) }
app.post('/api/withdraw', requireTg, async (req, res) => {
    const userId = req.tgId;
    const { amount, address, trxAmount, coin } = req.body;
    if (!address || String(address).trim().length < 10 || String(address).trim().length > 120) {
        return res.status(400).json({ success: false, message: "Invalid withdrawal data" });
    }
    const cleanAddress = String(address).trim();

    const coinRaw = String(coin || 'TRX (TRC-20)').slice(0, 60);
    const sym = parseCoinSymbol(coinRaw);

    const trxPrice = await getTrxPrice();
    const coinPrice = await getCoinPriceUsd(sym);
    if (!(coinPrice > 0)) {
        return res.status(503).json({ success: false, message: `Live price for ${sym} is unavailable right now. Please try again.` });
    }

    // work out how much TRX balance to deduct
    let trxAmt;
    if (parseFloat(trxAmount) > 0) {
        trxAmt = parseFloat(trxAmount);
    } else {
        const typed = parseFloat(amount);
        if (!(typed > 0)) return res.status(400).json({ success: false, message: "Invalid withdrawal amount" });
        trxAmt = sym === 'TRX' ? typed : (typed * coinPrice) / trxPrice;   // amount typed in chosen coin
    }
    trxAmt = Number(trxAmt.toFixed(8));
    if (!(trxAmt > 0)) return res.status(400).json({ success: false, message: "Invalid withdrawal amount" });
    if (trxAmt < MIN_WITHDRAW_TRX) {
        return res.status(400).json({ success: false, message: `Minimum withdrawal is ${MIN_WITHDRAW_TRX} TRX` });
    }

    const usdValue = trxAmt * trxPrice;
    const coinAmount = sym === 'TRX' ? roundCoin(trxAmt, 'TRX') : roundCoin(usdValue / coinPrice, sym);
    const amountStr = `${fmtCoin(coinAmount, sym)} ${sym}`;

    let u = await User.findOne({ id: userId });
    if (!u || u.isBanned) {
        return res.status(403).json({ success: false, message: "Account restricted or banned" });
    }

    const existingPending = await PendingRequest.findOne({ userId: userId, type: 'withdraw', status: 'PENDING' });
    if (existingPending) {
        return res.status(400).json({
            success: false,
            message: "You already have a pending withdrawal request. Please wait until it is processed!"
        });
    }

    const reqId = 'wd_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const entry = {
        id: reqId,
        amount: trxAmt,              // TRX deducted (kept for app compatibility)
        coin: coinRaw,
        coinSymbol: sym,
        coinAmount: coinAmount,      // exact amount admin will pay in chosen coin
        usdValue: usdValue,
        address: cleanAddress,
        status: 'PENDING',
        date: new Date().toLocaleDateString()
    };

    // atomic: deduct balance only if enough balance, and add history in the same step
    const setFields = {};
    if (req.tgName && req.tgName !== 'User') setFields.username = req.tgName;
    const updateDoc = {
        $inc: { balance: -trxAmt },
        $push: { withdrawals: { $each: [entry], $position: 0 } }
    };
    if (Object.keys(setFields).length) updateDoc.$set = setFields;

    const updated = await User.findOneAndUpdate(
        { id: userId, isBanned: { $ne: true }, balance: { $gte: trxAmt } },
        updateDoc,
        { new: true }
    );
    if (!updated) {
        return res.status(400).json({ success: false, message: "Insufficient balance for withdrawal!" });
    }

    let reqDoc;
    try {
        reqDoc = await PendingRequest.create({
            reqId,
            type: 'withdraw',
            userId,
            username: updated.username,
            amount: amountStr,
            coin: coinRaw,
            coinSymbol: sym,
            coinAmount: coinAmount,
            trxAmount: trxAmt,
            usdValue: usdValue,
            price: coinPrice,
            address: cleanAddress,
            status: 'PENDING'
        });
    } catch (err) {
        console.log("Pending withdraw create error:", err);
        await User.updateOne({ id: userId }, { $inc: { balance: trxAmt }, $pull: { withdrawals: { id: reqId } } });
        return res.status(500).json({ success: false, message: "Could not create request. Try again." });
    }

    await sendRequestToAdmin(reqDoc);

    res.json({
        success: true,
        message: "Withdrawal request submitted successfully",
        newBalance: updated.balance,
        amount: amountStr,
        coinAmount,
        coinSymbol: sym
    });
});

let botUsernameCache = null;
app.get('/api/bot-info', async (req, res) => {
    try {
        if (!botUsernameCache) {
            const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
            const d = await r.json();
            if (d && d.ok && d.result && d.result.username) botUsernameCache = d.result.username;
        }
        res.json({ success: !!botUsernameCache, username: botUsernameCache });
    } catch (e) {
        res.json({ success: false, username: null });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL && BOT_TOKEN) {
        try {
            await tgCall('setWebhook', {
                url: `${RENDER_URL}/api/webhook/${BOT_TOKEN}`,
                allowed_updates: ['message', 'callback_query']
            });
            console.log("Telegram Webhook Set Successfully!");
        } catch (e) {
            console.log("Failed to set webhook:", e);
        }
    }
});
