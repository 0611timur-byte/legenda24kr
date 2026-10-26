/**
 * PseudoLegend Telegram bot for Cloudflare Workers.
 *
 * One Durable Object serializes persistent bot state. Balances are stored in
 * integer UAH; uploaded receipts are sent directly to the configured admin.
 * Card numbers are encrypted with AES-GCM before they are persisted.
 */

const CITY = "Кривой Рог";
const DISTRICT = "Дружба";
const TELEGRAM_API = "https://api.telegram.org";

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: "🛍 Каталог товаров" }, { text: "👤 Профиль" }],
    [{ text: "💳 Пополнить баланс" }, { text: "🆘 Поддержка / Контакты" }],
  ],
  resize_keyboard: true,
};

function newDatabase() {
  return {
    users: {},
    admins: {},
    products: [
      {
        id: "hairdryer-single",
        name: "Фен для волос — 1 шт.",
        price: 500,
        description: "Чистый фен без всякой хуеты.",
        photo: null,
      },
      {
        id: "hairdryer-pack-5",
        name: "Фены для волос — 5 шт.",
        price: 2300,
        description: "Чистый фен без всякой хуеты.",
        photo: null,
      },
    ],
    pending: {},
    encryptedCard: null,
    supportText: "Поддержка: @legebda24kr",
    processedUpdates: [],
  };
}

function userName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") ||
    user.username ||
    `ID ${user.id}`;
}

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function money(amount) {
  return `${Number(amount).toLocaleString("uk-UA")} грн`;
}

function safeText(value, max = 3000) {
  return String(value ?? "").slice(0, max);
}

function imageFromMessage(message) {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    return { type: "photo", fileId: message.photo.at(-1).file_id };
  }
  if (
    message.document?.file_id &&
    String(message.document.mime_type || "").startsWith("image/")
  ) {
    return { type: "document", fileId: message.document.file_id };
  }
  return null;
}

