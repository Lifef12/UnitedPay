const express = require('express');
const mongoose = require('mongoose');
const app = express();

// ================== SETTINGS ==================
const BOT_TOKEN = "9107042388:AAFv0PnNLBlHiGfcX4Xd09TghNuwOojFcpU";
const ADMIN_ID = "7482625921";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/unitedpay';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "nbx12345";

// ================== DATABASE ==================
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Successfully!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },
    rechargePool: { type: Number, default: 0 },
    totalRecharge: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    unlockedPlans: { type: Array, default: [1] },
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
    type: { type: String, required: true },
    userId: { type: String, required: true },
    amount: { type: Number, required: true },
    txHash: { type: String },
    address: { type: String },
    status: { type: String, default: 'PENDING' }
});
const PendingRequest = mongoose.model('PendingRequest', pendingRequestSchema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

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
        
        if (u.deposits && u.deposits.length > 0) {
            let dItem = u.deposits.find(d => String(d.id) === String(reqId));
            if (dItem) dItem.status = 'Approved';
        }
        u.markModified('deposits');
        await u.save();

        await payReferralCommissions(u, depAmount);
        sendTelegramMessage(reqDoc.userId, `✅ Your deposit of $${depAmount} USDT has been approved and added to your recharge pool!`);
    } else if (reqDoc.type === 'withdraw' && u) {
        u.totalWithdrawn = Number(u.totalWithdrawn || 0) + Number(reqDoc.amount);
        if (u.withdrawals && u.withdrawals.length > 0) {
            let wItem = u.withdrawals.find(w => String(w.id) === String(reqId));
            if (wItem) wItem.status = 'Approved';
        }
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `✅ Your withdrawal of $${reqDoc.amount} USDT has been approved!`);
    }
}

async function rejectRequest(reqDoc, u, reqId) {
    if (reqDoc.type === 'deposit' && u) {
        if (u.deposits && u.deposits.length > 0) {
            let dItem = u.deposits.find(d => String(d.id) === String(reqId));
            if (dItem) dItem.status = 'Rejected';
        }
        u.markModified('deposits');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `❌ Your deposit request of $${reqDoc.amount} USDT was declined.`);
    } else if (reqDoc.type === 'withdraw' && u) {
        u.balance += Number(reqDoc.amount);
        if (u.withdrawals && u.withdrawals.length > 0) {
            let wItem = u.withdrawals.find(w => String(w.id) === String(reqId));
            if (wItem) wItem.status = 'Rejected';
        }
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `❌ Your withdrawal request was declined and funds refunded to your balance.`);
    }
}

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
    
    u.deposits.unshift({
        id: reqId,
        type: 'Recharge',
        amount: parseFloat(amount),
        date: new Date().toLocaleString(),
        status: 'Pending',
        txHash: String(txHash).trim()
    });
    u.markModified('deposits');
    await u.save();

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

    const reqId = 'wd_' + Date.now();
    u.withdrawals.unshift({
        id: reqId,
        type: 'Withdrawal',
        amount: -amt,
        date: new Date().toLocaleString(),
        status: 'Pending',
        address: address
    });
    u.markModified('withdrawals');
    await u.save();

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

