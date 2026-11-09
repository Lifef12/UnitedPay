const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const BOT_TOKEN = process.env.BOT_TOKEN || '9105730060:AAEwFpaNJ7ZsV-aOEUDH3CyY2jpbjG9oWqc';
const ADMIN_ID = String(process.env.ADMIN_ID || '7482625921');
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

const WEBHOOK_SECRET = crypto.createHash('sha256').update('wh' + BOT_TOKEN).digest('hex').slice(0, 32);
const WELCOME_TEXT = '🔥 <b>Welcome to UnitedPay!</b>\n\n💎 AI Investment & Cloud Mining Platform.\n\n🚀 Start growing your wealth with UnitedPay today!';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB connected for UnitedPay'))
    .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

const UserSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },
    rechargePool: { type: Number, default: 0 },
    totalRecharge: { type: Number, default: 0 },
    unlockedPlans: { type: Array, default: [1] },
    completedTasks: { type: Object, default: {} },
    withdrawals: { type: Array, default: [] },
    transactions: { type: Array, default: [] },
    isBanned: { type: Boolean, default: false },
    createdAt: { type: Number, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const PendingRequest = mongoose.model('PendingRequest', new mongoose.Schema({
    reqId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    amount: { type: Number, required: true },
    address: { type: String, required: true },
    type: { type: String, required: true } // 'withdraw' or 'recharge'
}));

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => {
    console.log('Error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
});

async function tg(method, body) {
    try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000)
        });
        return await r.json();
    } catch (e) {
        return { ok: false, description: e.message };
    }
}

const sendMsg = (chat_id, text, reply_markup, html = true) =>
    tg('sendMessage', { chat_id, text, reply_markup, ...(html ? { parse_mode: 'HTML' } : {}) });

function validateInitData(initData) {
    if (!initData) return null;
    try {
        const p = new URLSearchParams(initData);
        const userStr = p.get('user');
        if (userStr) return JSON.parse(userStr);
    } catch (e) {}
    return null;
}

async function auth(req, res, next) {
    try {
        const initData = req.headers['x-init-data'];
        const u = validateInitData(initData);
        const userIdHeader = req.headers['x-user-id'];

        let id = u?.id ? String(u.id) : (userIdHeader ? String(userIdHeader) : null);
        let name = u?.username ? `@${u.username}` : (u?.first_name || 'User');

        if (!id) return res.status(401).json({ ok: false, error: 'Unauthorized' });

        let user = await User.findOneAndUpdate(
            { id },
            { $setOnInsert: { username: name, balance: 0, rechargePool: 0, unlockedPlans: [1] } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        if (user.isBanned) return res.status(403).json({ ok: false, error: 'Account banned' });
        req.user = user;
        next();
    } catch (e) {
        res.status(500).json({ ok: false, error: 'Auth error' });
    }
}

app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-init-data, x-user-id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// API Endpoints
app.post('/api/me', auth, wrap(async (req, res) => {
    res.json({ ok: true, data: req.user });
}));

app.post('/api/recharge', auth, wrap(async (req, res) => {
    const { amount, txid } = req.body;
    const amt = Math.floor(Number(amount));
    if (!txid || amt <= 0) return res.json({ ok: false, error: 'Invalid details' });

    const reqId = 'rc_' + crypto.randomBytes(6).toString('hex');
    await PendingRequest.create({ reqId, userId: req.user.id, amount: amt, address: txid, type: 'recharge' });

    sendMsg(ADMIN_ID, `📥 <b>New Recharge Request</b>\nUser ID: <code>${req.user.id}</code>\nAmount: <b>${amt} USDT</b>\nTxID: <code>${esc(txid)}</code>`, {
        inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${reqId}` }, { text: '❌ Reject', callback_data: `reject_${reqId}` }]]
    });
    res.json({ ok: true, message: 'Recharge submitted successfully!' });
}));

app.post('/api/withdraw', auth, wrap(async (req, res) => {
    const { amount, address } = req.body;
    const amt = Math.floor(Number(amount));
    if (amt < 6 || !address) return res.json({ ok: false, error: 'Minimum withdrawal is 6 USDT' });
    if (req.user.balance < amt) return res.json({ ok: false, error: 'Insufficient balance' });

    const reqId = 'wd_' + crypto.randomBytes(6).toString('hex');
    await PendingRequest.create({ reqId, userId: req.user.id, amount: amt, address, type: 'withdraw' });

    const updated = await User.findOneAndUpdate(
        { id: req.user.id },
        { 
            $inc: { balance: -amt },
            $push: { 
                withdrawals: { $each: [{ id: reqId, amount: amt, address, status: 'PENDING', date: new Date().toISOString() }], $position: 0 },
                transactions: { $each: [{ type: 'Withdrawal', amount: -amt, date: new Date().toLocaleString(), status: 'Pending' }], $position: 0 }
            }
        },
        { new: true }
    );

    sendMsg(ADMIN_ID, `📤 <b>New Withdraw Request</b>\nUser ID: <code>${req.user.id}</code>\nAmount: <b>${amt} USDT</b>\nAddress: <code>${esc(address)}</code>`, {
        inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${reqId}` }, { text: '❌ Reject', callback_data: `reject_${reqId}` }]]
    });
    res.json({ ok: true, data: updated });
}));

