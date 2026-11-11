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
function requireTg(req, res, next) {
    const uid = String((req.body && req.body.userId) || (req.params && req.params.userId) || (req.query && req.query.userId) || '');
    if (!validId(uid)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    req.tgId = uid;
    const nm = req.body && req.body.username;
    req.tgName = nm && String(nm).length < 80 ? String(nm) : 'User';
    next();
}

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

function parseCoinSymbol(coin) {
    const s = String(coin || '').toUpperCase().trim();
    const tokens = s.match(/[A-Z0-9]+/g) || [];
    const isKnown = t => STABLE.has(t) || !!COINGECKO_IDS[t];
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
const PRICE_FRESH_MS = 20 * 1000;
const PRICE_STALE_MS = 15 * 60 * 1000;

async function getJson(url) {
    const r = await fetch(url, {
        signal: AbortSignal.timeout(4500),
        headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; TronRichBot/1.0)' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
}

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
        const near = ok.filter(o => Math.abs(o.price - m0) / m0 <= 0.03);
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

// ================== MINING RULES (DIRECT TRX) ==================
const PLAN_DURATION_MS = 10 * 24 * 60 * 60 * 1000;
const PAID_DAILY_TRX_PER_GHS = 0.9456; 
const FREE_DAILY_TRX = 0.03;

function isPaidPlanActive(u, now = Date.now()) {
    return u.planActive !== false && Number(u.ghs) > 0 && !(u.planExpiryDate > 0 && now >= u.planExpiryDate);
}

function dailyTrxRate(u, now = Date.now()) {
    return isPaidPlanActive(u, now) ? Number(u.ghs) * PAID_DAILY_TRX_PER_GHS : FREE_DAILY_TRX;
}

function accrueTrx(u, now = Date.now()) {
    const last = Number(u.lastClaimTime) || now;
    if (now <= last) return 0;
    let trx = 0;
    let cursor = last;
    if (u.planActive !== false && Number(u.ghs) > 0) {
        const paidEnd = (u.planExpiryDate > 0) ? Math.min(now, u.planExpiryDate) : now;
        if (paidEnd > cursor) {
            trx += ((paidEnd - cursor) / 1000) * (Number(u.ghs) * PAID_DAILY_TRX_PER_GHS / 86400);
            cursor = paidEnd;
        }
    }
    if (now > cursor) {
        trx += ((now - cursor) / 1000) * (FREE_DAILY_TRX / 86400);
    }
    return trx;
}

function settleAccrual(u, now = Date.now()) {
    u.accruedTrx = Number(u.accruedTrx || 0) + accrueTrx(u, now);
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
    accruedTrx: { type: Number, default: 0 },
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
    amount: { type: String, required: true },
    usdtAmount: { type: Number, default: 1 },
    coin: { type: String },
    coinSymbol: { type: String },
    coinAmount: { type: Number, default: 0 },
    trxAmount: { type: Number, default: 0 },
    usdValue: { type: Number, default: 0 },
    price: { type: Number, default: 0 },
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

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Tg-Init-Data');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

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
            delete body.parse_mode;
            body.text = stripTags(text);
            data = await tgCall('sendMessage', body);
        }
        return data;
    } catch (e) {
        return null;
    }
}

async function sendTelegramPhoto(chatId, photoUrl, caption = '', replyMarkup = null) {
    try {
        let body = { chat_id: chatId, photo: photoUrl, caption: caption, parse_mode: 'HTML' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        let data = await tgCall('sendPhoto', body);
        if (!data.ok) {
            delete body.parse_mode;
            body.caption = stripTags(caption);
            data = await tgCall('sendPhoto', body);
        }
        return data;
    } catch (e) {
        return null;
    }
}

async function editTelegramMessage(chatId, messageId, text, replyMarkup = null) {
    try {
        let body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        let data = await tgCall('editMessageText', body);
        if (!data.ok) {
            delete body.parse_mode;
            body.text = stripTags(text);
            data = await tgCall('editMessageText', body);
        }
        return data;
    } catch (e) {
        return null;
    }
}

async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
    try {
        await tgCall('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text, show_alert: showAlert });
    } catch (e) {}
}

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

// ================== BACKGROUND JOBS ==================
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
            sendTelegramMessage(u.id, `❌ <b>Plan Expired:</b> Your mining plan has expired. Please renew your plan to keep earning 🚀`);
        }
    } catch (err) {
        console.log("Background Plan Expiry Error:", err);
    }
}, 5 * 60 * 1000);

