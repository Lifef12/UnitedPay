const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const BOT_TOKEN = process.env.BOT_TOKEN || '9105730060:AAEwFpaNJ7ZsV-aOEUDH3CyY2jpbjG9oWqc';
const ADMIN_ID = String(process.env.ADMIN_ID || '7482625921');
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/unitedpay';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const BOT_USERNAME = 'UnitedPayTg_bot';

const WEBHOOK_SECRET = crypto.createHash('sha256').update('wh' + BOT_TOKEN).digest('hex').slice(0, 32);

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB connected successfully'))
    .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// Database Schemas
const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },
    rechargePool: { type: Number, default: 0 },
    totalRecharge: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    wheelChances: { type: Number, default: 1 },
    unlockedPlans: { type: [Number], default: [1] },
    completedTasksDate: { type: String, default: '' },
    completedTasks: { type: [Number], default: [] },
    withdrawals: { type: Array, default: [] },
    transactions: { type: Array, default: [] },
    isBanned: { type: Boolean, default: false },
    createdAt: { type: Number, default: Date.now }
});

const PendingRequest = mongoose.model('PendingRequest', new mongoose.Schema({
    reqId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    type: { type: String, enum: ['Recharge', 'Withdrawal'], required: true },
    amount: { type: Number, required: true },
    txid: { type: String, default: '' },
    address: { type: String, default: '' },
    status: { type: String, default: 'Pending' }
}));

const User = mongoose.model('User', userSchema);

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => {
    console.log('Error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
        console.log('Telegram error:', method, e.message);
        return { ok: false, description: e.message };
    }
}

const sendMsg = (chat_id, text, reply_markup, html = true) =>
    tg('sendMessage', { chat_id, text, reply_markup, ...(html ? { parse_mode: 'HTML' } : {}) });

function validateInitData(initData) {
    if (!initData || initData.length > 4096) return null;
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
    const a = Buffer.from(calc), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
    try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}

function displayName(u) { return u.username ? `@${u.username}` : (u.first_name || 'User'); }

async function auth(req, res, next) {
    try {
        const u = validateInitData(req.headers['x-init-data']);
        const id = u && u.id ? String(u.id) : String(req.headers['x-user-id'] || '7482625921'); // Fallback for testing
        const name = u ? displayName(u) : 'User';

        let user = await User.findOneAndUpdate(
            { id },
            { $set: { username: name } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (user.isBanned) return res.status(403).json({ ok: false, error: 'Your account is banned.' });

        req.user = user;
        next();
    } catch (e) {
        console.log('Auth error:', e);
        res.status(500).json({ ok: false, error: 'Server error' });
    }
}

// CORS Middleware
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

app.get('/health', (req, res) => res.send('OK'));

// ---------- API ENDPOINTS ----------

app.post('/api/me', auth, wrap(async (req, res) => {
    res.json({ ok: true, data: req.user });
}));

// Task Completion
app.post('/api/task/complete', auth, wrap(async (req, res) => {
    const { level, reward } = req.body;
    const todayStr = new Date().toDateString();
    let u = req.user;

    if (u.completedTasksDate !== todayStr) {
        u.completedTasksDate = todayStr;
        u.completedTasks = [];
    }

    if (u.completedTasks.includes(level)) {
        return res.json({ ok: false, error: 'Task already claimed for today!' });
    }

    u.balance += Number(reward);
    u.completedTasks.push(level);
    u.transactions.unshift({ type: `Task Profit (VIP-${level})`, amount: Number(reward), date: new Date().toLocaleString(), status: 'Approved' });
    
    await u.save();
    res.json({ ok: true, data: u });
}));

// VIP Plan Unlock
app.post('/api/vip/unlock', auth, wrap(async (req, res) => {
    const { level, unlockAmount } = req.body;
    let u = req.user;

    if (u.unlockedPlans.includes(level)) {
        return res.json({ ok: false, error: 'VIP plan already unlocked.' });
    }
    if (u.rechargePool < unlockAmount) {
        return res.json({ ok: false, error: 'Insufficient recharge pool balance.' });
    }

    u.rechargePool -= Number(unlockAmount);
    u.unlockedPlans.push(level);
    u.transactions.unshift({ type: `VIP Unlock (VIP-${level})`, amount: -Number(unlockAmount), date: new Date().toLocaleString(), status: 'Approved' });

    await u.save();
    res.json({ ok: true, data: u });
}));

// Recharge Request Submission
app.post('/api/recharge/submit', auth, wrap(async (req, res) => {
    const { amount, txid } = req.body;
    const amt = Number(amount);
    if (!amt || !txid) return res.json({ ok: false, error: 'Enter amount and transaction hash.' });

    const reqId = 'rec_' + crypto.randomBytes(6).toString('hex');
    await PendingRequest.create({ reqId, userId: req.user.id, type: 'Recharge', amount: amt, txid, status: 'Pending' });

    req.user.transactions.unshift({ reqId, type: 'Recharge', amount: amt, date: new Date().toLocaleString(), status: 'Pending' });
    await req.user.save();

    sendMsg(ADMIN_ID, `📥 <b>New Recharge Request</b>\n\n👤 User ID: <code>${esc(req.user.id)}</code>\n💰 Amount: <b>$${amt} USDT</b>\n🔑 TxID: <code>${esc(txid)}</code>`, {
        inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${reqId}` }, { text: '❌ Reject', callback_data: `reject_${reqId}` }]]
    });

    res.json({ ok: true, data: req.user });
}));

// Withdrawal Request Submission
app.post('/api/withdraw/submit', auth, wrap(async (req, res) => {
    const { amount, address } = req.body;
    const amt = Number(amount);
    if (!amt || amt < 6) return res.json({ ok: false, error: 'Minimum withdrawal is 6.00 USDT' });
    if (!address) return res.json({ ok: false, error: 'Enter wallet address.' });
    if (req.user.balance < amt) return res.json({ ok: false, error: 'Insufficient balance.' });

    req.user.balance -= amt;
    const reqId = 'wd_' + crypto.randomBytes(6).toString('hex');
    await PendingRequest.create({ reqId, userId: req.user.id, type: 'Withdrawal', amount: amt, address, status: 'Pending' });

    const txItem = { reqId, type: 'Withdrawal', amount: -amt, date: new Date().toLocaleString(), status: 'Pending' };
    req.user.withdrawals.unshift(txItem);
    req.user.transactions.unshift(txItem);
    await req.user.save();

    sendMsg(ADMIN_ID, `📤 <b>New Withdrawal Request</b>\n\n👤 User ID: <code>${esc(req.user.id)}</code>\n💰 Amount: <b>$${amt} USDT</b>\n🏦 Address: <code>${esc(address)}</code>`, {
        inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${reqId}` }, { text: '❌ Reject', callback_data: `reject_${reqId}` }]]
    });

    res.json({ ok: true, data: req.user });
}));