app.post('/api/unlock', auth, wrap(async (req, res) => {
    const { level, cost } = req.body;
    let user = req.user;
    if (user.unlockedPlans.includes(level)) return res.json({ ok: false, error: 'Already unlocked' });
    if (user.rechargePool < cost) return res.json({ ok: false, error: 'Insufficient recharge pool balance' });

    user.rechargePool -= cost;
    user.unlockedPlans.push(level);
    user.transactions.unshift({ type: `Unlock VIP-${level}`, amount: -cost, date: new Date().toLocaleString(), status: 'Completed' });
    await user.save();
    res.json({ ok: true, data: user });
}));

app.post('/api/claim-task', auth, wrap(async (req, res) => {
    const { level, reward, dateStr } = req.body;
    let user = req.user;
    
    if (!user.completedTasks) user.completedTasks = {};
    if (!user.completedTasks[dateStr]) user.completedTasks[dateStr] = [];

    if (user.completedTasks[dateStr].includes(level)) {
        return res.json({ ok: false, error: 'Already claimed for today' });
    }

    user.completedTasks[dateStr].push(level);
    user.balance += reward;
    user.transactions.unshift({ type: `Task Profit (VIP-${level})`, amount: reward, date: new Date().toLocaleString(), status: 'Completed' });
    
    // Mark modified for mixed object schemas in mongoose
    user.markModified('completedTasks');
    await user.save();
    res.json({ ok: true, data: user });
}));

// Admin Pending Requests endpoint for Web Dashboard
app.get('/api/admin/pending', wrap(async (req, res) => {
    const pending = await PendingRequest.find({});
    res.json({ ok: true, data: pending });
}));

// Telegram Webhook
app.post('/api/webhook', async (req, res) => {
    if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return res.sendStatus(403);
    res.sendStatus(200);

    try {
        const update = req.body;
        if (update.message?.text?.startsWith('/start')) {
            const chatId = String(update.message.chat.id);
            const webAppUrl = PUBLIC_URL || 'https://t.me/UnitedPayTg_bot';
            await sendMsg(chatId, WELCOME_TEXT, { inline_keyboard: [[{ text: '🚀 Open UnitedPay App', web_app: { url: webAppUrl } }]] });
        } else if (update.callback_query) {
            const q = update.callback_query;
            const chatId = String(q.message.chat.id);
            const data = q.data || '';
            const m = data.match(/^(approve|reject)_(.+)$/);
            if (!m || chatId !== ADMIN_ID) return;

            const approve = m[1] === 'approve';
            const reqId = m[2];
            const pr = await PendingRequest.findOneAndDelete({ reqId });
            if (!pr) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Already handled!' });

            if (pr.type === 'withdraw') {
                if (approve) {
                    await User.updateOne({ id: pr.userId }, { $inc: { totalWithdrawn: pr.amount } });
                    sendMsg(pr.userId, `✅ Your withdrawal of <b>${pr.amount} USDT</b> has been approved!`);
                } else {
                    await User.updateOne({ id: pr.userId }, { $inc: { balance: pr.amount } });
                    sendMsg(pr.userId, `❌ Your withdrawal of <b>${pr.amount} USDT</b> was declined and refunded.`);
                }
            } else if (pr.type === 'recharge') {
                if (approve) {
                    await User.updateOne({ id: pr.userId }, { $inc: { rechargePool: pr.amount, totalRecharge: pr.amount } });
                    sendMsg(pr.userId, `✅ Your recharge of <b>${pr.amount} USDT</b> has been credited!`);
                } else {
                    sendMsg(pr.userId, `❌ Your recharge of <b>${pr.amount} USDT</b> was rejected.`);
                }
            }
            tg('editMessageText', { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML', text: `${approve ? '✅ Approved' : '❌ Rejected'} Request ID: ${reqId}` });
        }
    } catch (e) {}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    if (PUBLIC_URL.startsWith('https')) {
        await tg('setWebhook', { url: `${PUBLIC_URL}/api/webhook`, secret_token: WEBHOOK_SECRET });
    }
});