const sweepMining = setInterval(async () => {
    try {
        const currentTime = Date.now();
        const activeUsers = await User.find({ isBanned: { $ne: true } });
        
        for (let u of activeUsers) {
            if (u.planActive && u.ghs > 0 && u.planExpiryDate > 0 && currentTime >= u.planExpiryDate) {
                expireUserPlan(u, currentTime);
                await u.save();
                continue;
            }
            
            const earned = accrueTrx(u, currentTime);
            if (earned > 0) {
                u.accruedTrx = Number(u.accruedTrx || 0) + earned;
                u.lastClaimTime = currentTime;
                await u.save();
            }
        }
    } catch (err) {
        console.log("Sweep Mining Error:", err);
    }
}, 60 * 1000);

function getPlanDaysFormat(user) {
    if (!user.planActive || user.ghs <= 0) return "N/A";
    let startTimestamp = user.planStartDate;
    if (!startTimestamp || startTimestamp === 0) {
        if (user.deposits && Array.isArray(user.deposits)) {
            const paidDep = user.deposits.find(d => d.status === 'PAID');
            if (paidDep && paidDep.date) {
                let parsedTime = Date.parse(paidDep.date);
                if (!isNaN(parsedTime)) startTimestamp = parsedTime;
            }
        }
    }
    if (!startTimestamp || startTimestamp === 0) startTimestamp = Date.now();
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
        if (seenUsers.has(refUser.id)) break;
        seenUsers.add(refUser.id);

        const commUsdt = usdtAmount * rates[lvl - 1];
        const commTrx = commUsdt / trxPrice;

        refUser.balance += commTrx;
        refUser.refEarnings[`level${lvl}`] = (refUser.refEarnings[`level${lvl}`] || 0) + commTrx;
        refUser.markModified('refEarnings');

        if (!refUser.referrals[`level${lvl}`]) refUser.referrals[`level${lvl}`] = [];
        let refList = refUser.referrals[`level${lvl}`];
        let existingRefIndex = refList.findIndex(r => (typeof r === 'string' ? r === depositingUserId : r.id === depositingUserId));

        if (existingRefIndex !== -1) {
            if (typeof refList[existingRefIndex] === 'string') {
                refList[existingRefIndex] = { id: depositingUserId, joinedDate: 'Active', bonusEarned: commTrx };
            } else {
                refList[existingRefIndex].bonusEarned = (Number(refList[existingRefIndex].bonusEarned) || 0) + commTrx;
            }
        } else {
            refList.push({ id: depositingUserId, joinedDate: 'Active', bonusEarned: commTrx });
        }
        refUser.markModified(`referrals.level${lvl}`);
        await refUser.save();

        sendTelegramMessage(refUser.id, `🎁 Received +${commTrx.toFixed(4)} TRX ($${commUsdt.toFixed(2)} USDT) (${rates[lvl - 1] * 100}% Level ${lvl} Referral Commission)!`);
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
        try {
            const o = reqDoc.toObject();
            delete o._id; delete o.__v;
            await PendingRequest.create(o);
        } catch (e2) {}
        return { ok: false, message: "Error: " + err.message };
    }
}

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
    } catch (err) {}
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
                if (match && match[1]) referrerId = String(match[1]).trim();

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

                if (user.referredBy) await registerReferral(user);

                const welcomeCaption = `🎉 <b>Welcome to TRON RICH 🔥!</b>\n\n<i>Mine TRX &amp; Crypto, invite friends and withdraw instantly.</i>\n\n⛏️ Start mining with free power\n🎁 Buy plans &amp; earn daily profit\n👥 Invite friends &amp; earn 3-level commission\n💸 Withdraw straight to your wallet\n\n👇 <b>Join our official channel below!</b>`;
                const startPhotoUrl = "https://cryptologos.cc/logos/tron-trx-logo.png?v=032";
                const webAppMarkup = { inline_keyboard: [[{ text: "📢 Join Official Channel", url: "https://t.me/unitedPay115" }]] };
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
    } catch (err) {}
}

app.post(`/api/webhook/${BOT_TOKEN}`, handleWebhookLogic);
app.post('/webhook', handleWebhookLogic);
app.post('/api/webhook/*', handleWebhookLogic);

