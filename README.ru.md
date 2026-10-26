# PseudoLegend — Telegram-бот для Cloudflare Workers

В `index.js` находится логика бота. Он фиксирует город **Кривой Рог** и район **Дружба**, показывает каталог, профиль и баланс, принимает изображения квитанций и отправляет администратору заявки с кнопками подтверждения. Данные хранятся в Cloudflare Durable Object; номер карты шифруется AES-GCM.

Каталог уже содержит товары и цены, которые вы указали. Администратор может написать боту `/admin`, чтобы добавить фотографии или изменить товары, описания, цены, карту и текст контактов. Главный администратор может добавлять других администраторов по Telegram-нику и отзывать их доступ.

## Требования

- аккаунт Cloudflare;
- бот, созданный через `@BotFather`;
- числовой Telegram ID администратора;
- Termux на Android с доступом в интернет.

Администратор должен открыть бота и отправить `/start` до первой заявки, иначе Telegram не даст боту написать ему в личный чат.

## Установка в Termux

1. Установите Node.js и Python:

   ```sh
   pkg update
   pkg install nodejs-lts python openssl
   npm install -g wrangler
   ```

2. В Termux войдите в Cloudflare:

   ```sh
   wrangler login
   ```

3. Скачайте `index.js` и `wrangler.jsonc` из проекта в папку «Загрузки» Android. Затем предоставьте Termux доступ к файлам, скопируйте их в отдельную папку и разверните Worker:

   ```sh
   termux-setup-storage
   mkdir -p ~/pseudolegend
   cp ~/storage/downloads/index.js ~/pseudolegend/
   cp ~/storage/downloads/wrangler.jsonc ~/pseudolegend/
   cd ~/pseudolegend
   wrangler deploy
   ```

   При первом запуске Wrangler создаст SQLite Durable Object для постоянного хранения данных и выведет URL вида `https://pseudolegend-telegram-bot.<аккаунт>.workers.dev`.

4. Добавьте секреты. Команда запросит значение интерактивно; не вставляйте секреты в исходный код и не отправляйте их в чат:

   ```sh
   wrangler secret put BOT_TOKEN
   wrangler secret put WEBHOOK_SECRET
   wrangler secret put CARD_ENCRYPTION_KEY
   ```

   - `BOT_TOKEN` — токен от `@BotFather`.
   - `ADMIN_ID` уже задан в `wrangler.jsonc`. Для смены ID измените значение в разделе `vars`.
   - `WEBHOOK_SECRET` — секрет webhook (1–256 символов, только `A-Z`, `a-z`, `0-9`, `_`, `-`). Можно создать так: `openssl rand -hex 32`.
   - `CARD_ENCRYPTION_KEY` — ключ AES-GCM: `openssl rand -base64 32`. Сохраните его в надёжном месте. **Не меняйте и не теряйте его после установки карты:** без прежнего ключа сохранённый номер карты нельзя расшифровать; после смены ключа администратору потребуется задать карту заново.

5. Повторно опубликуйте Worker, если добавили секреты после первой публикации:

   ```sh
   wrangler deploy
   ```

6. Установите Telegram webhook. Подставьте URL своего Worker в переменную `WORKER_URL`, затем выполните Python-код. Он запросит токен и webhook-секрет скрыто, не записывая их в команду:

   ```sh
   export WORKER_URL="https://pseudolegend-telegram-bot.<аккаунт>.workers.dev"
   python - <<'PY'
   import getpass, json, os, urllib.parse, urllib.request
   token = getpass.getpass("BOT_TOKEN: ")
   secret = getpass.getpass("WEBHOOK_SECRET: ")
   url = os.environ["WORKER_URL"].rstrip("/") + "/webhook"
   data = urllib.parse.urlencode({
       "url": url,
       "secret_token": secret,
       "allowed_updates": json.dumps(["message", "callback_query"])
   }).encode()
   req = urllib.request.Request(
       f"https://api.telegram.org/bot{token}/setWebhook",
       data=data,
       headers={"Content-Type": "application/x-www-form-urlencoded"}
   )
   with urllib.request.urlopen(req) as response:
       print(response.read().decode())
   PY
   ```

   В ответе Telegram должно быть `"ok":true`. Проверить Worker можно запросом `https://...workers.dev/health`.

7. Откройте бота в Telegram и отправьте `/start`. Администратор может открыть `/admin`.

## Управление

- **Пользователь:** каталог → товар → оформить заказ → перевод на карту → фото квитанции.
- **Пополнение:** меню → пополнить → сумма в гривнах → перевод → фото квитанции.
- **Администратор:** `/admin` → изменить карту, управлять товарами/описаниями/фотографиями и контактами, просматривать ожидающие заявки.
- **Дополнительные администраторы:** главный администратор открывает `/admin` → «Управление администраторами» → «Добавить по @нику». Новый администратор должен сначала открыть бота и отправить `/start`, чтобы бот безопасно сопоставил его ник с постоянным Telegram ID. Все администраторы могут проверять/принимать заявки и редактировать товары, цены, описания и фотографии. Изменять карту, контакты и список администраторов может только главный администратор.
- `/cancel` отменяет текущий незавершённый шаг или заявку, для которой ещё не отправлена квитанция.
- Подтверждение пополнения начисляет указанную сумму на баланс. Подтверждение заказа меняет статус заказа и уведомляет пользователя.
- Для смены токена, Telegram ID администратора или webhook-секрета используйте `wrangler secret put ИМЯ` и затем `wrangler deploy`. После смены `WEBHOOK_SECRET` повторно вызовите `setWebhook` с новым значением.

## Примечания по безопасности

- Номер карты хранится в Durable Object только в AES-GCM-зашифрованном виде. Он расшифровывается лишь при выдаче пользователю для оплаты; не включайте отладочные логи с секретами.
- ID администратора сравнивается с отправителем Telegram, а webhook проверяет заголовок `X-Telegram-Bot-Api-Secret-Token`.
- Квитанции содержат финансовую информацию. Бот передает изображение только в личный чат администратора; ограничьте доступ к этому аккаунту и соблюдайте применимые правила хранения и обработки таких данных.
- Это ручной перевод и ручная проверка квитанций, не автоматическая проверка банковского платежа. Не подтверждайте заявку только по картинке, сверяйте поступление в банковском приложении.
- Баланс и каталог сохраняются в одном Durable Object и не синхронизируются с другими базами данных.
