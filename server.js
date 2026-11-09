const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

// ================== SETTINGS ==================
const BOT_TOKEN = "9107042388:AAFv0PnNLBlHiGfcX4Xd09TghNuwOojFcpU";
const ADMIN_ID = "7482625921";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/unitedpay';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "nbx12345";

// ================== MINING & VIP RULES ==================
const PLAN_DURATION_MS = 365 * 24 * 60 * 60 * 1000; // Valid for 365 days

let bnbPriceCache = { price: 620, time: 0 };
async function getBnbPrice() {
    if (Date.now() - bnbPriceCache.time < 60000) return bnbPriceCache.price;
    try {
        const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
        const d = await r.json();
        const p = parseFloat(d.price);
        if (p > 0) { bnbPriceCache = { price: p, time: Date.now() }; return p; }
    } catch (e) {}
    return bnbPriceCache.price;
}

// ================== DATABASE ==================
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Successfully!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },          // Withdrawable Balance ($ USDT)
    rechargePool: { type: Number, default: 0 },     // Recharge Amount Pool ($ USDT)
    totalRecharge: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    unlockedPlans: { type: Array, default: [1] },     // Default VIP-1 unlocked
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
    type: { type: String, required: true }, // 'deposit' or 'withdraw'
    userId: { type: String, required: true },
    amount: { type: Number, required: true },
    txHash: { type: String },
    address: { type: String },
    status: { type: String, default: 'PENDING' }
});
const PendingRequest = mongoose.model('PendingRequest', pendingRequestSchema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

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
        console.log("Telegram Photo Error:", e);
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

// Referral Commission distributor (11% - 2% - 1%)
async function payReferralCommissions(depositUser, usdtAmount) {
    const rates = [0.11, 0.02, 0.01];
    let current = depositUser;
    const depositingUserId = depositUser.id;

    for (let lvl = 1; lvl <= 3; lvl++) {
        if (!current.referredBy) break;
        const refUser = await User.findOne({ id: current.referredBy });
        if (!refUser) break;

        const commUsdt = usdtAmount * rates[lvl - 1];
        refUser.balance += commUsdt;
        refUser.refEarnings[`level${lvl}`] = (refUser.refEarnings[`level${lvl}`] || 0) + commUsdt;
        refUser.markModified('refEarnings');

        if (!refUser.referrals[`level${lvl}`]) {
            refUser.referrals[`level${lvl}`] = [];
        }
        
        let refList = refUser.referrals[`level${lvl}`];
        let existingRefIndex = refList.findIndex(r => (typeof r === 'string' ? r === depositingUserId : r.id === depositingUserId));

        if (existingRefIndex === -1) {
            refList.push({ id: depositingUserId, joinedDate: 'Active', bonusEarned: commUsdt });
        } else {
            refList[existingRefIndex].bonusEarned = (Number(refList[existingRefIndex].bonusEarned) || 0) + commUsdt;
        }
        refUser.markModified(`referrals.level${lvl}`);
        await refUser.save();

        sendTelegramMessage(refUser.id, `🎁 Received +$${commUsdt.toFixed(2)} USDT (${rates[lvl - 1] * 100}% Level ${lvl} Team Commission)!`);
        current = refUser;
    }
}

async function approveRequest(reqDoc, u, reqId) {
    if (reqDoc.type === 'deposit' && u) {
        const depAmount = Number(reqDoc.amount);
        u.rechargePool += depAmount;
        u.totalRecharge += depAmount;
        
        u.deposits.unshift({
            id: reqId,
            type: 'Recharge',
            amount: depAmount,
            date: new Date().toLocaleString(),
            status: 'Approved',
            txHash: reqDoc.txHash
        });
        u.markModified('deposits');
        await u.save();

        await payReferralCommissions(u, depAmount);
        sendTelegramMessage(reqDoc.userId, `✅ Your deposit of $${depAmount} USDT has been approved and added to your recharge pool!`);
    } else if (reqDoc.type === 'withdraw' && u) {
        u.totalWithdrawn = Number(u.totalWithdrawn || 0) + Number(reqDoc.amount);
        u.withdrawals.unshift({
            id: reqId,
            type: 'Withdrawal',
            amount: -Number(reqDoc.amount),
            date: new Date().toLocaleString(),
            status: 'Approved',
            address: reqDoc.address
        });
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `✅ Your withdrawal of $${reqDoc.amount} USDT has been approved!`);
    }
}

