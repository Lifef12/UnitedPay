const express = require('express');
const mongoose = require('mongoose');
const app = express();

// ================== SETTINGS ==================
const BOT_TOKEN = "9107042388:AAFv0PnNLBlHiGfcX4Xd09TghNuwOojFcpU";
const ADMIN_ID = "7482625921";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "nbx12345";
const VERCEL_APP_URL = "https://bnb-smart-miner-2.vercel.app/";

// ================== MINING RULES ==================
const PLAN_DURATION_MS = 10 * 24 * 60 * 60 * 1000;
const PAID_RATE_PER_GHS_USD = 0.30;
const FREE_DAILY_USD = 0.01;

let bnbPriceCache = { price: 620, time: 0 };
async function getBnbPrice() {
    if (Date.now() - bnbPriceCache.time < 60000) return bnbPriceCache.price;
    try {
        const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
        const d = await r.json();
        const p = parseFloat(d.price);
        if (p > 0) { bnbPriceCache = { price: p, time: Date.now() }; return p; }
    } catch (e) {}
    try {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd');
        const d = await r.json();
        const p = Number(d && d.binancecoin && d.binancecoin.usd);
        if (p > 0) { bnbPriceCache = { price: p, time: Date.now() }; return p; }
    } catch (e) {}
    return bnbPriceCache.price;
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
    const accrued = accrueUsd(u, now);
    u.accruedUsd = Number(u.accruedUsd || 0) + accrued;
    u.totalMinedUsd = Number(u.totalMinedUsd || 0) + accrued;
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
    totalMinedUsd: { type: Number, default: 0 },
    totalWithdrawnBnb: { type: Number, default: 0 },
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
    amount: { type: String, required: true },
    usdtAmount: { type: Number, default: 1 },
    coin: { type: String },
    txHash: { type: String },
    address: { type: String },
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
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

const activeSessions = new Set();

function checkAdminAuth(req, res, next) {
    const sessionToken = req.cookies.admin_session;
    if (sessionToken && activeSessions.has(sessionToken)) {
        return next();
    }
    return res.redirect('/admin/login');
}

// ================== TELEGRAM HELPERS ==================
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
    try {
        let body = { chat_id: chatId, text: text, parse_mode: 'Markdown' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (e) {
        console.log("Telegram API Error:", e);
    }
}

async function sendTelegramPhoto(chatId, photoUrl, caption = '', replyMarkup = null) {
    try {
        let body = { chat_id: chatId, photo: photoUrl, caption: caption, parse_mode: 'Markdown' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (e) {
        console.log("Telegram Photo Broadcast Error:", e);
    }
}

setInterval(async () => {
    try {
        const currentTime = Date.now();
        const expiredUsers = await User.find({
            planActive: true,
            planExpiryDate: { $gt: 0,$lte: currentTime }
        });

        for (let u of expiredUsers) {
            expireUserPlan(u, currentTime);
            await u.save();
            sendTelegramMessage(u.id, `❌ *Plan Expired:* Your plan was expired plzz renew plan agin 🚀`);
        }
    } catch (err) {
        console.log("Background Plan Expiry Error:", err);
    }
}, 5 * 60 * 1000);

function getPlanDaysFormat(user) {
    if (!user.planActive || user.ghs <= 0) return "N/A";
    let startTimestamp = user.planStartDate || Date.now();
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

async function payReferralCommissions(depositUser, usdtAmount) {
    const rates = [0.15, 0.03, 0.01];
    let current = depositUser;
    const bnbPrice = await getBnbPrice();
    const depositingUserId = depositUser.id;

    for (let lvl = 1; lvl <= 3; lvl++) {
        if (!current.referredBy) break;
        const refUser = await User.findOne({ id: current.referredBy });
        if (!refUser) break;

        const commUsdt = usdtAmount * rates[lvl - 1];
        const commBnb = commUsdt / bnbPrice;

        refUser.balance += commBnb;
        refUser.refEarnings[`level${lvl}`] = (refUser.refEarnings[`level${lvl}`] || 0) + commBnb;
        refUser.markModified('refEarnings');

        if (!refUser.referrals[`level${lvl}`]) {
            refUser.referrals[`level${lvl}`] = [];
        }
        
        let refList = refUser.referrals[`level${lvl}`];
        let existingRefIndex = refList.findIndex(r => (typeof r === 'string' ? r === depositingUserId : r.id === depositingUserId));

        if (existingRefIndex !== -1) {
            if (typeof refList[existingRefIndex] === 'string') {
                refList[existingRefIndex] = { id: depositingUserId, joinedDate: 'Active', bonusEarned: commBnb };
            } else {
                refList[existingRefIndex].bonusEarned = (Number(refList[existingRefIndex].bonusEarned) || 0) + commBnb;
            }
        } else {
            refList.push({ id: depositingUserId, joinedDate: 'Active', bonusEarned: commBnb });
        }
        refUser.markModified(`referrals.level${lvl}`);
        await refUser.save();

        sendTelegramMessage(refUser.id, `🎁 Received +${commBnb.toFixed(4)} BNB ($${commUsdt.toFixed(2)} USDT) (${rates[lvl - 1] * 100}% Level ${lvl} Referral Commission)!`);
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

        sendTelegramMessage(reqDoc.userId, `✅ Your deposit of ${reqDoc.amount} has been approved!\n⚡ +${depAmount} GHS Mining Power added.`);
    } else if (reqDoc.type === 'withdraw' && u) {
        setRequestStatus(u.withdrawals, reqId, ['PENDING', 'PEND1NG'], 'PAID');
        u.totalWithdrawnBnb = Number(u.totalWithdrawnBnb || 0) + parseFloat(reqDoc.amount || 0);
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `✅ Your withdrawal of ${reqDoc.amount} BNB has been approved!`);
    }
}

async function rejectRequest(reqDoc, u, reqId) {
    if (reqDoc.type === 'deposit' && u) {
        setRequestStatus(u.deposits, reqId, ['PENDING'], 'DECLINED');
        u.markModified('deposits');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `❌ Your deposit request was declined.`);
    } else if (reqDoc.type === 'withdraw' && u) {
        u.balance += parseFloat(reqDoc.amount);
        setRequestStatus(u.withdrawals, reqId, ['PENDING', 'PEND1NG'], 'DECLINED');
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `❌ Your withdrawal request was declined and funds refunded.`);
    }
}

// ================== TELEGRAM WEBHOOK ==================
async function handleWebhookLogic(req, res) {
    const update = req.body;
    res.sendStatus(200);

    try {
        if (update.message) {
            const msg = update.message;
            const chatId = String(msg.chat.id);
            const text = msg.text || '';

            let user = await User.findOne({ id: chatId });
            if (user && user.isBanned) {
                await sendTelegramMessage(chatId, "⚠️ *Access Denied:* Your account has been banned.");
                return;
            }

            if (text.startsWith('/start')) {
                let referrerId = null;
                const match = text.match(/\/start\s+(\d+)/);
                if (match && match[1]) referrerId = String(match[1]).trim();

                if (!user) {
                    user = new User({
                        id: chatId,
                        username: msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'User'),
                        referredBy: (referrerId && referrerId !== chatId) ? referrerId : null
                    });
                    await user.save();
                }

                const welcomeCaption = `🎉 *Welcome to BNB Smart Miner!*\n\n⛏️ _Mine BNB, invite friends & earn rewards._`;
                const startPhotoUrl = "https://i.ibb.co/jk5thdjj/file-000000003e3481f49aa5f2b114415564.png";
                const webAppMarkup = {
                    inline_keyboard: [
                        [{ text: "📢 Join Official Channel", url: "https://t.me/Bnbsmartminer1" }],
                        [{ text: "💸 Join Payment Channel", url: "https://t.me/paymentschanel12" }]
                    ]
                };
                await sendTelegramPhoto(chatId, startPhotoUrl, welcomeCaption, webAppMarkup);
            }
        }
    } catch (err) {
        console.log("Webhook error:", err);
    }
}

app.post(`/api/webhook/${BOT_TOKEN}`, handleWebhookLogic);
app.post('/webhook', handleWebhookLogic);

app.get('/', (req, res) => {
    res.send(`<h1>BNB Smart Miner Backend Active</h1>`);
});

// ================== WEBSITE ADMIN PANEL ==================
app.get('/admin/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Login - BNB Smart Miner</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { box-sizing: border-box; font-family: 'Segoe UI', sans-serif; }
                body { background: #0c0a09; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .login-card { background: #1c1917; border: 1px solid #292524; padding: 30px; border-radius: 16px; width: 90%; max-width: 360px; text-align: center; }
                h2 { color: #38bdf8; margin-bottom: 20px; }
                input { width: 100%; padding: 12px; margin-bottom: 12px; background: #0c0a09; border: 1px solid #44403c; color: #fff; border-radius: 8px; }
                button { width: 100%; padding: 12px; background: #38bdf8; color: #000; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; }
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
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const sessionToken = "token_" + Math.random().toString(36).substring(2) + Date.now();
        activeSessions.add(sessionToken);
        res.setHeader('Set-Cookie', `admin_session=${sessionToken}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
        return res.redirect('/admin/dashboard');
    }
    res.send(`<script>alert('Invalid Credentials!'); window.location.href='/admin/login';</script>`);
});

app.get('/admin/logout', (req, res) => {
    const sessionToken = req.cookies.admin_session;
    if (sessionToken) activeSessions.delete(sessionToken);
    res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Max-Age=0');
    res.redirect('/admin/login');
});

app.get('/admin/dashboard', checkAdminAuth, async (req, res) => {
    const requests = await PendingRequest.find({});
    const totalUsers = await User.countDocuments();
    const allUsers = await User.find({});
    const liveBnbPrice = await getBnbPrice();

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

    let searchId = req.query.search ? req.query.search.trim() : '';
    let searchedUser = null;
    let userTotalDepositUsdt = 0;
    let userTotalWithdrawBnb = 0;
    let userPaidWithdrawCount = 0;
    let totalRefEarn = 0;

    if (searchId) {
        searchedUser = await User.findOne({
            $or: [{ id: searchId }, { username: searchId.replace('@', '') }]
        });

        if (searchedUser) {
            if (searchedUser.deposits) {
                searchedUser.deposits.forEach(d => {
                    if (d.status === 'PAID') userTotalDepositUsdt += parseFloat(d.usdtAmount || 1);
                });
            }
            if (searchedUser.withdrawals) {
                searchedUser.withdrawals.forEach(w => {
                    if (w.status === 'PAID') {
                        userTotalWithdrawBnb += parseFloat(w.amount || 0);
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

    let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>BNB Smart Miner Admin Panel</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
                body { background: #0c0a09; color: #f3f4f6; margin: 0; padding: 20px; }
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                .header h1 { color: #38bdf8; margin: 0; font-size: 24px; }
                .logout-btn { background: #ef4444; color: #fff; padding: 6px 12px; border-radius: 6px; text-decoration: none; font-size: 12px; font-weight: bold; }
                .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
                .stat-card { background: #1c1917; border: 1px solid #292524; border-radius: 12px; padding: 15px; text-align: left; }
                .stat-title { font-size: 11px; color: #a8a29e; text-transform: uppercase; }
                .stat-value { font-size: 20px; font-weight: bold; color: #38bdf8; margin-top: 6px; }
                .nav-tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; background: #1c1917; padding: 10px; border-radius: 12px; border: 1px solid #292524; }
                .nav-tab { background: #292524; color: #a8a29e; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: bold; cursor: pointer; }
                .nav-tab.active { background: #38bdf8; color: #000; }
                .tab-content { display: none; }
                .tab-content.active { display: block; }
                .card { background: #1c1917; border: 1px solid #292524; border-radius: 12px; padding: 18px; margin-bottom: 20px; }
                .card h3 { color: #38bdf8; margin-top: 0; font-size: 16px; border-bottom: 1px solid #292524; padding-bottom: 8px; }
                .search-box { display: flex; gap: 10px; margin-bottom: 15px; }
                input, textarea { background: #0c0a09; border: 1px solid #44403c; color: #fff; padding: 10px; border-radius: 8px; width: 100%; font-size: 14px; }
                .btn { background: #38bdf8; color: #000; border: none; font-weight: bold; padding: 10px 18px; border-radius: 8px; cursor: pointer; }
                .btn-green { background: #22c55e; color: #fff; }
                .btn-red { background: #ef4444; color: #fff; }
                .btn-blue { background: #3b82f6; color: #fff; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { padding: 10px; text-align: left; border-bottom: 1px solid #292524; font-size: 12px; }
                th { color: #a8a29e; }
                .user-details-box { background: #0c0a09; padding: 14px; border-radius: 8px; border: 1px solid #292524; margin-top: 10px; font-size: 13px; line-height: 1.8; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>👑 BNB Smart Miner Admin Panel</h1>
                <a href="/admin/logout" class="logout-btn">Logout</a>
            </div>

            <div style="background: #1c1917; border: 1px solid #292524; border-radius: 10px; padding: 10px 15px; margin-bottom: 15px; font-size: 13px; color: #38bdf8; display: flex; justify-content: space-between;">
                <span>📈 <b>Live BNB Price:</b> $${liveBnbPrice.toFixed(2)} USDT</span>
            </div>

            <div class="stats-grid">
                <div class="stat-card"><div class="stat-title">Total Users</div><div class="stat-value">${totalUsers}</div></div>
                <div class="stat-card"><div class="stat-title">Total User Deposit</div><div class="stat-value">${totalGlobalDepositUsdt.toFixed(2)} USDT</div></div>
                <div class="stat-card"><div class="stat-title">Active Plan Users</div><div class="stat-value">${activeDepositUsersCount}</div></div>
                <div class="stat-card"><div class="stat-title">Paid Out</div><div class="stat-value">${totalPaidOut.toFixed(4)} BNB</div></div>
                <div class="stat-card"><div class="stat-title">Pending Requests</div><div class="stat-value">${requests.length}</div></div>
            </div>

            <div class="nav-tabs">
                <div class="nav-tab active" onclick="switchTab('tab-users', this)">👥 Users & Plans</div>
                <div class="nav-tab" onclick="switchTab('tab-search', this)">🔍 Search & Manage User</div>
                <div class="nav-tab" onclick="switchTab('tab-requests', this)">⏳ Pending Requests (${requests.length})</div>
                <div class="nav-tab" onclick="switchTab('tab-broadcast', this)">📢 Broadcast</div>
            </div>

            <div id="tab-users" class="tab-content active">
                <div class="card">
                    <h3>👥 Users With Active Plans</h3>
                    ${activeDepositUsersList.length === 0 ? `<p style="font-size:12px; color:#a8a29e;">No active plan users found.</p>` : `
                        <table>
                            <tr><th>User ID</th><th>Username</th><th>Total Deposit</th><th>GHS Power</th><th>Plan Expiry</th></tr>
                            ${activeDepositUsersList.map(depUser => {
                                let depTotalUsdt = 0;
                                if (depUser.deposits) {
                                    depUser.deposits.forEach(d => { if (d.status === 'PAID') depTotalUsdt += parseFloat(d.usdtAmount || 1); });
                                }
                                return `
                                    <tr>
                                        <td><code>${depUser.id}</code></td>
                                        <td>${depUser.username}</td>
                                        <td><b style="color:#22c55e;">${depTotalUsdt.toFixed(2)} USDT</b></td>
                                        <td><b>${depUser.ghs} GHS</b></td>
                                        <td><b style="color:#38bdf8;">${getPlanDaysFormat(depUser)}</b></td>
                                    </tr>
                                `;
                            }).join('')}
                        </table>
                    `}
                </div>
            </div>

            <div id="tab-search" class="tab-content">
                <div class="card">
                    <h3>🔍 Search User Details & History</h3>
                    <form method="GET" action="/admin/dashboard" class="search-box">
                        <input type="text" name="search" placeholder="Enter Telegram User ID or Username" value="${searchId}">
                        <button type="submit" class="btn">Search</button>
                    </form>
                    ${searchedUser ? `
                        <div class="user-details-box">
                            <p>👤 <b>Username:</b> ${searchedUser.username} \vert{} <b>ID:</b> <code>${searchedUser.id}</code></p>
                            <p>💰 <b>Balance:</b> <span style="color:#38bdf8; font-weight:bold;">${searchedUser.balance.toFixed(4)} BNB</span> \vert{} ⚡ <b>GHS:</b>${searchedUser.ghs}</p>
                            <p>🚫 <b>Status:</b> ${searchedUser.isBanned ? '<span style="color:#ef4444;">BANNED</span>' : '<span style="color:#22c55e;">ACTIVE</span>'}</p>
                            <p>📥 <b>Total Deposit:</b> <span style="color:#22c55e;">${userTotalDepositUsdt.toFixed(2)} USDT</span></p>
                            <p>📤 <b>Total Withdraw:</b> <span style="color:#ef4444;">${userTotalWithdrawBnb.toFixed(4)} BNB</span> (${userPaidWithdrawCount} Times)</p>
                            <p>👥 <b>Referrals:</b> L1: ${searchedUser.referrals?.level1?.length || 0} | L2: ${searchedUser.referrals?.level2?.length \vert{}\vert{} 0} \vert{} L3: ${searchedUser.referrals?.level3?.length || 0}</p>
                            
                            <hr style="border-color:#292524; margin:12px 0;">
                            <b>⚙️ Quick Actions:</b>
                            <div style="display:flex; gap:10px; margin-top:8px; flex-wrap:wrap;">
                                <input type="number" id="mod-amt" placeholder="Amount" style="flex:1; min-width:120px;">
                                <button class="btn btn-green" onclick="modifyBal('${searchedUser.id}', 'add')">+ Add</button>
                                <button class="btn btn-red" onclick="modifyBal('${searchedUser.id}', 'cut')">- Cut</button>
                                <button class="btn btn-blue" onclick="togglePlan('${searchedUser.id}', 'activate')">⚡ Activate Plan</button>
                                <button class="btn btn-red" onclick="toggleBan('${searchedUser.id}', 'ban')">🚫 Ban</button>
                                <button class="btn btn-green" onclick="toggleBan('${searchedUser.id}', 'unban')">✅ Unban</button>
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
                            <tr><th>Type</th><th>User ID</th><th>Amount</th><th>Details</th><th>Action</th></tr>
                            ${requests.map(r => `
                                <tr>
                                    <td style="color:${r.type==='deposit'?'#22c55e':'#ef4444'}; font-weight:bold;">${r.type.toUpperCase()}</td>
                                    <td>${r.userId}</td>
                                    <td><b>${r.amount}</b></td>
                                    <td>${r.txHash ? 'Tx: ' + r.txHash.substring(0,10) + '...' : 'Addr: ' + r.address.substring(0,10) + '...'}</td>
                                    <td>
                                        <button class="btn btn-green" style="padding:4px 8px; font-size:11px;" onclick="handleReq('${r.reqId}', 'approve')">Approve</button>
                                        <button class="btn btn-red" style="padding:4px 8px; font-size:11px;" onclick="handleReq('${r.reqId}', 'reject')">Reject</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </table>
                    `}
                </div>
            </div>

            <div id="tab-broadcast" class="tab-content">
                <div class="card">
                    <h3>📢 Broadcast Message</h3>
                    <input type="text" id="bc-photo" placeholder="Image URL (Optional)" style="margin-bottom:10px;">
                    <textarea id="bc-msg" placeholder="Write message..."></textarea>
                    <button class="btn" style="margin-top:10px; width:100%;" onclick="sendBroadcast()">Send Broadcast</button>
                </div>
            </div>

            <script>
                function switchTab(tabId, el) {
                    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
                    document.querySelectorAll('.nav-tab').forEach(nt => nt.classList.remove('active'));
                    document.getElementById(tabId).classList.add('active');
                    el.classList.add('active');
                }
                if('${searchId}' !== '') { switchTab('tab-search', document.querySelectorAll('.nav-tab')[1]); }

                async function handleReq(reqId, action) {
                    let res = await fetch('/admin/action', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ reqId, action }) });
                    let data = await res.json(); alert(data.message); location.reload();
                }
                async function modifyBal(userId, action) {
                    let amount = document.getElementById('mod-amt').value;
                    if(!amount) return alert("Enter amount!");
                    let res = await fetch('/admin/manage-balance', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ userId, amount, action }) });
                    let data = await res.json(); alert(data.message); location.reload();
                }
                async function togglePlan(userId, action) {
                    let res = await fetch('/admin/manage-plan', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ userId, action }) });
                    let data = await res.json(); alert(data.message); location.reload();
                }
                async function toggleBan(userId, action) {
                    let res = await fetch('/admin/ban-user', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ userId, action }) });
                    let data = await res.json(); alert(data.message); location.reload();
                }
                async function sendBroadcast() {
                    let message = document.getElementById('bc-msg').value;
                    let photoUrl = document.getElementById('bc-photo').value;
                    let res = await fetch('/admin/broadcast', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ message, photoUrl }) });
                    let data = await res.json(); alert(data.message);
                }
            </script>
        </body>
        </html>
    `;
    res.send(html);
});

// Admin Actions Routes
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
        res.json({ success: true, message: `Plan activated successfully!` });
    } else {
        u.planActive = false;
        u.ghs = 0;
        await u.save();
        res.json({ success: true, message: `Plan deactivated successfully!` });
    }
});

app.post('/admin/action', checkAdminAuth, async (req,
