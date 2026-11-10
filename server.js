const express = require('express');
const mongoose = require('mongoose');
const app = express();

// ================== SETTINGS ==================
const BOT_TOKEN = "9107042388:AAFv0PnNLBlHiGfcX4Xd09TghNuwOojFcpU";
const ADMIN_ID = "7482625921";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "nbx12345";
const VERCEL_APP_URL = "https://unitedpaytg-bot.vercel.app/"; // Aapka Web App URL

// ================== VIP MINING RULES ==================
// UnitedPay VIP Plans mapping (Unlock Cost -> Daily Profit)
const VIP_PLANS = {
    1: { unlock: 0, daily: 1.00 },
    2: { unlock: 10, daily: 6.00 },
    3: { unlock: 30, daily: 20.00 },
    4: { unlock: 90, daily: 60.00 },
    5: { unlock: 230, daily: 150.00 },
    6: { unlock: 500, daily: 350.00 },
    7: { unlock: 1000, daily: 700.00 },
    8: { unlock: 2000, daily: 1500.00 },
    9: { unlock: 5000, daily: 3750.00 },
    10: { unlock: 10000, daily: 7500.00 },
    11: { unlock: 20000, daily: 16000.00 }
};

// ================== DATABASE SCHEMA ==================
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas Successfully!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },          // Withdrawable USD Balance
    rechargePool: { type: Number, default: 0 },    // Recharge Amount Pool for VIP Unlocks
    totalRecharge: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    unlockedPlans: { type: Array, default: [1] },    // Default VIP-1 unlocked
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
    txid: { type: String },
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

// ================== REFERRAL COMMISSION LOGIC (11% - 2% - 1%) ==================
async function payReferralCommissions(depositUser, usdtAmount) {
    const rates = [0.11, 0.02, 0.01]; // Level 1: 11%, Level 2: 2%, Level 3: 1%
    let currentId = depositUser.referredBy;

    for (let lvl = 1; lvl <= 3; lvl++) {
        if (!currentId) break;
        const refUser = await User.findOne({ id: currentId });
        if (!refUser) break;

        const commission = usdtAmount * rates[lvl - 1];
        refUser.balance += commission;
        refUser.refEarnings[`level${lvl}`] = (refUser.refEarnings[`level${lvl}`] || 0) + commission;
        refUser.markModified('refEarnings');
        await refUser.save();

        sendTelegramMessage(
            refUser.id, 
            `🎁 Received +$${commission.toFixed(2)} USDT (${rates[lvl - 1] * 100}% Level ${lvl} Referral Commission)!`
        );
        
        currentId = refUser.referredBy;
    }
}

// ================== REQUEST APPROVAL / REJECTION ==================
async function approveRequest(reqDoc, u, reqId) {
    if (reqDoc.type === 'Recharge' && u) {
        let idx = u.deposits.findIndex(d => String(d.id) === String(reqId));
        if (idx !== -1) u.deposits[idx].status = 'Approved';
        
        u.rechargePool += reqDoc.amount;
        u.totalRecharge += reqDoc.amount;
        u.markModified('deposits');
        await u.save();

        await payReferralCommissions(u, reqDoc.amount);
        sendTelegramMessage(reqDoc.userId, `✅ Your deposit of $${reqDoc.amount} USDT has been approved and added to your Recharge Pool!`);
    } else if (reqDoc.type === 'Withdrawal' && u) {
        let idx = u.withdrawals.findIndex(w => String(w.id) === String(reqId));
        if (idx !== -1) u.withdrawals[idx].status = 'Approved';
        u.totalWithdrawn += reqDoc.amount;
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `✅ Your withdrawal of $${reqDoc.amount} USDT has been approved and sent!`);
    }
}

