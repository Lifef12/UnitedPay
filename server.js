const express = require('express');
const mongoose = require('mongoose');
const app = express();

// ================== SETTINGS ==================
const BOT_TOKEN = "9105730060:AAEwFpaNJ7ZsV-aOEUDH3CyY2jpbjG9oWqc";
const ADMIN_ID = "7482625921";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "nbx12345";
const VERCEL_APP_URL = process.env.VERCEL_APP_URL || "https://unitedpay-app.vercel.app/";

// ================== MINING & VIP RULES ==================
const PLAN_DURATION_MS = 365 * 24 * 60 * 60 * 1000; // 365 Days validity as per UnitedPay UI

let bnbPriceCache = { price: 620, time: 0 };
async function getBnbPrice() {
    if (Date.now() - bnbPriceCache.time < 60000) return bnbPriceCache.price;
    try {
        const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=USDTUSDT');
        const d = await r.json();
        const p = 1.0; // USDT stable price peg
        if (p > 0) { bnbPriceCache = { price: p, time: Date.now() }; return p; }
    } catch (e) {}
    return 1.0;
}

// ================== DATABASE SCHEMA ==================
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas Successfully!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },
    rechargePool: { type: Number, default: 0 },
    totalRecharge: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    unlockedPlans: { type: Array, default: [1] }, // Default VIP-1 unlocked
    deposits: { type: Array, default: [] },
    withdrawals: { type: Array, default: [] },
    isBanned: { type: Boolean, default: false },
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
    type: { type: String, required: true }, // 'Recharge' or 'Withdrawal'
    userId: { type: String, required: true },
    amount: { type: Number, required: true },
    txHash: { type: String },
    address: { type: String },
    status: { type: String, default: 'Pending' }
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

async function editTelegramMessage(chatId, messageId, text, replyMarkup = null) {
    try {
        let body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'Markdown' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (e) {
        console.log("Telegram Edit Error:", e);
    }
}

async function answerCallbackQuery(callbackQueryId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text: text })
        });
    } catch (e) {
        console.log("Callback Answer Error:", e);
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
                await sendTelegramMessage(chatId, "⚠️ *Access Denied:* Your account has been banned by the admin.");
                return;
            }

            if (text.startsWith('/start')) {
                let referrerId = null;
                const match = text.match(/\/start\s+(\d+)/);
                if (match && match[1]) {
                    referrerId = String(match[1]).trim();
                }

                if (!user) {
                    user = new User({
                        id: chatId,
                        username: msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'User'),
                        referredBy: (referrerId && referrerId !== chatId) ? referrerId : null
                    });
                    await user.save();
                }

                const welcomeCaption = `🎉 *Welcome to UnitedPay - AI Investment & Cloud Mining!*\n\nInvest daily, complete tasks, invite friends, and enjoy high-yield automated returns.`;
                const startPhotoUrl = "https://i.ibb.co/JR4RRkb7/file-00000000abd481f48234067ed5a24c85.png";

                const webAppMarkup = {
                    inline_keyboard: [
                        [{ text: "🚀 Open UnitedPay App", web_app: { url: VERCEL_APP_URL } }],
                        [{ text: "📢 Official Channel", url: "https://t.me/UnitedPayBot" }]
                    ]
                };

                await sendTelegramPhoto(chatId, startPhotoUrl, welcomeCaption, webAppMarkup);
            }
        } else if (update.callback_query) {
            const query = update.callback_query;
            const chatId = String(query.message.chat.id);
            const data = query.data;
            const messageId = query.message.message_id;

            if (data.startsWith('approve_') || data.startsWith('reject_')) {
                if (chatId !== String(ADMIN_ID)) return answerCallbackQuery(query.id, "Unauthorized!");

                const isApprove = data.startsWith('approve_');
                const reqId = data.replace(isApprove ? 'approve_' : 'reject_', '');

                const reqDoc = await PendingRequest.findOneAndDelete({ reqId });
                if (!reqDoc) return answerCallbackQuery(query.id, "Request already handled!");

                const u = await User.findOne({ id: reqDoc.userId });

                if (isApprove) {
                    reqDoc.status = 'Approved';
                    if (reqDoc.type === 'Recharge' && u) {
                        u.rechargePool += reqDoc.amount;
                        u.totalRecharge += reqDoc.amount;
                        u.deposits.unshift({ id: reqId, amount: reqDoc.amount, txHash: reqDoc.txHash, status: 'Approved', date: new Date().toLocaleString() });
                        u.markModified('deposits');
                        await u.save();
                        sendTelegramMessage(reqDoc.userId, `✅ Your recharge of $${reqDoc.amount} USDT has been approved and added to your recharge pool!`);
                    } else if (reqDoc.type === 'Withdrawal' && u) {
                        u.totalWithdrawn += reqDoc.amount;
                        u.withdrawals.unshift({ id: reqId, amount: reqDoc.amount, address: reqDoc.address, status: 'Approved', date: new Date().toLocaleString() });
                        u.markModified('withdrawals');
                        await u.save();
                        sendTelegramMessage(reqDoc.userId, `✅ Your withdrawal of $${reqDoc.amount} USDT has been approved and sent!`);
                    }
                    editTelegramMessage(chatId, messageId, `✅ **Request Approved**\nUser ID: ${reqDoc.userId}\nAmount: $${reqDoc.amount}`);
                } else {
                    reqDoc.status = 'Rejected';
                    if (reqDoc.type === 'Withdrawal' && u) {
                        u.balance += reqDoc.amount; // Refund balance
                        u.withdrawals.unshift({ id: reqId, amount: reqDoc.amount, address: reqDoc.address, status: 'Rejected', date: new Date().toLocaleString() });
                        u.markModified('withdrawals');
                        await u.save();
                        sendTelegramMessage(reqDoc.userId, `❌ Your withdrawal request of $${reqDoc.amount} USDT was rejected and funds refunded.`);
                    } else if (reqDoc.type === 'Recharge' && u) {
                        u.deposits.unshift({ id: reqId, amount: reqDoc.amount, txHash: reqDoc.txHash, status: 'Rejected', date: new Date().toLocaleString() });
                        u.markModified('deposits');
                        await u.save();
                        sendTelegramMessage(reqDoc.userId, `❌ Your recharge request of $${reqDoc.amount} USDT was rejected.`);
                    }
                    editTelegramMessage(chatId, messageId, `❌ **Request Rejected**\nUser ID: ${reqDoc.userId}\nAmount: $${reqDoc.amount}`);
                }
                answerCallbackQuery(query.id, "Done!");
            }
        }
    } catch (err) {
        console.log("Webhook error:", err);
    }
}