app.get('/admin/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Login - UnitedPay</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { box-sizing: border-box; font-family: 'Segoe UI', sans-serif; }
                body { background: #0c0a09; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .login-card { background: #1c1917; border: 1px solid #292524; padding: 30px; border-radius: 16px; width: 90%; max-width: 360px; text-align: center; }
                h2 { color: #f5b83d; margin-bottom: 20px; }
                input { width: 100%; padding: 12px; margin-bottom: 12px; background: #0c0a09; border: 1px solid #44403c; color: #fff; border-radius: 8px; }
                button { width: 100%; padding: 12px; background: #f5b83d; color: #000; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; }
            </style>
        </head>
        <body>
            <div class="login-card">
                <h2>👑 Admin Login</h2>
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
        const sessionToken = "token_" + Math.random().toString(36).substring(2);
        activeSessions.add(sessionToken);
        res.setHeader('Set-Cookie', `admin_session=${sessionToken}; Path=/; HttpOnly; Max-Age=86400`);
        return res.redirect('/admin/dashboard');
    }
    res.send(`<script>alert('Invalid Credentials!');location.href='/admin/login';</script>`);
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

    let totalUsersBalance = 0;
    let totalPaidOutUsdt = 0;
    let verifiedUsersCount = 0;

    allUsers.forEach(u => {
        totalUsersBalance += Number(u.balance || 0) + Number(u.rechargePool || 0);
        if (u.totalRecharge > 0) verifiedUsersCount++;
        if (u.withdrawals) {
            u.withdrawals.forEach(w => {
                if (w.status === 'Approved') totalPaidOutUsdt += Math.abs(Number(w.amount || 0));
            });
        }
    });

    let searchId = req.query.search ? req.query.search.trim() : '';
    let searchedUser = null;
    if (searchId) {
        searchedUser = await User.findOne({
            $or: [{ id: searchId }, { username: searchId.replace('@', '') }]
        });
    }

    let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>UnitedPay Admin Panel</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
                body { background: #0c0a09; color: #f3f4f6; margin: 0; padding: 16px; }
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                .header h1 { color: #f5b83d; margin: 0; font-size: 20px; }
                .logout-btn { background: #ef4444; color: #fff; padding: 6px 14px; border-radius: 8px; text-decoration: none; font-size: 12px; font-weight: bold; }
                .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px; }
                .stat-card { background: #1c1917; border: 1px solid #292524; border-radius: 14px; padding: 14px; text-align: left; }
                .stat-title { font-size: 10px; color: #a8a29e; text-transform: uppercase; font-weight: bold; }
                .stat-value { font-size: 18px; font-weight: bold; color: #f5b83d; margin-top: 6px; }
                .card { background: #1c1917; border: 1px solid #292524; border-radius: 14px; padding: 16px; margin-bottom: 16px; }
                .card h3 { color: #f5b83d; margin-top: 0; font-size: 14px; border-bottom: 1px solid #292524; padding-bottom: 8px; }
                .search-box { display: flex; gap: 8px; margin-bottom: 10px; }
                input, textarea { background: #0c0a09; border: 1px solid #44403c; color: #fff; padding: 10px; border-radius: 8px; width: 100%; font-size: 13px; }
                .btn { background: #f5b83d; color: #000; border: none; font-weight: bold; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; }
                .btn-green { background: #22c55e; color: #fff; }
                .btn-red { background: #ef4444; color: #fff; }
                table { width: 100%; border-collapse: collapse; margin-top: 8px; }
                th, td { padding: 8px; text-align: left; border-bottom: 1px solid #292524; font-size: 11.5px; }
                th { color: #a8a29e; }
                .user-details { background: #0c0a09; padding: 12px; border-radius: 8px; border: 1px solid #292524; font-size: 12px; line-height: 1.6; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>👑 UnitedPay Admin</h1>
                <a href="/admin/logout" class="logout-btn">Logout</a>
            </div>

            <div class="stats-grid">
                <div class="stat-card"><div class="stat-title">Total Users</div><div class="stat-value">${totalUsers}</div></div>
                <div class="stat-card"><div class="stat-title">Verified Users</div><div class="stat-value">${verifiedUsersCount}</div></div>
                <div class="stat-card"><div class="stat-title">Users' Balance</div><div class="stat-value">${totalUsersBalance.toFixed(2)} USDT</div></div>
                <div class="stat-card"><div class="stat-title">Paid Out</div><div class="stat-value">${totalPaidOutUsdt.toFixed(2)} USDT</div></div>
            </div>

            <div class="card">
                <h3>⏳ Pending Requests (${requests.length})</h3>
                ${requests.length === 0 ? '<p style="font-size:12px; color:#a8a29e;">No pending requests.</p>' : `
                    <table>
                        <tr><th>Type</th><th>User ID</th><th>Amount</th><th>Action</th></tr>
                        ${requests.map(r => `
                            <tr>
                                <td style="color:${r.type==='deposit'?'#22c55e':'#ef4444'}; font-weight:bold;">${r.type.toUpperCase()}</td>
                                <td><code>${r.userId}</code></td>
                                <td><b>$${r.amount}</b></td>
                                <td>
                                    <button class="btn btn-green" style="padding:4px 8px; font-size:10px;" onclick="handleReq('${r.reqId}', 'approve')">Approve</button>
                                    <button class="btn btn-red" style="padding:4px 8px; font-size:10px;" onclick="handleReq('${r.reqId}', 'reject')">Reject</button>
                                </td>
                            </tr>
                        `).join('')}
                    </table>
                `}
            </div>

            <div class="card">
                <h3>🔍 Search & Manage User</h3>
                <form method="GET" action="/admin/dashboard" class="search-box">
                    <input type="text" name="search" placeholder="Telegram ID or @username" value="${searchId}">
                    <button type="submit" class="btn">Search</button>
                </form>
                ${searchedUser ? `
                    <div class="user-details">
                        <p>👤 <b>User:</b> ${searchedUser.username} | <b>ID:</b> <code>${searchedUser.id}</code></p>
                        <p>💰 <b>Withdrawable Balance:</b> $${searchedUser.balance.toFixed(2)} USDT</p>
                        <p>📥 <b>Recharge Pool:</b> $${searchedUser.rechargePool.toFixed(2)} USDT</p>
                        <p>🔒 <b>Status:</b> ${searchedUser.isBanned ? '<span style="color:#ef4444;">BANNED</span>' : '<span style="color:#22c55e;">ACTIVE</span>'}</p>
                        <hr style="border-color:#292524; margin:10px 0;">
                        <b>⚙️ Quick Actions:</b>
                        <div style="display:flex; gap:8px; margin-top:8px;">
                            <input type="number" id="mod-amt" placeholder="Amount ($)" style="flex:1;">
                            <button class="btn btn-green" onclick="modifyBal('${searchedUser.id}', 'add')">+ Add</button>
                            <button class="btn btn-red" onclick="modifyBal('${searchedUser.id}', 'cut')">- Cut</button>
                        </div>
                    </div>
                ` : searchId ? '<p style="color:#ef4444; font-size:12px;">User not found!</p>' : ''}
            </div>

            <div class="card">
                <h3>📢 Broadcast</h3>
                <textarea id="bc-msg" placeholder="Message to all users..."></textarea>
                <button class="btn" style="margin-top:10px; width:100%;" onclick="sendBroadcast()">Send Broadcast</button>
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
                async function modifyBal(userId, action) {
                    let amount = document.getElementById('mod-amt').value;
                    if(!amount) return alert("Enter amount!");
                    let res = await fetch('/admin/manage-balance', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ userId, amount, action })
                    });
                    let data = await res.json();
                    alert(data.message);
                    location.reload();
                }
                async function sendBroadcast() {
                    let message = document.getElementById('bc-msg').value;
                    if(!message) return alert("Enter broadcast message!");
                    let res = await fetch('/admin/broadcast', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ message })
                    });
                    let data = await res.json();
                    alert(data.message);
                }
            </script>
        </body>
        </html>
    `);
    res.send(html);
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
    res.json({ success: true, message: "Action executed successfully!" });
});

app.post('/admin/manage-balance', checkAdminAuth, async (req, res) => {
    const { userId, amount, action } = req.body;
    let u = await User.findOne({ id: userId });
    if (!u) return res.status(404).json({ success: false, message: "User not found!" });

    let amt = parseFloat(amount);
    if (action === 'add') {
        u.balance += amt;
        sendTelegramMessage(userId, `🎁 Admin added +$${amt} USDT to your balance!`);
    } else {
        u.balance = Math.max(0, u.balance - amt);
        sendTelegramMessage(userId, `⚠️ Admin deducted -$${amt} USDT from your balance.`);
    }
    await u.save();
    res.json({ success: true, message: `Successfully updated balance for user ${userId}!` });
});

app.post('/admin/broadcast', checkAdminAuth, async (req, res) => {
    const { message } = req.body;
    const users = await User.find({});
    let count = 0;
    for (let u of users) {
        await sendTelegramMessage(u.id, message);
        count++;
    }
    res.json({ success: true, message: `Broadcast sent to ${count} users successfully!` });
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