async function rejectRequest(reqDoc, u, reqId) {
    if (reqDoc.type === 'Recharge' && u) {
        let idx = u.deposits.findIndex(d => String(d.id) === String(reqId));
        if (idx !== -1) u.deposits[idx].status = 'Rejected';
        u.markModified('deposits');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `❌ Your deposit request of $${reqDoc.amount} USDT was declined.`);
    } else if (reqDoc.type === 'Withdrawal' && u) {
        u.balance += reqDoc.amount; // Refund balance
        let idx = u.withdrawals.findIndex(w => String(w.id) === String(reqId));
        if (idx !== -1) u.withdrawals[idx].status = 'Rejected';
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
                await sendTelegramMessage(chatId, "⚠️ *Access Denied:* Your account has been banned by the admin.");
                return;
            }

            if (text.startsWith('/start')) {
                let referrerId = null;
                const match = text.match(/\/start\s+(\d+)/);
                if (match && match[1]) {
                    referrerId = String(match[1]).trim();
                }

                let isNewUser = false;
                if (!user) {
                    isNewUser = true;
                    user = new User({
                        id: chatId,
                        username: msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'User'),
                        referredBy: (referrerId && referrerId !== chatId) ? referrerId : null
                    });
                    await user.save();
                }

                // Register 3-Tier Hierarchy
                if (isNewUser && user.referredBy) {
                    const l1Id = user.referredBy;
                    let refL1 = await User.findOne({ id: l1Id });
                    if (refL1) {
                        if (!refL1.referrals.level1.includes(chatId)) {
                            refL1.referrals.level1.push(chatId);
                            refL1.markModified('referrals.level1');
                            await refL1.save();
                        }
                        sendTelegramMessage(l1Id, `🎁 *New Level 1 Referral Joined!*\nUser ID: \`${chatId}\``);

                        // Level 2
                        if (refL1.referredBy) {
                            let l2Id = refL1.referredBy;
                            let refL2 = await User.findOne({ id: l2Id });
                            if (refL2) {
                                if (!refL2.referrals.level2.includes(chatId)) {
                                    refL2.referrals.level2.push(chatId);
                                    refL2.markModified('referrals.level2');
                                    await refL2.save();
                                }

                                // Level 3
                                if (refL2.referredBy) {
                                    let l3Id = refL2.referredBy;
                                    let refL3 = await User.findOne({ id: l3Id });
                                    if (refL3 && !refL3.referrals.level3.includes(chatId)) {
                                        refL3.referrals.level3.push(chatId);
                                        refL3.markModified('referrals.level3');
                                        await refL3.save();
                                    }
                                }
                            }
                        }
                    }
                }

                const welcomeCaption = `🎉 *Welcome to UnitedPay Investment Platform!*\n\nInvest daily, earn high-yield returns, and grow your team rewards! 🚀`;
                
                // Sirf official channel ka button (Mini App button hata diya gaya hai)
                const channelMarkup = {
                    inline_keyboard: [
                        [{ text: "📢 Official Channel", url: "https://t.me/unitedPay115" }]
                    ]
                };

                await sendTelegramPhoto(chatId, "https://i.ibb.co/JR4RRkb7/file-00000000abd481f48234067ed5a24c85.png", welcomeCaption, channelMarkup);
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
                    editTelegramMessage(chatId, messageId, `✅ **Request Approved**\nUser: ${reqDoc.userId}\nAmount: $${reqDoc.amount}`);
                } else {
                    await rejectRequest(reqDoc, u, reqId);
                    editTelegramMessage(chatId, messageId, `❌ **Request Rejected**\nUser: ${reqDoc.userId}\nAmount: $${reqDoc.amount}`);
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
    res.send(`<h1>UnitedPay Backend Active</h1><p>Telegram Bot Webhook is running successfully.</p>`);
});