async function rejectRequest(reqDoc, u, reqId) {
    if (reqDoc.type === 'deposit' && u) {
        u.deposits.unshift({
            id: reqId,
            type: 'Recharge',
            amount: reqDoc.amount,
            date: new Date().toLocaleString(),
            status: 'Rejected',
            txHash: reqDoc.txHash
        });
        u.markModified('deposits');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `❌ Your deposit request of $${reqDoc.amount} USDT was declined.`);
    } else if (reqDoc.type === 'withdraw' && u) {
        u.balance += Number(reqDoc.amount); // Refund balance
        u.withdrawals.unshift({
            id: reqId,
            type: 'Withdrawal',
            amount: -Number(reqDoc.amount),
            date: new Date().toLocaleString(),
            status: 'Rejected',
            address: reqDoc.address
        });
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `❌ Your withdrawal request was declined and funds refunded to your balance.`);
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

                if (user.referredBy) {
                    const l1Id = user.referredBy;
                    let refL1User = await User.findOne({ id: l1Id });
                    if (refL1User) {
                        let exists = refL1User.referrals.level1.some(r => (typeof r === 'string' ? r === chatId : r.id === chatId));
                        if (!exists) {
                            refL1User.referrals.level1.push({ id: chatId, joinedDate: 'Active', bonusEarned: 0 });
                            refL1User.markModified('referrals.level1');
                            await refL1User.save();
                        }
                    }
                }

                const welcomeCaption = `🎉 *Welcome to UnitedPay Investment Platform!*\n\nSecure cloud mining & AI-backed high-yield returns. Invest & earn daily! 🚀`;
                const startPhotoUrl = "https://i.ibb.co/JR4RRkb7/file-00000000abd481f48234067ed5a24c85.png";

                const webAppMarkup = {
                    inline_keyboard: [
                        [{ text: "🚀 Open UnitedPay App", web_app: { url: process.env.RENDER_EXTERNAL_URL || "https://your-app.onrender.com" } }],
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

            if (chatId !== String(ADMIN_ID)) return answerCallbackQuery(query.id, "Unauthorized!");

            if (data.startsWith('approve_') || data.startsWith('reject_')) {
                const isApprove = data.startsWith('approve_');
                const reqId = data.replace(isApprove ? 'approve_' : 'reject_', '');

                const reqDoc = await PendingRequest.findOneAndDelete({ reqId });
                if (!reqDoc) return answerCallbackQuery(query.id, "Request already handled!");

                const u = await User.findOne({ id: reqDoc.userId });

                if (isApprove) {
                    await approveRequest(reqDoc, u, reqId);
                    editTelegramMessage(chatId, messageId, `✅ **Request Approved**\nUser ID: ${reqDoc.userId}\nAmount: $${reqDoc.amount}`);
                } else {
                    await rejectRequest(reqDoc, u, reqId);
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

// ================== MINI APP API ENDPOINTS ==================
app.get('/api/user/:userId', async (req, res) => {
    const userId = String(req.params.userId);
    let user = await User.findOne({ id: userId });

    if (!user) {
        user = new User({ id: userId, username: req.query.username || 'User' });
        await user.save();
    }

    res.json({ success: true, user });
});

app.post('/api/deposit', async (req, res) => {
    const { userId, amount, txHash } = req.body;
    if (!userId || !amount || !txHash) {
        return res.status(400).json({ success: false, message: "Invalid deposit data." });
    }

    let u = await User.findOne({ id: userId });
    if (!u) u = new User({ id: userId });

    const reqId = 'dep_' + Date.now();
    await PendingRequest.create({
        reqId,
        type: 'deposit',
        userId,
        amount: parseFloat(amount),
        txHash: String(txHash).trim(),
        status: 'PENDING'
    });

    if (ADMIN_ID) {
        const msgText = `📥 **New Deposit Request**\n\n👤 User ID: \`${userId}\`\n💰 Amount: **$${amount} USDT**\n🔑 TxHash: \`${txHash}\``;
        const inlineKeyboard = {
            inline_keyboard: [[
                { text: "✅ Approve", callback_data: `approve_${reqId}` },
                { text: "❌ Reject", callback_data: `reject_${reqId}` }
            ]]
        };
        await sendTelegramMessage(ADMIN_ID, msgText, inlineKeyboard);
    }

    res.json({ success: true, message: "Deposit request submitted successfully" });
});

app.post('/api/withdraw', async (req, res) => {
    const { userId, amount, address } = req.body;
    let amt = parseFloat(amount);
    if (!userId || !amt || amt < 6 || !address) {
        return res.status(400).json({ success: false, message: "Minimum withdrawal is 6 USDT" });
    }

    let u = await User.findOne({ id: userId });
    if (!u || u.balance < amt) {
        return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    u.balance -= amt;
    await u.save();

    const reqId = 'wd_' + Date.now();
    await PendingRequest.create({
        reqId,
        type: 'withdraw',
        userId,
        amount: amt,
        address,
        status: 'PENDING'
    });

    if (ADMIN_ID) {
        const msgText = `📤 **New Withdraw Request**\n\n👤 User ID: \`${userId}\`\n💰 Amount: **$${amt} USDT**\n🏦 Address: \`${address}\``;
        const inlineKeyboard = {
            inline_keyboard: [[
                { text: "✅ Approve", callback_data: `approve_${reqId}` },
                { text: "❌ Reject", callback_data: `reject_${reqId}` }
            ]]
        };
        await sendTelegramMessage(ADMIN_ID, msgText, inlineKeyboard);
    }

    res.json({ success: true, message: "Withdrawal requested successfully", newBalance: u.balance });
});

// ================== ADMIN DASHBOARD ROUTES ==================
app.get('/admin/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Admin Login</title><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="background:#0c0a09;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:sans-serif;">
            <div style="background:#1c1917;padding:30px;border-radius:16px;width:320px;text-align:center;border:1px solid #292524;">
                <h2 style="color:#38bdf8;">🔐 Admin Login</h2>
                <form action="/admin/login" method="POST">
                    <input type="text" name="username" placeholder="Username" required style="width:100%;padding:10px;margin-bottom:10px;background:#0c0a09;border:1px solid #444;color:#fff;border-radius:6px;">
                    <input type="password" name="password" placeholder="Password" required style="width:100%;padding:10px;margin-bottom:10px;background:#0c0a09;border:1px solid #444;color:#fff;border-radius:6px;">
                    <button type="submit" style="width:100%;padding:10px;background:#38bdf8;border:none;font-weight:bold;border-radius:6px;cursor:pointer;">Login</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const sessionToken = "token_" + Math.random().toString(36).substring(2);
        activeSessions.add(sessionToken);
        res.setHeader('Set-Cookie', `admin_session=${sessionToken}; Path=/; HttpOnly; Max-Age=86400`);
        return res.redirect('/admin/dashboard');
    }
    res.send(`<script>alert('Invalid Credentials!');location.href='/admin/login';</script>`);
});

app.get('/admin/dashboard', checkAdminAuth, async (req, res) => {
    const requests = await PendingRequest.find({});
    const totalUsers = await User.countDocuments();
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Admin Dashboard - UnitedPay</title><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="background:#0c0a09;color:#fff;padding:20px;font-family:sans-serif;">
            <h1 style="color:#38bdf8;">👑 UnitedPay Admin Panel</h1>
            <p>Total Registered Users: <b>${totalUsers}</b></p>
            <h3>⏳ Pending User Requests (${requests.length})</h3>
            ${requests.length === 0 ? '<p>No pending requests.</p>' : `
                <table border="1" style="border-collapse:collapse;width:100%;text-align:left;border-color:#333;">
                    <tr><th>Type</th><th>User ID</th><th>Amount</th><th>Details</th></tr>
                    ${requests.map(r => `<tr>
                        <td><b>${r.type.toUpperCase()}</b></td>
                        <td>${r.userId}</td>
                        <td>$${r.amount}</td>
                        <td>${r.txHash || r.address}</td>
                    </tr>`).join('')}
                </table>
            `}
        </body>
        </html>
    `);
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