app.get('/health', (req, res) => { res.type('text').send('ok'); });
app.get('/', (req, res) => { res.send(`<h1>TRON RICH Mining Backend Active</h1>`); });

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
    if (loginBlocked(ip)) return res.send(`<script>alert('Too many attempts.'); window.location.href='/admin/login';</script>`);
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
        searchedUser = await User.findOne({ $or: [{ id: searchId }, { username: cleanName }, { username: '@' + cleanName }] });
        if (searchedUser) {
            if (searchedUser.deposits) {
                searchedUser.deposits.forEach(d => { if (d.status === 'PAID') userTotalDepositUsdt += parseFloat(d.usdtAmount || 1); });
            }
            if (searchedUser.withdrawals) {
                searchedUser.withdrawals.forEach(w => { if (w.status === 'PAID') { userTotalWithdrawTrx += parseFloat(w.amount || 0); userPaidWithdrawCount++; } });
            }
            totalRefEarn = (searchedUser.refEarnings?.level1 || 0) + (searchedUser.refEarnings?.level2 || 0) + (searchedUser.refEarnings?.level3 || 0);
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
                <div><a href="/admin/logout" class="logout-btn">Logout</a></div>
            </div>
            <div style="background: #1c1917; border: 1px solid #292524; border-radius: 10px; padding: 10px 15px; margin-bottom: 15px; font-size: 13px; color: #f0b94d; display: flex; justify-content: space-between; align-items: center;">
                <span>📈 <b>Live TRX Price:</b> $${liveTrxPrice.toFixed(4)} USDT</span>
                <span style="font-size: 11px; color: #a8a29e;">Auto-updated</span>
            </div>
            <div class="stats-grid">
                <div class="stat-card"><div class="stat-title">Total Users</div><div class="stat-value">${totalUsers}</div></div>
                <div class="stat-card"><div class="stat-title">Total User Deposit</div><div class="stat-value">${totalGlobalDepositUsdt.toFixed(2)} USDT</div></div>
                <div class="stat-card"><div class="stat-title">Active Plan Users</div><div class="stat-value">${activeDepositUsersCount} Users</div></div>
                <div class="stat-card"><div class="stat-title">Paid Out</div><div class="stat-value">${totalPaidOut.toFixed(2)} TRX</div></div>
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
                    <h3>👥 Active Users ($1+ Deposits)</h3>
                    ${activeDepositUsersList.length === 0 ? `<p style="font-size:12px; color:#a8a29e;">No active plan users found.</p>` : `
                        <table>
                            <tr><th>User ID</th><th>Username</th><th>Total Deposit</th><th>GHS Power</th><th>Plan Expiry</th></tr>
                            ${activeDepositUsersList.map(depUser => {
                                let depTotalUsdt = 0;
                                if (depUser.deposits) depUser.deposits.forEach(d => { if (d.status === 'PAID') depTotalUsdt += parseFloat(d.usdtAmount || 1); });
                                return `<tr><td><code>${esc(depUser.id)}</code></td><td>${esc(depUser.username)}</td><td><b>${depTotalUsdt.toFixed(2)} USDT</b></td><td><b>${depUser.ghs} GHS</b></td><td><b>${getPlanDaysFormat(depUser)}</b></td></tr>`;
                            }).join('')}
                        </table>
                    `}
                </div>
            </div>
            <div id="tab-search" class="tab-content">
                <div class="card">
                    <h3>🔍 Search User & Manage</h3>
                    <form method="GET" action="/admin/dashboard" class="search-box">
                        <input type="text" name="search" placeholder="Enter Telegram User ID or Username" value="${esc(searchId)}">
                        <button type="submit" class="btn">Search</button>
                    </form>
                    ${searchedUser ? `
                        <div class="user-details-box">
                            <p>👤 <b>User:</b> ${esc(searchedUser.username)} | <b>ID:</b> <code>${esc(searchedUser.id)}</code></p>
                            <p>💰 <b>Balance:</b> ${searchedUser.balance.toFixed(4)} TRX | ⚡ <b>GHS:</b> ${searchedUser.ghs} GHS</p>
                            <hr style="border-color:#292524; margin:12px 0;">
                            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                                <input type="number" id="mod-amt" placeholder="Amount" style="flex:1; min-width:140px;">
                                <button class="btn btn-green" onclick="modifyBal('${esc(searchedUser.id)}', 'add')">+ Add</button>
                                <button class="btn btn-red" onclick="modifyBal('${esc(searchedUser.id)}', 'cut')">- Cut</button>
                                <button class="btn btn-blue" onclick="togglePlan('${esc(searchedUser.id)}', 'activate')">⚡ Activate Plan</button>
                                <button class="btn btn-red" onclick="togglePlan('${esc(searchedUser.id)}', 'deactivate')">❌ Deactivate</button>
                            </div>
                        </div>
                    ` : searchId ? `<p style="color:#ef4444; font-size:12px;">User not found!</p>` : ''}
                </div>
            </div>
            <div id="tab-requests" class="tab-content">
                <div class="card">
                    <h3>⏳ Pending Requests</h3>
                    ${requests.length === 0 ? `<p style="font-size:12px; color:#a8a29e;">No pending requests.</p>` : `
                        <table>
                            <tr><th>Type</th><th>User</th><th>Coin</th><th>Amount</th><th>Action</th></tr>
                            ${requests.map(r => `<tr><td>${r.type}</td><td><code>${esc(r.userId)}</code></td><td>${r.coinSymbol || 'TRX'}</td><td><b>${reqAmountLabel(r)}</b></td><td><button class="btn btn-green" onclick="handleReq('${r.reqId}', 'approve')">Approve</button> <button class="btn btn-red" onclick="handleReq('${r.reqId}', 'reject')">Reject</button></td></tr>`).join('')}
                        </table>
                    `}
                </div>
            </div>
            <div id="tab-broadcast" class="tab-content">
                <div class="card">
                    <h3>📢 Broadcast</h3>
                    <input type="text" id="bc-photo" placeholder="Image URL (Optional)" style="margin-bottom:10px;">
                    <textarea id="bc-msg" placeholder="Message..."></textarea>
                    <button class="btn" style="margin-top:10px; width:100%;" onclick="sendBroadcast()">Send</button>
                </div>
            </div>
            <script>
                function switchTab(tabId, el) {
                    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
                    document.querySelectorAll('.nav-tab').forEach(nt => nt.classList.remove('active'));
                    document.getElementById(tabId).classList.add('active');
                    el.classList.add('active');
                }
                if (${searchIdJs} !== '') switchTab('tab-search', document.querySelectorAll('.nav-tab')[1]);
                async function postJson(url, body) { let r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}); return await r.json(); }
                async function handleReq(reqId, action) { let d = await postJson('/admin/action', {reqId, action}); alert(d.message); location.reload(); }
                async function modifyBal(userId, action) { let amount = document.getElementById('mod-amt').value; let d = await postJson('/admin/manage-balance', {userId, amount, action}); alert(d.message); location.reload(); }
                async function togglePlan(userId, action) { let d = await postJson('/admin/manage-plan', {userId, action}); alert(d.message); location.reload(); }
                async function sendBroadcast() { let message = document.getElementById('bc-msg').value; let photoUrl = document.getElementById('bc-photo').value; let d = await postJson('/admin/broadcast', {message, photoUrl}); alert(d.message); }
            </script>
        </body>
        </html>
    `);
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
        res.json({ success: true, message: `Plan activated!` });
    } else {
        u.planActive = false;
        u.ghs = 0;
        u.planStartDate = 0;
        u.planExpiryDate = 0;
        await u.save();
        res.json({ success: true, message: `Plan deactivated!` });
    }
});

app.post('/admin/action', checkAdminAuth, async (req, res) => {
    const { reqId, action } = req.body;
    const result = await processRequest(String(reqId), action);
    res.status(result.ok ? 200 : 404).json({ success: result.ok, message: result.message });
});

app.post('/admin/manage-balance', checkAdminAuth, async (req, res) => {
    const { userId, amount, action } = req.body;
    let u = await User.findOne({ id: userId });
    if (!u) return res.status(404).json({ success: false, message: "User not found!" });
    let amt = parseFloat(amount);
    if (!(amt > 0)) return res.status(400).json({ success: false, message: "Invalid amount!" });
    if (action === 'add') u.balance += amt;
    else u.balance = Math.max(0, u.balance - amt);
    await u.save();
    res.json({ success: true, message: `Success!` });
});

app.post('/admin/broadcast', checkAdminAuth, async (req, res) => {
    const { message, photoUrl } = req.body;
    const users = await User.find({});
    for (let u of users) {
        if (photoUrl) await sendTelegramPhoto(u.id, photoUrl, esc(message || ''));
        else if (message) await sendTelegramMessage(u.id, esc(message));
    }
    res.json({ success: true, message: `Broadcast sent!` });
});

// ================== MINI APP API ==================
const teamCache = new Map();
async function getTeamStats(user) {
    const hit = teamCache.get(user.id);
    if (hit && Date.now() - hit.time < 15000) return hit.data;
    const idsByLevel = ['level1', 'level2', 'level3'].map(l => ((user.referrals && user.referrals[l]) || []).map(r => String(typeof r === 'string' ? r : r.id)));
    const allIds = [].concat.apply([], idsByLevel).slice(0, 3000);
    const info = {};
    if (allIds.length) {
        const docs = await User.find({ id: { $in: allIds } }, 'id deposits withdrawals');
        docs.forEach(d => {
            let dep = 0, hasDep = false, hasWd = false;
            (d.deposits || []).forEach(x => { if (x.status === 'PAID') { hasDep = true; dep += Number(x.usdtAmount) || 0; } });
            (d.withdrawals || []).forEach(x => { if (x.status === 'PAID') hasWd = true; });
            info[d.id] = { dep, hasDep, hasWd };
        });
    }
    const out = { registered: [0, 0, 0], active: [0, 0, 0], depositsUsd: 0, firstDeposits: 0, firstWithdrawals: 0 };
    idsByLevel.forEach((ids, i) => {
        ids.forEach(id => {
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

    if (user && user.isBanned) return res.status(403).json({ success: false, isBanned: true, message: "Banned" });

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
            data.referrals[lvl] = data.referrals[lvl].map(r => ({
                id: r.id || r,
                joinedDate: r.joinedDate || 'Active',
                bonusEarned: Number(r.bonusEarned || 0)
            }));
        }
    });

    data.team = await getTeamStats(user);
    
    // Direct TRX mining calculation for frontend dashboard
    data.pendingTrx = Number(user.accruedTrx || 0) + accrueTrx(user, now);
    data.dailyTrx = dailyTrxRate(user, now);
    data.paidPlan = isPaidPlanActive(user, now);
    data.trxPrice = price;
    res.json(data);
});

app.get('/api/quote', async (req, res) => {
    const sym = parseCoinSymbol(req.query.coin || 'TRX');
    const price = await getCoinPriceUsd(sym);
    if (!(price > 0)) return res.status(503).json({ success: false, message: `Unavailable` });

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

app.post('/api/claim', requireTg, async (req, res) => {
    const userId = req.tgId;
    const u = await User.findOne({ id: userId });
    if (!u || u.isBanned) return res.status(400).json({ success: false, message: "User not found or banned" });

    const now = Date.now();
    const trxAmount = Number(u.accruedTrx || 0) + accrueTrx(u, now);
    if (!(trxAmount > 0)) return res.status(400).json({ success: false, message: "Nothing to collect yet" });

    const price = await getTrxPrice();

    const updated = await User.findOneAndUpdate(
        { id: userId, lastClaimTime: u.lastClaimTime },
        { $inc: { balance: trxAmount }, $set: { accruedTrx: 0, lastClaimTime: now } },
        { new: true }
    );
    if (!updated) return res.status(409).json({ success: false, message: "Please try again." });

    res.json({
        success: true,
        balance: updated.balance,
        lastClaimTime: updated.lastClaimTime,
        claimedTrx: trxAmount,
        trxPrice: price
    });
});

app.post('/api/deposit', requireTg, async (req, res) => {
    const userId = req.tgId;
    const { amount, usdtAmount, coin, txHash } = req.body;
    if (!txHash) return res.status(400).json({ success: false, message: "Invalid deposit data." });

    const cleanTxHash = String(txHash).trim();
    if (await PendingRequest.findOne({ txHash: cleanTxHash }) || await User.findOne({ "deposits.txHash": cleanTxHash })) {
        return res.status(400).json({ success: false, message: "TxHash already used!" });
    }

    let u = await User.findOne({ id: userId });
    if (!u) u = new User({ id: userId, username: req.tgName });

    const coinRaw = String(coin || 'TRX (TRC-20)').slice(0, 60);
    const sym = parseCoinSymbol(coinRaw);
    let exactUsdtVal = Number(usdtAmount) > 0 ? Number(usdtAmount) : 1;

    const price = await getCoinPriceUsd(sym);
    if (!(price > 0)) return res.status(503).json({ success: false, message: "Price unavailable" });

    const liveAmount = roundCoin(exactUsdtVal / price, sym);
    const clientAmount = parseFloat(String(amount || '').replace(/,/g, ''));
    const coinAmount = (clientAmount > 0 && Math.abs(clientAmount - liveAmount) / liveAmount <= 0.15) ? roundCoin(clientAmount, sym) : liveAmount;
    const amountStr = `${fmtCoin(coinAmount, sym)} ${sym}`;

    const reqId = 'dep_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    u.deposits.unshift({
        id: reqId, amount: amountStr, coinAmount, coinSymbol: sym, usdtAmount: exactUsdtVal, coin: coinRaw, txHash: cleanTxHash, status: 'PENDING', date: new Date().toLocaleDateString()
    });
    u.markModified('deposits');
    await u.save();

    const reqDoc = await PendingRequest.create({
        reqId, type: 'deposit', userId, username: u.username, amount: amountStr, usdtAmount: exactUsdtVal, coin: coinRaw, coinSymbol: sym, coinAmount, price, usdValue: exactUsdtVal, txHash: cleanTxHash, status: 'PENDING'
    });
    await sendRequestToAdmin(reqDoc);

    res.json({ success: true, message: "Deposit submitted", amount: amountStr, coinAmount, coinSymbol: sym });
});

app.post('/api/withdraw', requireTg, async (req, res) => {
    const userId = req.tgId;
    const { amount, address, trxAmount, coin } = req.body;
    if (!address || String(address).trim().length < 10) return res.status(400).json({ success: false, message: "Invalid address" });
    const cleanAddress = String(address).trim();

    const coinRaw = String(coin || 'TRX (TRC-20)').slice(0, 60);
    const sym = parseCoinSymbol(coinRaw);
    const trxPrice = await getTrxPrice();
    const coinPrice = await getCoinPriceUsd(sym);

    let trxAmt = parseFloat(trxAmount) > 0 ? parseFloat(trxAmount) : (parseFloat(amount) * coinPrice) / trxPrice;
    trxAmt = Number(trxAmt.toFixed(8));
    if (!(trxAmt >= MIN_WITHDRAW_TRX)) return res.status(400).json({ success: false, message: `Minimum withdrawal is ${MIN_WITHDRAW_TRX} TRX` });

    let u = await User.findOne({ id: userId });
    if (!u || u.isBanned) return res.status(403).json({ success: false, message: "Banned or not found" });

    if (await PendingRequest.findOne({ userId, type: 'withdraw', status: 'PENDING' })) {
        return res.status(400).json({ success: false, message: "Pending withdrawal exists" });
    }

    const reqId = 'wd_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const usdValue = trxAmt * trxPrice;
    const coinAmount = sym === 'TRX' ? roundCoin(trxAmt, 'TRX') : roundCoin(usdValue / coinPrice, sym);

    const updated = await User.findOneAndUpdate(
        { id: userId, isBanned: { $ne: true }, balance: { $gte: trxAmt } },
        { $inc: { balance: -trxAmt }, $push: { withdrawals: { $each: [{ id: reqId, amount: trxAmt, coin: coinRaw, coinSymbol: sym, coinAmount, usdValue, address: cleanAddress, status: 'PENDING', date: new Date().toLocaleDateString() }], $position: 0 } } },
        { new: true }
    );
    if (!updated) return res.status(400).json({ success: false, message: "Insufficient balance" });

    const reqDoc = await PendingRequest.create({
        reqId, type: 'withdraw', userId, username: updated.username, amount: `${fmtCoin(coinAmount, sym)} ${sym}`, coin: coinRaw, coinSymbol: sym, coinAmount, trxAmount: trxAmt, usdValue, price: coinPrice, address: cleanAddress, status: 'PENDING'
    });
    await sendRequestToAdmin(reqDoc);

    res.json({ success: true, message: "Withdrawal submitted", newBalance: updated.balance, coinAmount, coinSymbol: sym });
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