// ================== ADMIN PANEL ROUTES ==================
app.get('/admin/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Admin Login - UnitedPay</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { background: #0c0a09; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; margin: 0; }
            .card { background: #1c1917; padding: 30px; border-radius: 16px; width: 320px; border: 1px solid #292524; text-align: center; }
            input { width: 100%; padding: 12px; margin-bottom: 12px; background: #0c0a09; border: 1px solid #44403c; color: #fff; border-radius: 8px; box-sizing: border-box; }
            button { width: 100%; padding: 12px; background: #4a356b; color: #fff; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; }
        </style></head>
        <body>
            <div class="card">
                <h2 style="color: #d8b4fe;">🔐 Admin Login</h2>
                <form action="/admin/login" method="POST">
                    <input type="text" name="username" placeholder="Username" required>
                    <input type="password" name="password" placeholder="Password" required>
                    <button type="submit">Login</button>
                </form>
            </div>
        </body></html>
    `);
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = "token_" + Math.random().toString(36).substring(2) + Date.now();
        activeSessions.add(token);
        res.setHeader('Set-Cookie', `admin_session=${token}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
        return res.redirect('/admin/dashboard');
    }
    res.send(`<script>alert('Invalid Credentials!'); window.location.href='/admin/login';</script>`);
});

app.get('/admin/dashboard', checkAdminAuth, async (req, res) => {
    const requests = await PendingRequest.find({ status: 'Pending' });
    const totalUsers = await User.countDocuments();
    const allUsers = await User.find({});

    let totalRecharges = 0;
    let totalWithdrawals = 0;
    allUsers.forEach(u => {
        totalRecharges += u.totalRecharge;
        totalWithdrawals += u.totalWithdrawn;
    });

    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Admin Dashboard - UnitedPay</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { background: #0f172a; color: #f8fafc; font-family: sans-serif; padding: 20px; margin: 0; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 20px; }
            .card { background: #1e293b; padding: 16px; border-radius: 12px; border: 1px solid #334155; }
            .val { font-size: 22px; font-weight: bold; color: #38bdf8; margin-top: 5px; }
            table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 10px; overflow: hidden; margin-top: 10px; }
            th, td { padding: 12px; text-align: left; border-bottom: 1px solid #334155; font-size: 13px; }
            th { background: #334155; color: #cbd5e1; }
            .btn { padding: 6px 12px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 11px; }
            .btn-green { background: #16a34a; color: #fff; }
            .btn-red { background: #dc2626; color: #fff; }
        </style></head>
        <body>
            <h1>👑 UnitedPay Admin Dashboard</h1>
            <a href="/admin/login" style="color: #f43f5e; text-decoration: none; font-size: 12px;">Logout</a>
            
            <div class="grid" style="margin-top: 20px;">
                <div class="card"><div>Total Users</div><div class="val">${totalUsers}</div></div>
                <div class="card"><div>Total Deposits</div><div class="val">$${totalRecharges.toFixed(2)}</div></div>
                <div class="card"><div>Total Withdrawals</div><div class="val">$${totalWithdrawals.toFixed(2)}</div></div>
                <div class="card"><div>Pending Requests</div><div class="val">${requests.length}</div></div>
            </div>

            <div class="card">
                <h3>⏳ Pending User Deposit & Withdrawal Requests</h3>
                ${requests.length === 0 ? '<p style="color: #94a3b8; font-size: 13px;">No pending requests.</p>' : `
                    <table>
                        <tr><th>Type</th><th>User ID</th><th>Amount</th><th>Details</th><th>Action</th></tr>
                        ${requests.map(r => `
                            <tr>
                                <td style="font-weight:bold; color:${r.type==='Recharge'?'#22c55e':'#f43f5e'};">${r.type}</td>
                                <td><code>${r.userId}</code></td>
                                <td><b>$${r.amount}</b></td>
                                <td>${r.txid ? 'TxID: ' + r.txid : 'Addr: ' + r.address}</td>
                                <td>
                                    <button class="btn btn-green" onclick="handleReq('${r.reqId}', 'approve')">Approve</button>
                                    <button class="btn btn-red" onclick="handleReq('${r.reqId}', 'reject')">Reject</button>
                                </td>
                            </tr>
                        `).join('')}
                    </table>
                `}
            </div>

            <script>
                async function handleReq(reqId, action) {
                    let res = await fetch('/admin/action', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ reqId, action })
                    });
                    let data = await res.json();
                    alert(data.message);
                    location.reload();
                }
            </script>
        </body></html>
    `);
});

app.post('/admin/action', checkAdminAuth, async (req, res) => {
    const { reqId, action } = req.body;
    const reqDoc = await PendingRequest.findOneAndDelete({ reqId });
    if (!reqDoc) return res.status(404).json({ success: false, message: "Request not found" });

    const u = await User.findOne({ id: reqDoc.userId });
    if (action === 'approve') {
        await approveRequest(reqDoc, u, reqId);
    } else {
        await rejectRequest(reqDoc, u, reqId);
    }
    res.json({ success: true, message: `Request ${action}d successfully!` });
});

// ================== MINI APP API ENDPOINTS ==================
app.get('/api/user/:userId', async (req, res) => {
    const userId = String(req.params.userId);
    let user = await User.findOne({ id: userId });

    if (user && user.isBanned) {
        return res.status(403).json({ success: false, message: "Account banned." });
    }

    if (!user) {
        user = new User({ id: userId, username: 'User' });
        await user.save();
    }

    res.json({
        success: true,
        balance: user.balance,
        rechargePool: user.rechargePool,
        totalRecharge: user.totalRecharge,
        unlockedPlans: user.unlockedPlans,
        referrals: user.referrals,
        refEarnings: user.refEarnings
    });
});

// Deposit / Recharge Submission API
app.post('/api/deposit', async (req, res) => {
    const { userId, amount, txid } = req.body;
    let amt = parseFloat(amount);
    if (!userId || !amt || !txid) {
        return res.status(400).json({ success: false, message: "Invalid deposit parameters." });
    }

    let u = await User.findOne({ id: userId });
    if (!u) u = new User({ id: userId });

    const reqId = 'dep_' + Date.now();
    u.deposits.unshift({ id: reqId, amount: amt, txid, status: 'Pending', date: new Date().toLocaleString() });
    u.markModified('deposits');
    await u.save();

    await PendingRequest.create({
        reqId,
        type: 'Recharge',
        userId,
        amount: amt,
        txid,
        status: 'Pending'
    });

    if (ADMIN_ID) {
        const msgText = `📥 **New Deposit Request**\n\n👤 User ID: \`${userId}\`\n💰 Amount: **$${amt} USDT**\n🔑 TxID: \`${txid}\``;
        const inlineKeyboard = {
            inline_keyboard: [[
                { text: "✅ Approve", callback_data: `approve_${reqId}` },
                { text: "❌ Reject", callback_data: `reject_${reqId}` }
            ]]
        };
        await sendTelegramMessage(ADMIN_ID, msgText, inlineKeyboard);
    }

    res.json({ success: true, message: "Recharge request submitted successfully!" });
});

// Withdrawal Submission API
app.post('/api/withdraw', async (req, res) => {
    const { userId, amount, address } = req.body;
    let amt = parseFloat(amount);
    if (!userId || !amt || amt < 6 || !address) {
        return res.status(400).json({ success: false, message: "Minimum withdrawal is 6.00 USDT" });
    }

    let u = await User.findOne({ id: userId });
    if (!u || u.balance < amt) {
        return res.status(400).json({ success: false, message: "Insufficient withdrawable balance!" });
    }

    u.balance -= amt;
    const reqId = 'wd_' + Date.now();
    u.withdrawals.unshift({ id: reqId, amount: amt, address, status: 'Pending', date: new Date().toLocaleString() });
    u.markModified('withdrawals');
    await u.save();

    await PendingRequest.create({
        reqId,
        type: 'Withdrawal',
        userId,
        amount: amt,
        address,
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

    res.json({ success: true, message: "Withdrawal requested successfully!", newBalance: u.balance });
});

// VIP Plan Unlock API
app.post('/api/unlock-vip', async (req, res) => {
    const { userId, level } = req.body;
    let u = await User.findOne({ id: userId });
    if (!u) return res.status(404).json({ success: false, message: "User not found!" });

    if (u.unlockedPlans.includes(level)) {
        return res.status(400).json({ success: false, message: "Plan already unlocked!" });
    }

    const planData = VIP_PLANS[level];
    if (!planData) return res.status(400).json({ success: false, message: "Invalid VIP level!" });

    if (u.rechargePool < planData.unlock) {
        return res.status(400).json({ success: false, message: "Insufficient recharge pool balance!" });
    }

    u.rechargePool -= planData.unlock;
    u.unlockedPlans.push(level);
    u.markModified('unlockedPlans');
    await u.save();

    res.json({ success: true, message: `Successfully unlocked VIP-${level}!`, rechargePool: u.rechargePool, unlockedPlans: u.unlockedPlans });
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