// ---------- TELEGRAM WEBHOOK ----------

app.post('/api/webhook', async (req, res) => {
    if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return res.sendStatus(403);
    res.sendStatus(200);

    try {
        const update = req.body;
        if (update.message && update.message.text) {
            const chatId = String(update.message.chat.id);
            const text = update.message.text;

            if (text.startsWith('/start')) {
                await sendMsg(chatId, `🔥 <b>Welcome to UnitedPay!</b>\n\nEarn high-yield daily returns with our automated cloud mining platform.\n\n👇 Click below to open the Mini App!`, {
                    inline_keyboard: [[{ text: '🚀 Open UnitedPay App', url: `https://t.me/${BOT_USERNAME}` }]]
                });
            }
        } else if (update.callback_query) {
            const q = update.callback_query;
            const chatId = String(q.message.chat.id);
            const data = q.data || '';

            const m = data.match(/^(approve|reject)_(rec|wd)_[a-f0-9]+$/);
            if (!m || chatId !== ADMIN_ID) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Unauthorized!' });

            const approve = m[1] === 'approve';
            const reqId = data.replace(/^(approve|reject)_/, '');
            const pr = await PendingRequest.findOneAndDelete({ reqId });

            if (!pr) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Request already handled!' });

            const user = await User.findOne({ id: pr.userId });
            if (user) {
                if (approve) {
                    if (pr.type === 'Recharge') {
                        user.rechargePool += pr.amount;
                        user.totalRecharge += pr.amount;
                    } else if (pr.type === 'Withdrawal') {
                        user.totalWithdrawn += pr.amount;
                    }
                    sendMsg(user.id, `✅ Your ${pr.type.toLowerCase()} of <b>$${pr.amount} USDT</b> has been approved!`);
                } else {
                    if (pr.type === 'Withdrawal') {
                        user.balance += pr.amount; // Refund balance
                    }
                    sendMsg(user.id, `❌ Your ${pr.type.toLowerCase()} of <b>$${pr.amount} USDT</b> was rejected.`);
                }
                await user.save();
            }

            tg('editMessageText', {
                chat_id: chatId,
                message_id: q.message.message_id,
                parse_mode: 'HTML',
                text: `${approve ? '✅ <b>Approved</b>' : '❌ <b>Rejected</b>'}\nType: ${pr.type}\nUser: ${pr.userId}\nAmount: $${pr.amount}`
            });
            tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Done!' });
        }
    } catch (e) {
        console.log('Webhook error:', e);
    }
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    if (PUBLIC_URL.startsWith('https://')) {
        const r = await tg('setWebhook', {
            url: `${PUBLIC_URL}/api/webhook`,
            secret_token: WEBHOOK_SECRET,
            allowed_updates: ['message', 'callback_query']
        });
        console.log(r.ok ? '✅ Telegram webhook configured' : '❌ Webhook setup failed', r.description || '');
    }
});