function toBytesFromBase64(value) {
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error("CARD_ENCRYPTION_KEY должен быть base64-кодированным ключом.");
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function encryptionKey(env) {
  const raw = toBytesFromBase64(env.CARD_ENCRYPTION_KEY || "");
  if (raw.length !== 32) {
    throw new Error("CARD_ENCRYPTION_KEY должен содержать ровно 32 байта в base64.");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptCard(card, env) {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(card),
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(encrypted))}`;
}

async function decryptCard(value, env) {
  if (!value) return null;
  const [ivPart, cipherPart] = String(value).split(".");
  if (!ivPart || !cipherPart) throw new Error("Сохраненная карта повреждена.");
  const key = await encryptionKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBytesFromBase64(ivPart) },
    key,
    toBytesFromBase64(cipherPart),
  );
  return new TextDecoder().decode(plain);
}

function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    mismatch |= (left[i % (left.length || 1)] || 0) ^
      (right[i % (right.length || 1)] || 0);
  }
  return mismatch === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "PseudoLegend Telegram bot" });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }
    if (!env.BOT_TOKEN || !env.ADMIN_ID || !env.WEBHOOK_SECRET) {
      return new Response("Worker secrets are not configured.", { status: 500 });
    }
    const providedSecret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token",
    );
    if (!providedSecret || !constantTimeEqual(providedSecret, env.WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    try {
      const id = env.BOT_STATE.idFromName("pseudolegend-primary");
      const stub = env.BOT_STATE.get(id);
      return await stub.fetch("https://bot-state/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
    } catch (error) {
      console.error("Webhook processing failed:", error?.message || error);
      return new Response("Temporary processing error", { status: 500 });
    }
  },
};

export class BotState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.dbReady = state.blockConcurrencyWhile(async () => {
      if (!(await this.state.storage.get("database"))) {
        await this.state.storage.put("database", newDatabase());
      }
    });
  }

  async readDb() {
    await this.dbReady;
    const db = (await this.state.storage.get("database")) || newDatabase();
    db.admins ||= {};
    db.changeRequests ||= {};
    return db;
  }

  async mutateDb(mutator) {
    await this.dbReady;
    return this.state.storage.transaction(async (txn) => {
      const db = (await txn.get("database")) || newDatabase();
      db.admins ||= {};
      db.changeRequests ||= {};
      const result = await mutator(db);
      await txn.put("database", db);
      return result;
    });
  }

  async telegram(method, payload) {
    const response = await fetch(
      `${TELEGRAM_API}/bot${this.env.BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(
        `Telegram ${method} failed: ${result.description || response.status}`,
      );
    }
    return result.result;
  }

  sendMessage(chatId, text, extra = {}) {
    return this.telegram("sendMessage", {
      chat_id: chatId,
      text: safeText(text, 4000),
      ...extra,
    });
  }

  async ensureUser(user) {
    return this.mutateDb((db) => {
      const id = String(user.id);
      db.users[id] ||= { id, name: userName(user), username: user.username || null, balance: 0, flow: null };
      db.users[id].name = userName(user);
      db.users[id].username = user.username || null;
      return { ...db.users[id] };
    });
  }

  isOwner(userId) {
    return String(userId) === String(this.env.ADMIN_ID);
  }

  async isAdmin(userId) {
    if (this.isOwner(userId)) return true;
    const db = await this.readDb();
    return Boolean(db.admins[String(userId)]);
  }

  async adminRecipients() {
    const db = await this.readDb();
    return [...new Set([String(this.env.ADMIN_ID), ...Object.keys(db.admins)])];
  }

  async sendReceiptToAdmins(image, caption, replyMarkup) {
    const recipients = await this.adminRecipients();
    let delivered = 0;
    let lastError;
    for (const chatId of recipients) {
      try {
        await this.telegram(
          image.type === "photo" ? "sendPhoto" : "sendDocument",
          {
            chat_id: chatId,
            [image.type === "photo" ? "photo" : "document"]: image.fileId,
            caption,
            reply_markup: replyMarkup,
          },
        );
        delivered++;
      } catch (error) {
        lastError = error;
        console.error(`Receipt notification failed for admin ${chatId}:`, error?.message || error);
      }
    }
    if (!delivered) throw lastError || new Error("No admin could receive the receipt.");
  }

  async cardForUser() {
    const db = await this.readDb();
    return decryptCard(db.encryptedCard, this.env);
  }

  async startPayment(userId, chatId, kind, amount, product = null) {
    const card = await this.cardForUser();
    if (!card) {
      await this.sendMessage(
        chatId,
        "Оплата пока не настроена. Пожалуйста, обратитесь в поддержку.",
        { reply_markup: MAIN_KEYBOARD },
      );
      return;
    }
    const pendingId = crypto.randomUUID().slice(0, 12);
    const pending = {
      id: pendingId,
      userId: String(userId),
      kind,
      amount,
      productId: product?.id || null,
      productName: product?.name || null,
      status: "awaiting_receipt",
      createdAt: new Date().toISOString(),
    };
    const created = await this.mutateDb((db) => {
      const user = db.users[String(userId)];
      const currentPending = user?.flow?.pendingId
        ? db.pending[user.flow.pendingId]
        : null;
      if (
        currentPending &&
        ["awaiting_receipt", "sending_receipt"].includes(currentPending.status)
      ) {
        return false;
      }
      db.pending[pendingId] = pending;
      if (user) user.flow = { type: "awaiting_receipt", pendingId };
      return true;
    });
    if (!created) {
      await this.sendMessage(
        chatId,
        "У вас уже есть заявка, ожидающая квитанцию. Сначала отправьте её или напишите /cancel.",
        { reply_markup: MAIN_KEYBOARD },
      );
      return;
    }

    const kindLabel = kind === "topup" ? "пополнение баланса" : "заказ";
    await this.sendMessage(
      chatId,
      [
        `Заявка на ${kindLabel} создана.`,
        product ? `Товар: ${product.name}` : "",
        `К оплате: ${money(amount)}`,
        `Город: ${CITY}`,
        `Район: ${DISTRICT}`,
        `Номер карты: ${card}`,
        "",
        "После перевода отправьте сюда фото квитанции или изображение чека.",
        "Не отправляйте данные вашей банковской карты.",
      ]
        .filter(Boolean)
        .join("\n"),
      { reply_markup: MAIN_KEYBOARD },
    );
  }

  async handleMessage(message, updateId) {
    const chat = message.chat;
    const from = message.from;
    if (!chat || !from || chat.type !== "private") return;
    await this.ensureUser(from);

    const isAdmin = await this.isAdmin(from.id);
    const text = String(message.text || "").trim();

    if (text === "/cancel") {
      await this.mutateDb((db) => {
        const user = db.users[String(from.id)];
        const pending = user?.flow?.pendingId
          ? db.pending[user.flow.pendingId]
          : null;
        if (pending?.status === "awaiting_receipt") pending.status = "cancelled";
        if (user) user.flow = null;
      });
      await this.sendMessage(chat.id, "Текущий шаг отменён.", {
        reply_markup: MAIN_KEYBOARD,
      });
      return;
    }

    if (isAdmin && await this.handleAdminInput(message)) return;

    if (text === "/start" || text === "/menu") {
      await this.mutateDb((db) => {
        if (db.users[String(from.id)]) db.users[String(from.id)].flow = null;
      });
      await this.sendMessage(
        chat.id,
        `Добро пожаловать в PseudoLegend.\nГород: ${CITY}\nРайон: ${DISTRICT}`,
        { reply_markup: MAIN_KEYBOARD },
      );
      return;
    }

    if (isAdmin && (text === "/admin" || text === "⚙️ Админ-панель")) {
      await this.showAdminMenu(chat.id, from.id);
      return;
    }

    if (text === "🛍 Каталог товаров" || text === "Каталог товаров") {
      await this.showCatalog(chat.id);
      return;
    }
    if (text === "👤 Профиль" || text === "Профиль") {
      const db = await this.readDb();
      const user = db.users[String(from.id)];
      await this.sendMessage(
        chat.id,
        `Профиль\nID: ${from.id}\nБаланс: ${money(user?.balance || 0)}\nГород: ${CITY}\nРайон: ${DISTRICT}`,
        { reply_markup: MAIN_KEYBOARD },
      );
      return;
    }
    if (text === "💳 Пополнить баланс" || text === "Пополнить баланс") {
      await this.mutateDb((db) => {
        db.users[String(from.id)].flow = { type: "topup_amount" };
      });
      await this.sendMessage(
        chat.id,
        "Введите сумму пополнения целым числом в гривнах (от 10 до 100 000).",
        { reply_markup: MAIN_KEYBOARD },
      );
      return;
    }
    if (text === "🆘 Поддержка / Контакты" || text === "Поддержка / Контакты") {
      const db = await this.readDb();
      await this.sendMessage(chat.id, db.supportText, {
        reply_markup: MAIN_KEYBOARD,
      });
      return;
    }

    const db = await this.readDb();
    const user = db.users[String(from.id)];
    if (user?.flow?.type === "topup_amount") {
      const amount = Number(text);
      if (!/^\d{1,6}$/.test(text) || amount < 10 || amount > 100000) {
        await this.sendMessage(
          chat.id,
          "Введите целую сумму от 10 до 100 000 грн.",
          { reply_markup: MAIN_KEYBOARD },
        );
        return;
      }
      await this.startPayment(from.id, chat.id, "topup", amount);
      return;
    }
    if (user?.flow?.type === "awaiting_receipt") {
      const image = imageFromMessage(message);
      if (!image) {
        await this.sendMessage(
          chat.id,
          "Пришлите фотографию квитанции или скриншот как изображение.",
          { reply_markup: MAIN_KEYBOARD },
        );
        return;
      }
      await this.submitReceipt(message, image, updateId);
      return;
    }

    if (isAdmin && text === "/admin") {
      await this.showAdminMenu(chat.id, from.id);
      return;
    }
    await this.sendMessage(
      chat.id,
      "Выберите действие в меню ниже.",
      { reply_markup: MAIN_KEYBOARD },
    );
  }

  async submitReceipt(message, image, updateId) {
    const userId = String(message.from.id);
    const db = await this.readDb();
    const flow = db.users[userId]?.flow;
    const pending = flow?.pendingId ? db.pending[flow.pendingId] : null;
    if (!pending || pending.status !== "awaiting_receipt") {
      await this.sendMessage(
        message.chat.id,
        "Активная заявка не найдена. Откройте каталог или начните новое пополнение.",
        { reply_markup: MAIN_KEYBOARD },
      );
      return;
    }

    const submitting = await this.mutateDb((current) => {
      const record = current.pending[pending.id];
      if (!record || record.status !== "awaiting_receipt") return null;
      record.status = "sending_receipt";
      record.receiptUpdateId = updateId;
      return {
        ...record,
        customerName: current.users[userId]?.name || `ID ${userId}`,
        username: current.users[userId]?.username || null,
      };
    });
    if (!submitting) return;

    const kindText = submitting.kind === "topup" ? "ПОПОЛНЕНИЕ БАЛАНСА" : "ЗАКАЗ";
    const caption = safeText(
      [
        `Заявка ${kindText} — ${submitting.id}`,
        `Пользователь: ${submitting.customerName}`,
        `Username: ${submitting.username ? `@${submitting.username}` : "не указан"}`,
        `Telegram ID: ${submitting.userId}`,
        `Сумма: ${money(submitting.amount)}`,
        submitting.productName ? `Товар: ${submitting.productName}` : "",
        `Город/район: ${CITY}, ${DISTRICT}`,
        `Дата: ${submitting.createdAt}`,
      ]
        .filter(Boolean)
        .join("\n"),
      1000,
    );
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: submitting.kind === "topup" ? "Зачислить баланс" : "Принять заказ", callback_data: `pay:approve:${submitting.id}` },
          { text: "Отклонить", callback_data: `pay:decline:${submitting.id}` },
        ],
      ],
    };

    try {
      await this.sendReceiptToAdmins(image, caption, replyMarkup);
    } catch (error) {
      await this.mutateDb((current) => {
        const record = current.pending[submitting.id];
        if (record?.status === "sending_receipt") record.status = "awaiting_receipt";
      });
      throw error;
    }

    await this.mutateDb((current) => {
      const record = current.pending[submitting.id];
      if (record?.status === "sending_receipt") record.status = "review";
      if (current.users[userId]) current.users[userId].flow = null;
    });
    await this.sendMessage(
      message.chat.id,
      "Квитанция отправлена администратору. Вы получите сообщение после проверки.",
      { reply_markup: MAIN_KEYBOARD },
    );
  }

  async showCatalog(chatId) {
    const db = await this.readDb();
    if (!db.products.length) {
      await this.sendMessage(chatId, "Каталог пока пуст.", {
        reply_markup: MAIN_KEYBOARD,
      });
      return;
    }
    const rows = db.products.map((product) => [
      {
        text: `${product.name} — ${money(product.price)}`,
        callback_data: `product:${product.id}`,
      },
    ]);
    await this.sendMessage(chatId, "Каталог товаров:", {
      reply_markup: { inline_keyboard: rows },
    });
  }

  async showProduct(chatId, product) {
    const text = `${product.name}\nЦена: ${money(product.price)}\n\n${product.description || "Описание не добавлено."}`;
    const keyboard = {
      inline_keyboard: [[
        { text: "Оформить заказ", callback_data: `buy:${product.id}` },
      ]],
    };
    if (product.photo) {
      try {
        await this.telegram("sendPhoto", {
          chat_id: chatId,
          photo: product.photo,
          caption: safeText(text, 1000),
          reply_markup: keyboard,
        });
        return;
      } catch {
        // A deleted Telegram file_id should not make the product inaccessible.
      }
    }
    await this.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  async showAdminMenu(chatId, userId) {
    const keyboard = [
      [{ text: "Изменить карту оплаты", callback_data: "adm:card" }],
      [{ text: "Товары и описания", callback_data: "adm:products" }],
      [{ text: "Изменить поддержку/контакты", callback_data: "adm:support" }],
      [{ text: "Заявки на проверке", callback_data: "adm:pending" }],
    ];
    if (this.isOwner(userId)) {
      keyboard.push([{ text: "Управление администраторами", callback_data: "owner:admins" }]);
      keyboard.push([{ text: "Изменения на подтверждение", callback_data: "change:list" }]);
    }
    await this.sendMessage(chatId, "Панель администратора PseudoLegend", {
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async showAdminList(chatId) {
    const db = await this.readDb();
    const entries = Object.values(db.admins);
    const adminLines = entries.length
      ? entries.map((admin) =>
        `• ${admin.name || `ID ${admin.id}`}${admin.username ? ` (@${admin.username})` : ""} — ID ${admin.id}`,
      )
      : ["Дополнительных администраторов пока нет."];
    const rows = [[{ text: "＋ Добавить по @нику", callback_data: "owner:add" }]];
    for (const admin of entries) {
      const label = admin.username
        ? `Удалить @${admin.username}`
        : `Удалить ID ${admin.id}`;
      rows.push([{ text: label.slice(0, 60), callback_data: `owner:remove:${admin.id}` }]);
    }
    await this.sendMessage(
      chatId,
      `Главный администратор: ID ${this.env.ADMIN_ID}\n\nДополнительные администраторы:\n${adminLines.join("\n")}`,
      { reply_markup: { inline_keyboard: rows } },
    );
  }

  applyChange(db, change) {
    if (change.type === "set_card") {
      db.encryptedCard = change.encryptedCard;
      return true;
    }
    if (change.type === "set_support") {
      db.supportText = change.text;
      return true;
    }
    if (change.type === "product_create") {
      if (db.products.some((product) => product.id === change.product.id)) return false;
      db.products.push(change.product);
      return true;
    }
    if (change.type === "product_update") {
      const product = db.products.find((item) => item.id === change.productId);
      if (!product) return false;
      Object.assign(product, change.patch);
      return true;
    }
    return false;
  }

  describeChange(db, change) {
    if (change.type === "set_card") {
      return `Изменение карты оплаты\nНовая карта заканчивается на ${change.lastFour}.`;
    }
    if (change.type === "set_support") {
      return `Изменение контактов поддержки\nНовый текст:\n${change.text}`;
    }
    if (change.type === "product_create") {
      const product = change.product;
      return [
        "Добавление товара",
        `Название: ${product.name}`,
        `Цена: ${money(product.price)}`,
        `Описание: ${product.description || "—"}`,
        `Фото: ${product.photo ? "прикреплено" : "нет"}`,
      ].join("\n");
    }
    if (change.type === "product_update") {
      const product = db.products.find((item) => item.id === change.productId);
      const patch = change.patch;
      return [
        `Изменение товара: ${product?.name || change.productId}`,
        patch.name !== undefined ? `Новое название: ${patch.name}` : "",
        patch.price !== undefined ? `Новая цена: ${money(patch.price)}` : "",
        patch.description !== undefined ? `Новое описание: ${patch.description}` : "",
        patch.photo !== undefined ? "Запрошена новая фотография товара." : "",
      ].filter(Boolean).join("\n");
    }
    return "Изменение настроек бота.";
  }

  async submitChangeRequest(requester, change) {
    if (this.isOwner(requester.id)) {
      const applied = await this.mutateDb((db) => this.applyChange(db, change));
      return { status: applied ? "applied" : "error" };
    }

    const id = crypto.randomUUID().slice(0, 12);
    const request = await this.mutateDb((db) => {
      const user = db.users[String(requester.id)];
      const item = {
        id,
        requesterId: String(requester.id),
        requesterName: user?.name || userName(requester),
        requesterUsername: user?.username || requester.username || null,
        change,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      db.changeRequests[id] = item;
      return item;
    });

    try {
      await this.notifyChangeRequest(request, await this.readDb());
    } catch (error) {
      console.error("Change request notification failed:", error?.message || error);
    }
    return { status: "pending", id };
  }

  async notifyChangeRequest(request, db) {
    const detail = this.describeChange(db, request.change);
    const text = safeText(
      `ЗАПРОС ИЗМЕНЕНИЯ ${request.id}\nОт: ${request.requesterName}${request.requesterUsername ? ` (@${request.requesterUsername})` : ""}\n\n${detail}`,
      1000,
    );
    const photo = request.change.type === "product_create"
      ? request.change.product.photo
      : request.change.type === "product_update"
        ? request.change.patch.photo
        : null;
    const replyMarkup = {
      inline_keyboard: [[
        { text: "Подтвердить", callback_data: `change:approve:${request.id}` },
        { text: "Отклонить", callback_data: `change:decline:${request.id}` },
      ]],
    };
    if (photo) {
      await this.telegram("sendPhoto", {
        chat_id: this.env.ADMIN_ID,
        photo,
        caption: text,
        reply_markup: replyMarkup,
      });
    } else {
      await this.sendMessage(this.env.ADMIN_ID, text, { reply_markup: replyMarkup });
    }
  }

  async showChangeRequests(chatId) {
    const db = await this.readDb();
    const requests = Object.values(db.changeRequests)
      .filter((item) => item.status === "pending")
      .slice(0, 30);
    if (!requests.length) {
      await this.sendMessage(chatId, "Нет изменений, ожидающих подтверждения.");
      return;
    }
    const rows = requests.map((item) => [{
      text: `${item.id} — ${item.requesterUsername ? `@${item.requesterUsername}` : item.requesterName}`,
      callback_data: `change:view:${item.id}`,
    }]);
    await this.sendMessage(chatId, "Изменения на подтверждение:", {
      reply_markup: { inline_keyboard: rows },
    });
  }

  async showChangeRequest(chatId, request) {
    const db = await this.readDb();
    const text = safeText(
      `ЗАПРОС ИЗМЕНЕНИЯ ${request.id}\nОт: ${request.requesterName}${request.requesterUsername ? ` (@${request.requesterUsername})` : ""}\n\n${this.describeChange(db, request.change)}`,
      1000,
    );
    const replyMarkup = {
      inline_keyboard: [[
        { text: "Подтвердить", callback_data: `change:approve:${request.id}` },
        { text: "Отклонить", callback_data: `change:decline:${request.id}` },
      ]],
    };
    const photo = request.change.type === "product_create"
      ? request.change.product.photo
      : request.change.type === "product_update"
        ? request.change.patch.photo
        : null;
    if (photo) {
      await this.telegram("sendPhoto", {
        chat_id: chatId,
        photo,
        caption: text,
        reply_markup: replyMarkup,
      });
    } else {
      await this.sendMessage(chatId, text, { reply_markup: replyMarkup });
    }
  }

  async handleChangeAction(chatId, adminId, data) {
    const [, action, requestId] = data.split(":");
    const db = await this.readDb();
    const request = db.changeRequests[requestId];
    if (!request) {
      await this.sendMessage(chatId, "Запрос изменения не найден.");
      return;
    }
    if (action === "view") {
      await this.showChangeRequest(chatId, request);
      return;
    }
    if (action !== "approve" && action !== "decline") return;

    const result = await this.mutateDb((current) => {
      const item = current.changeRequests[requestId];
      if (!item || item.status !== "pending") return { ok: false };
      if (action === "approve" && !this.applyChange(current, item.change)) {
        return { ok: false, invalid: true };
      }
      item.status = action === "approve" ? "approved" : "declined";
      item.reviewedAt = new Date().toISOString();
      item.reviewedBy = String(adminId);
      return { ok: true, item: { ...item } };
    });
    if (!result.ok) {
      await this.sendMessage(
        chatId,
        result.invalid
          ? "Не удалось применить изменение: товар не найден или запрос некорректен."
          : "Этот запрос уже обработан или не найден.",
      );
      return;
    }

    const item = result.item;
    const statusText = action === "approve"
      ? "Главный администратор подтвердил ваше изменение."
      : "Главный администратор отклонил ваше изменение.";
    try {
      await this.sendMessage(item.requesterId, statusText);
    } catch (error) {
      console.error("Change decision notification failed:", error?.message || error);
    }
    await this.sendMessage(
      chatId,
      action === "approve" ? "Изменение применено." : "Запрос отклонён.",
    );
  }

  async showAdminProducts(chatId) {
    const db = await this.readDb();
    const rows = db.products.map((product) => [{
      text: `${product.name} — ${money(product.price)}`,
      callback_data: `adm:product:${product.id}`,
    }]);
    rows.push([{ text: "＋ Добавить товар", callback_data: "adm:add" }]);
    await this.sendMessage(chatId, "Выберите товар для изменения:", {
      reply_markup: { inline_keyboard: rows },
    });
  }

  async handleAdminInput(message) {
    const text = String(message.text || "").trim();
    const image = imageFromMessage(message);
    const db = await this.readDb();
    const flow = db.users[String(message.from.id)]?.flow;
    if (!flow?.type?.startsWith("admin_")) return false;

    if (flow.type === "admin_add_admin") {
      if (!this.isOwner(message.from.id)) {
        await this.sendMessage(message.chat.id, "Добавлять администраторов может только главный администратор.");
        return true;
      }
      const username = normalizeUsername(text);
      if (!/^[a-z0-9_]{5,32}$/i.test(username)) {
        await this.sendMessage(message.chat.id, "Введите корректный Telegram-ник, например @username.");
        return true;
      }
      const invitedUser = Object.values(db.users).find(
        (user) => normalizeUsername(user.username) === username,
      );
      if (!invitedUser) {
        await this.sendMessage(
          message.chat.id,
          `Пользователь @${username} ещё не запускал бота. Попросите его отправить /start, затем добавьте ник повторно.`,
        );
        return true;
      }
      if (this.isOwner(invitedUser.id)) {
        await this.sendMessage(message.chat.id, "Это главный администратор.");
        return true;
      }
      const added = await this.mutateDb((current) => {
        if (current.admins[invitedUser.id]) return false;
        current.admins[invitedUser.id] = {
          id: invitedUser.id,
          name: invitedUser.name,
          username: invitedUser.username,
          addedBy: String(message.from.id),
          addedAt: new Date().toISOString(),
        };
        current.users[String(message.from.id)].flow = null;
        return true;
      });
      if (!added) {
        await this.sendMessage(message.chat.id, `@${username} уже является администратором.`);
        return true;
      }
      await this.sendMessage(
        message.chat.id,
        `@${username} добавлен как администратор. Он сможет принимать заявки и редактировать каталог.`,
      );
      await this.sendMessage(
        invitedUser.id,
        "Вам предоставлен доступ администратора PseudoLegend. Используйте /admin для панели.",
      );
      return true;
    }

    if (flow.type === "admin_card") {
      const card = text.replace(/[ -]/g, "");
      if (!/^\d{12,19}$/.test(card)) {
        await this.sendMessage(message.chat.id, "Введите номер карты цифрами (12–19 цифр).");
        return true;
      }
      const encryptedCard = await encryptCard(card, this.env);
      await this.mutateDb((current) => {
        current.users[String(message.from.id)].flow = null;
      });
      const result = await this.submitChangeRequest(message.from, {
        type: "set_card",
        encryptedCard,
        lastFour: card.slice(-4),
      });
      await this.sendMessage(
        message.chat.id,
        result.status === "applied"
          ? "Номер карты сохранён в зашифрованном виде."
          : "Изменение карты отправлено главному администратору на подтверждение.",
      );
      return true;
    }

    if (flow.type === "admin_support") {
      if (!text || text.length > 500) {
        await this.sendMessage(message.chat.id, "Введите текст контактов длиной до 500 символов.");
        return true;
      }
      await this.mutateDb((current) => {
        current.users[String(message.from.id)].flow = null;
      });
      const result = await this.submitChangeRequest(message.from, {
        type: "set_support",
        text,
      });
      await this.sendMessage(
        message.chat.id,
        result.status === "applied"
          ? "Контакты поддержки обновлены."
          : "Изменение контактов отправлено главному администратору на подтверждение.",
      );
      return true;
    }

    if (flow.type === "admin_edit_name") {
      if (!text || text.length > 80) {
        await this.sendMessage(message.chat.id, "Введите название товара длиной до 80 символов.");
        return true;
      }
      await this.mutateDb((current) => {
        current.users[String(message.from.id)].flow = null;
      });
      const result = await this.submitChangeRequest(message.from, {
        type: "product_update",
        productId: flow.productId,
        patch: { name: text },
      });
      await this.sendMessage(
        message.chat.id,
        result.status === "applied"
          ? "Название товара обновлено."
          : "Изменение названия отправлено главному администратору на подтверждение.",
      );
      return true;
    }

    if (flow.type === "admin_new_name") {
      if (!text || text.length > 80) {
        await this.sendMessage(message.chat.id, "Введите название товара длиной до 80 символов.");
        return true;
      }
      const id = `p-${crypto.randomUUID().slice(0, 8)}`;
      await this.mutateDb((current) => {
        current.users[String(message.from.id)].flow = {
          type: "admin_price",
          productId: id,
          mode: "new",
          draft: {
            id,
            name: text,
            price: 0,
            description: "",
            photo: null,
          },
        };
      });
      await this.sendMessage(message.chat.id, "Теперь отправьте цену целым числом в гривнах.");
      return true;
    }

    if (flow.type === "admin_price") {
      const price = Number(text);
      if (!/^\d{1,7}$/.test(text) || price < 1 || price > 10000000) {
        await this.sendMessage(message.chat.id, "Введите цену целым числом от 1 до 10 000 000 грн.");
        return true;
      }
      if (flow.mode === "new") {
        await this.mutateDb((current) => {
          current.users[String(message.from.id)].flow = {
            type: "admin_description",
            productId: flow.productId,
            draft: { ...flow.draft, price },
          };
        });
        await this.sendMessage(message.chat.id, "Отправьте описание товара.");
      } else {
        await this.mutateDb((current) => {
          current.users[String(message.from.id)].flow = null;
        });
        const result = await this.submitChangeRequest(message.from, {
          type: "product_update",
          productId: flow.productId,
          patch: { price },
        });
        await this.sendMessage(
          message.chat.id,
          result.status === "applied"
            ? "Цена обновлена."
            : "Изменение цены отправлено главному администратору на подтверждение.",
        );
      }
      return true;
    }

    if (flow.type === "admin_description") {
      if (!text || text.length > 2500) {
        await this.sendMessage(message.chat.id, "Введите описание длиной до 2500 символов.");
        return true;
      }
      if (flow.draft) {
        await this.mutateDb((current) => {
          current.users[String(message.from.id)].flow = {
            type: "admin_image",
            productId: flow.productId,
            draft: { ...flow.draft, description: text },
          };
        });
        await this.sendMessage(
          message.chat.id,
          "Отправьте фотографию товара или напишите /skip, чтобы пропустить.",
        );
      } else {
        await this.mutateDb((current) => {
          current.users[String(message.from.id)].flow = null;
        });
        const result = await this.submitChangeRequest(message.from, {
          type: "product_update",
          productId: flow.productId,
          patch: { description: text },
        });
        await this.sendMessage(
          message.chat.id,
          result.status === "applied"
            ? "Описание обновлено."
            : "Изменение описания отправлено главному администратору на подтверждение.",
        );
      }
      return true;
    }

    if (flow.type === "admin_image") {
      if (text === "/skip") {
        const result = await this.submitChangeRequest(message.from, {
          type: "product_create",
          product: { ...flow.draft, photo: null },
        });
        await this.mutateDb((current) => {
          current.users[String(message.from.id)].flow = null;
        });
        await this.sendMessage(
          message.chat.id,
          result.status === "applied"
            ? "Товар создан без фотографии."
            : "Товар отправлен главному администратору на подтверждение.",
        );
        return true;
      }
      if (!image) {
        await this.sendMessage(message.chat.id, "Отправьте фотографию или /skip.");
        return true;
      }
      const result = await this.submitChangeRequest(message.from, {
        type: "product_create",
        product: { ...flow.draft, photo: image.fileId },
      });
      await this.mutateDb((current) => {
        current.users[String(message.from.id)].flow = null;
      });
      await this.sendMessage(
        message.chat.id,
        result.status === "applied"
          ? "Товар создан с фотографией."
          : "Товар и фотография отправлены главному администратору на подтверждение.",
      );
      return true;
    }

    if (flow.type === "admin_edit_description") {
      if (!text || text.length > 2500) {
        await this.sendMessage(message.chat.id, "Введите описание длиной до 2500 символов.");
        return true;
      }
      await this.mutateDb((current) => {
        current.users[String(message.from.id)].flow = null;
      });
      const result = await this.submitChangeRequest(message.from, {
        type: "product_update",
        productId: flow.productId,
        patch: { description: text },
      });
      await this.sendMessage(
        message.chat.id,
        result.status === "applied"
          ? "Описание обновлено."
          : "Изменение описания отправлено главному администратору на подтверждение.",
      );
      return true;
    }

    if (flow.type === "admin_edit_image") {
      if (!image) {
        await this.sendMessage(message.chat.id, "Отправьте фотографию товара.");
        return true;
      }
      await this.mutateDb((current) => {
        current.users[String(message.from.id)].flow = null;
      });
      const result = await this.submitChangeRequest(message.from, {
        type: "product_update",
        productId: flow.productId,
        patch: { photo: image.fileId },
      });
      await this.sendMessage(
        message.chat.id,
        result.status === "applied"
          ? "Фотография товара обновлена."
          : "Изменение фотографии отправлено главному администратору на подтверждение.",
      );
      return true;
    }

    return false;
  }

  async handleCallback(query) {
    const from = query.from;
    const chatId = query.message?.chat?.id;
    const data = String(query.data || "");
    try {
      if (chatId == null) return;
      const isOwnerOnly =
        data.startsWith("owner:") ||
        data.startsWith("change:");
      const allowed = isOwnerOnly
        ? this.isOwner(from.id)
        : data.startsWith("adm:") || data.startsWith("pay:")
          ? await this.isAdmin(from.id)
          : true;
      if (!allowed) {
        await this.telegram("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "Нет доступа.",
          show_alert: true,
        });
        return;
      }
      await this.telegram("answerCallbackQuery", { callback_query_id: query.id });

      if (data === "owner:admins") {
        await this.showAdminList(chatId);
        return;
      }
      if (data === "owner:add") {
        await this.mutateDb((db) => {
          db.users[String(from.id)] ||= {
            id: String(from.id),
            name: userName(from),
            username: from.username || null,
            balance: 0,
            flow: null,
          };
          db.users[String(from.id)].flow = { type: "admin_add_admin" };
        });
        await this.sendMessage(
          chatId,
          "Введите @ник пользователя. Сначала он должен открыть бота и отправить /start.",
        );
        return;
      }
      if (data.startsWith("owner:remove:")) {
        const adminId = data.slice("owner:remove:".length);
        const removed = await this.mutateDb((db) => {
          if (!db.admins[adminId]) return false;
          delete db.admins[adminId];
          return true;
        });
        await this.sendMessage(
          chatId,
          removed ? `Администратор ID ${adminId} удалён.` : "Администратор не найден.",
        );
        return;
      }
      if (data === "change:list") {
        await this.showChangeRequests(chatId);
        return;
      }
      if (data.startsWith("change:")) {
        await this.handleChangeAction(chatId, from.id, data);
        return;
      }
      if (data === "adm:card") {
        await this.mutateDb((db) => {
          db.users[String(from.id)] ||= { id: String(from.id), name: userName(from), balance: 0, flow: null };
          db.users[String(from.id)].flow = { type: "admin_card" };
        });
        await this.sendMessage(chatId, "Отправьте номер карты цифрами. Он будет зашифрован перед сохранением.");
        return;
      }
      if (data === "adm:products") {
        await this.showAdminProducts(chatId);
        return;
      }
      if (data === "adm:add") {
        await this.mutateDb((db) => {
          db.users[String(from.id)].flow = { type: "admin_new_name" };
        });
        await this.sendMessage(chatId, "Введите название нового товара.");
        return;
      }
      if (data === "adm:support") {
        await this.mutateDb((db) => {
          db.users[String(from.id)].flow = { type: "admin_support" };
        });
        await this.sendMessage(chatId, "Отправьте текст контактов поддержки (до 500 символов).");
        return;
      }
      if (data === "adm:pending") {
        await this.showPending(chatId);
        return;
      }
      if (data.startsWith("adm:product:")) {
        const id = data.slice("adm:product:".length);
        const db = await this.readDb();
        const product = db.products.find((item) => item.id === id);
        if (!product) {
          await this.sendMessage(chatId, "Товар не найден.");
          return;
        }
        await this.sendMessage(chatId, `${product.name}\n${money(product.price)}\n\n${product.description || "Описание не добавлено."}`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Изменить название", callback_data: `adm:name:${id}` }],
              [{ text: "Изменить цену", callback_data: `adm:price:${id}` }],
              [{ text: "Изменить описание", callback_data: `adm:desc:${id}` }],
              [{ text: "Изменить фото", callback_data: `adm:image:${id}` }],
            ],
          },
        });
        return;
      }
      if (data.startsWith("adm:name:")) {
        const productId = data.slice("adm:name:".length);
        await this.mutateDb((db) => {
          db.users[String(from.id)].flow = { type: "admin_edit_name", productId };
        });
        await this.sendMessage(chatId, "Отправьте новое название товара.");
        return;
      }
      if (data.startsWith("adm:price:")) {
        const productId = data.slice("adm:price:".length);
        await this.mutateDb((db) => {
          db.users[String(from.id)].flow = { type: "admin_price", productId, mode: "edit" };
        });
        await this.sendMessage(chatId, "Введите новую цену целым числом в гривнах.");
        return;
      }
      if (data.startsWith("adm:desc:")) {
        const productId = data.slice("adm:desc:".length);
        await this.mutateDb((db) => {
          db.users[String(from.id)].flow = { type: "admin_edit_description", productId };
        });
        await this.sendMessage(chatId, "Отправьте новое описание товара.");
        return;
      }
      if (data.startsWith("adm:image:")) {
        const productId = data.slice("adm:image:".length);
        await this.mutateDb((db) => {
          db.users[String(from.id)].flow = { type: "admin_edit_image", productId };
        });
        await this.sendMessage(chatId, "Отправьте новую фотографию товара.");
        return;
      }
      if (data.startsWith("pay:")) {
        await this.handlePaymentDecision(chatId, from, data);
        return;
      }
      if (data.startsWith("product:")) {
        await this.ensureUser(from);
        const productId = data.slice("product:".length);
        const db = await this.readDb();
        const product = db.products.find((item) => item.id === productId);
        if (product) await this.showProduct(chatId, product);
        else await this.sendMessage(chatId, "Товар больше недоступен.");
        return;
      }
      if (data.startsWith("buy:")) {
        const productId = data.slice("buy:".length);
        const db = await this.readDb();
        const product = db.products.find((item) => item.id === productId);
        if (!product) {
          await this.sendMessage(chatId, "Товар больше недоступен.");
          return;
        }
        await this.ensureUser(from);
        await this.startPayment(from.id, chatId, "order", product.price, product);
      }
    } catch (error) {
      console.error("Callback failed:", error?.message || error);
      try {
        await this.sendMessage(chatId, "Не удалось выполнить действие. Попробуйте ещё раз.");
      } catch {
        // Telegram retries failed webhook updates when the request returns 5xx.
      }
      throw error;
    }
  }

  async showPending(chatId) {
    const db = await this.readDb();
    const pending = Object.values(db.pending).filter((item) => item.status === "review");
    if (!pending.length) {
      await this.sendMessage(chatId, "Заявок на проверке нет.");
      return;
    }
    const rows = pending.slice(0, 30).map((item) => [{
      text: `${item.kind === "topup" ? "Пополнение" : "Заказ"} ${item.id} — ${money(item.amount)}`,
      callback_data: `pay:inspect:${item.id}`,
    }]);
    await this.sendMessage(chatId, "Заявки, ожидающие проверки:", {
      reply_markup: { inline_keyboard: rows },
    });
  }

  async handlePaymentDecision(chatId, admin, data) {
    const [, action, pendingId] = data.split(":");
    if (action === "inspect") {
      const db = await this.readDb();
      const item = db.pending[pendingId];
      if (!item) {
        await this.sendMessage(chatId, "Заявка не найдена.");
        return;
      }
      await this.sendMessage(
        chatId,
        `Заявка ${item.id}\nТип: ${item.kind === "topup" ? "пополнение" : "заказ"}\nПользователь ID: ${item.userId}\nСумма: ${money(item.amount)}\nТовар: ${item.productName || "—"}\nСтатус: ${item.status}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: item.kind === "topup" ? "Зачислить баланс" : "Принять заказ", callback_data: `pay:approve:${item.id}` },
              { text: "Отклонить", callback_data: `pay:decline:${item.id}` },
            ]],
          },
        },
      );
      return;
    }

    if (action !== "approve" && action !== "decline") return;
    const result = await this.mutateDb((db) => {
      const item = db.pending[pendingId];
      if (!item) {
        return { ok: false, reason: "not_found" };
      }
      if (item.status !== "review") {
        const expectedStatus = action === "approve" ? "approved" : "declined";
        if (
          item.status === expectedStatus &&
          item.reviewedBy === String(admin.id) &&
          !item.userNotified
        ) {
          return { ok: true, item: { ...item } };
        }
        return { ok: false, reason: item?.status || "not_found" };
      }
      if (action === "approve" && item.kind === "topup" && !db.users[item.userId]) {
        return { ok: false, reason: "user_not_found" };
      }
      item.status = action === "approve" ? "approved" : "declined";
      item.reviewedAt = new Date().toISOString();
      item.reviewedBy = String(admin.id);
      item.userNotified = false;
      if (action === "approve" && item.kind === "topup") {
        const user = db.users[item.userId];
        user.balance = Number(user.balance || 0) + Number(item.amount);
      }
      return { ok: true, item: { ...item } };
    });

    if (!result.ok) {
      await this.sendMessage(chatId, `Заявка уже обработана или не найдена (${result.reason}).`);
      return;
    }
    const item = result.item;
    const notice = action === "approve"
      ? item.kind === "topup"
        ? `Пополнение ${money(item.amount)} подтверждено.`
        : `Ваш заказ «${item.productName}» принят.`
      : `Заявка ${item.kind === "topup" ? "на пополнение" : "на заказ"} отклонена. Свяжитесь с поддержкой, если это ошибка.`;
    if (!item.userNotified) {
      await this.sendMessage(item.userId, notice, { reply_markup: MAIN_KEYBOARD });
      await this.mutateDb((db) => {
        const current = db.pending[pendingId];
        if (current) current.userNotified = true;
      });
    }
    await this.sendMessage(
      chatId,
      action === "approve"
        ? item.kind === "topup"
          ? `Баланс пользователя ${item.userId} пополнен на ${money(item.amount)}.`
          : `Заказ ${item.id} принят.`
        : `Заявка ${item.id} отклонена.`,
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/update") {
      return new Response("Not found", { status: 404 });
    }
    try {
      const update = await request.json();
      const updateId = update.update_id;
      if (updateId != null) {
        const db = await this.readDb();
        if (db.processedUpdates.includes(updateId)) return Response.json({ ok: true });
      }

      if (update.message) await this.handleMessage(update.message, updateId);
      if (update.callback_query) await this.handleCallback(update.callback_query);

      if (updateId != null) {
        await this.mutateDb((db) => {
          db.processedUpdates.push(updateId);
          if (db.processedUpdates.length > 1000) {
            db.processedUpdates.splice(0, db.processedUpdates.length - 1000);
          }
        });
      }
      return Response.json({ ok: true });
    } catch (error) {
      console.error("Update handler failed:", error?.message || error);
      return new Response("Update failed", { status: 500 });
    }
  }
}