app.post(`/api/webhook/${BOT_TOKEN}`, handleWebhookLogic);
app.post('/webhook', handleWebhookLogic);

app.get('/', (req, res) => {
    res.send(`<h1>UnitedPay Backend Active</h1><p>Running successfully.</p>`);
});

// ================== MINI APP API ENDPOINTS ==================
app.get('/api/user/:userId', async (req, res) => {
    const userId = String(req.params.userId);
    let user = await User.findOne({ id: userId });
    if (!user) {
        user = new User({ id: userId, username: 'User' });
        await user.save();
    }
    if (user.isBanned) {
        return res.status(403).json({ success: false, isBanned: true, message: "Account banned." });
    }
    res.json(user.toObject());
});

app.post('/api/deposit', async (req, res) => {
    const { userId, amount, usdtAmount, txHash } = req.body;
    if (!userId || !amount || !txHash) return res.status(400).json({ success: false, message: "Invalid data" });

    let u = await User.findOne({ id: userId });
    if (!u) u = new User({ id: userId });

    const reqId = 'dep_' + Date.now();
    await PendingRequest.create({
        reqId,
        type: 'Recharge',
        userId,
        amount: parseFloat(amount),
        txHash: txHash.trim(),
        status: 'Pending'
    });

    if (ADMIN_ID) {
        const msgText = `📥 **New Recharge Request**\n\n👤 User ID: \`${userId}\`\n💰 Amount: **$${amount} USDT**\n🔑 TxHash: \`${txHash}\``;
        const inlineKeyboard = {
            inline_keyboard: [[
                { text: "✅ Approve", callback_data: `approve_${reqId}` },
                { text: "❌ Reject", callback_data: `reject_${reqId}` }
            ]]
        };
        await sendTelegramMessage(ADMIN_ID, msgText, inlineKeyboard);
    }

    res.json({ success: true, message: "Recharge submitted successfully" });
});

app.post('/api/withdraw', async (req, res) => {
    const { userId, amount, address } = req.body;
    let amt = parseFloat(amount);
    if (!userId || !amt || amt <= 0 || !address) return res.status(400).json({ success: false, message: "Invalid withdrawal data" });

    let u = await User.findOne({ id: userId });
    if (!u || u.balance < amt) return res.status(400).json({ success: false, message: "Insufficient balance" });

    u.balance -= amt; // Deduct temporarily
    await u.save();

    const reqId = 'wd_' + Date.now();
    await PendingRequest.create({
        reqId,
        type: 'Withdrawal',
        userId,
        amount: amt,
        address: address.trim(),
        status: 'Pending'
    });

    if (ADMIN_ID) {
        const msgText = `📤 **New Withdrawal Request**\n\n👤 User ID: \`${userId}\`\n💰 Amount: **$${amt} USDT**\n🏦 Address: \`${address}\``;
        const inlineKeyboard = {
            inline_keyboard: [[
                { text: "✅ Approve", callback_data: `approve_${reqId}` },
                { text: "❌ Reject", callback_data: `reject_${reqId}` }
            ]]
        };
        await sendTelegramMessage(ADMIN_ID, msgText, inlineKeyboard);
    }

    res.json({ success: true, message: "Withdrawal submitted successfully", newBalance: u.balance });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL && BOT_TOKEN) {
        try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${RENDER_URL}/api/webhook/${BOT_TOKEN}`);
            console.log("Telegram Webhook Set Successfully!");
        } catch (e) {
            console.log("Failed to set webhook:", e);
        }
    }
});
