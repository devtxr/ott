// ---------------- HARDCODED CONFIGURATION ----------------
const CONFIG = {
  BOT_TOKEN: "8885018648:AAGDidc1I2MyG-arBYqN0HyVI8xKa9HmEmo",
  ADMIN_ID: "6014400840",
  FIREBASE_PROJECT_ID: "devt-xr",
  WEBHOOK_SECRET: "hw882hwvs"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (CONFIG.WEBHOOK_SECRET && secretToken !== CONFIG.WEBHOOK_SECRET) {
        console.error("Webhook secret mismatch!");
        return new Response("Unauthorized", { status: 403 });
      }

      try {
        const update = await request.json();
        await handleTelegramUpdate(update);
      } catch (e) {
        console.error("CRITICAL ERROR IN BOT LOGIC:", e.stack || e.message || e);
      }
      return new Response("OK");
    }

    if (url.pathname.startsWith("/api/v2/")) {
      return await handleApiRequests(request, url);
    }

    return new Response("Bot Provider Server Running!");
  }
};

// ---------------- TELEGRAM BOT LOGIC ----------------

async function handleTelegramUpdate(update) {
  const ADMIN_ID = CONFIG.ADMIN_ID;

  if (update.inline_query) {
    await handleInlineQuery(update.inline_query);
    return;
  }

  if (update.pre_checkout_query) {
    await answerPreCheckoutQuery(update.pre_checkout_query.id, true);
    return;
  }

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id.toString();
    const text = msg.text || "";

    if (msg.successful_payment) {
      const starsPaid = msg.successful_payment.total_amount;
      const usdValue = (starsPaid * 0.02).toFixed(2);

      let user = await getFirebaseDoc("users", chatId) || {};
      user.balance = (Number(user.balance) || 0) + Number(usdValue);
      await setFirebaseDoc("users", chatId, user);

      await sendMessage(chatId, `🎉 <b>Payment Successful!</b>\nAdded <b>$${usdValue}</b> to your wallet balance.`);
      return;
    }

    let user = await getFirebaseDoc("users", chatId);
    if (!user) {
      user = { chatId: chatId, balance: 0, totalPurchased: 0, apiKey: generateApiKey(), joinedAt: new Date().toISOString() };
      await setFirebaseDoc("users", chatId, user);
    }

    const state = await getFirebaseDoc("states", chatId);
    if (state && state.action) {
      await handleStateInputs(chatId, text, state);
      await deleteFirebaseDoc("states", chatId);
      return;
    }

    if (text === "/start") {
      await sendMainMenu(chatId);
    } else if (text === "/admin" && chatId === ADMIN_ID) {
      await sendAdminPanel(chatId);
    } else if (text === "🛍️ Products" || text === "🛒 Buy") {
      await sendCategoryProducts(chatId);
    } else if (text === "📜 Order History") {
      await sendOrderHistory(chatId);
    } else if (text === "👛 Wallet") {
      await sendMessage(chatId, `<b>👤 PROFILE & WALLET</b>\n\nID: <code>${chatId}</code>\nBalance: <b>$${user.balance || 0}</b>`);
    } else if (text === "⭐️ Add Stars Balance") {
      await setFirebaseDoc("states", chatId, { action: "BUY_STARS" });
      await sendMessage(chatId, "⭐ Enter amount of <b>Telegram Stars</b> to top up:");
    } else if (text === "💬 Support") {
      await sendMessage(chatId, "💬 Support Bot: https://t.me/Somnathtxr_sbot");
    } else if (text === "🔗 API") {
      const workerDomain = "https://apiott.codescan.workers.dev";

      const apiInfo = `<b>🗣️ YOUR API CREDENTIALS & DOCUMENTATION</b>\n\n` +
        `🔑 <b>Your Personal API Key:</b>\n<code>${user.apiKey}</code>\n\n` +
        `───────────────────\n` +
        `📌 <b>1. Get Product List & IDs</b>\n` +
        `<b>Method:</b> <code>GET</code>\n` +
        `<b>Endpoint:</b> <code>${workerDomain}/api/v2/products</code>\n\n` +
        `<b>Header:</b>\n<code>X-API-KEY: ${user.apiKey}</code>\n\n` +
        `───────────────────\n` +
        `📌 <b>2. Get Product Details by Product Key</b>\n` +
        `<b>Method:</b> <code>GET</code>\n` +
        `<b>Endpoint:</b>\n<code>${workerDomain}/api/v2/product_data?product_key=YOUR_PRODUCT_KEY&api_key=${user.apiKey}</code>`;

      await sendMessage(chatId, apiInfo);
    }

  } else if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id.toString();
    const messageId = cb.message.message_id;
    const data = cb.data;

    if (chatId === ADMIN_ID) {
      if (data === "admin_add_product") {
        await setFirebaseDoc("states", chatId, { action: "ADD_PROD_TITLE" });
        await sendMessage(chatId, "📦 Enter Product Title:");
      } else if (data === "admin_add_stock") {
        await setFirebaseDoc("states", chatId, { action: "BULK_STOCK_PROD_ID" });
        await sendMessage(chatId, "🔑 Enter Product ID to add stock:");
      }
    }

    if (data.startsWith("prod_view_")) {
      const prodId = data.replace("prod_view_", "");
      await sendProductCard(chatId, prodId, 1);

    } else if (data.startsWith("qty_")) {
      const parts = data.split("_");
      const prodId = parts[1];
      let qty = parseInt(parts[2]);
      qty = isNaN(qty) || qty < 1 ? 1 : qty;
      await updateProductCard(chatId, messageId, prodId, qty);

    } else if (data.startsWith("checkout_")) {
      const parts = data.split("_");
      const prodId = parts[1];
      const qty = parseInt(parts[2]);
      await processDirectPurchase(chatId, prodId, qty);
    }
  }
}

// ---------------- PURCHASE & PRODUCT KEY GENERATION ----------------

async function processDirectPurchase(chatId, productId, quantity) {
  const user = await getFirebaseDoc("users", chatId);
  const product = await getFirebaseDoc("products", productId);

  let stockList = product && product.stockQueue ? product.stockQueue.split("\n").filter(Boolean) : [];

  if (!product || stockList.length < quantity) {
    return sendMessage(chatId, `❌ Not enough stock! Available: ${stockList.length} Pcs.`);
  }

  const totalCost = product.price * quantity;
  if (Number(user.balance) < totalCost) {
    return sendMessage(chatId, `❌ Insufficient balance! Required: $${totalCost.toFixed(2)}, Current: $${user.balance || 0}`);
  }

  const deliveredItems = stockList.splice(0, quantity);
  product.stockQueue = stockList.join("\n");

  user.balance = Number(user.balance) - totalCost;
  user.totalPurchased = (Number(user.totalPurchased) || 0) + totalCost;

  await setFirebaseDoc("users", chatId, user);
  await setFirebaseDoc("products", productId, product);

  const productKey = "PK-" + Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const orderId = "ORD_" + Date.now();

  const orderData = {
    orderId: orderId,
    productKey: productKey,
    userId: chatId,
    productId: productId,
    productTitle: product.title,
    price: totalCost,
    deliveredData: deliveredItems.join("\n"),
    quantity: quantity,
    boughtAt: new Date().toISOString()
  };

  await setFirebaseDoc("orders", orderId, orderData);
  await setFirebaseDoc("product_keys", productKey, orderData);

  const deliveryMsg = `✅ <b>Purchase Successful!</b>\n\n` +
    `📦 <b>Item:</b> ${product.title}\n` +
    `🔢 <b>Quantity:</b> ${quantity} Pcs\n` +
    `💰 <b>Total Paid:</b> $${totalCost.toFixed(2)}\n\n` +
    `🔑 <b>Generated Product Key:</b>\n<code>${productKey}</code>\n\n` +
    `📄 <b>Product Data / Content:</b>\n<code>${deliveredItems.join("\n")}</code>`;

  await sendMessage(chatId, deliveryMsg);
}

// ---------------- EXTERNAL API SYSTEM ----------------

async function handleApiRequests(request, url) {
  if (url.pathname === "/api/v2/products" && request.method === "GET") {
    const products = await getFirebaseCollection("products");
    const formatted = products.map(p => {
      const stock = p.stockQueue ? p.stockQueue.split("\n").filter(Boolean).length : 0;
      return { product_id: p.id, title: p.title, price: p.price, stock: stock };
    });
    return new Response(JSON.stringify({ success: true, products: formatted }), { headers: { "Content-Type": "application/json" } });
  }

  if (url.pathname === "/api/v2/product_data" && request.method === "GET") {
    const productKey = url.searchParams.get("product_key");
    const apiKey = url.searchParams.get("api_key") || request.headers.get("X-API-KEY");

    if (!productKey) {
      return new Response(JSON.stringify({ success: false, message: "Missing 'product_key' parameter" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    if (apiKey) {
      const users = await getFirebaseCollection("users");
      const user = users.find(u => u.apiKey === apiKey);
      if (!user) {
        return new Response(JSON.stringify({ success: false, message: "Invalid API Key" }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
    }

    const keyData = await getFirebaseDoc("product_keys", productKey);

    if (!keyData) {
      return new Response(JSON.stringify({ success: false, message: "Invalid or Expired Product Key" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      success: true,
      product_key: keyData.productKey,
      order_id: keyData.orderId,
      product_id: keyData.productId,
      product_title: keyData.productTitle,
      price_paid: keyData.price,
      quantity: keyData.quantity,
      delivered_data: keyData.deliveredData,
      purchased_at: keyData.boughtAt
    }), { headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ success: false, message: "Endpoint not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
}

// ---------------- INLINE SEARCH ENGINE ----------------

async function handleInlineQuery(inlineQuery) {
  const query = inlineQuery.query.toLowerCase().trim();
  const products = await getFirebaseCollection("products");
  const filtered = products.filter(p => p.title.toLowerCase().includes(query));

  const results = filtered.map(p => {
    const stockCount = p.stockQueue ? p.stockQueue.split("\n").filter(Boolean).length : 0;
    return {
      type: "article",
      id: p.id,
      title: `${p.title} | $${p.price}`,
      description: `Stock: ${stockCount} left`,
      thumb_url: p.imageUrl || "https://via.placeholder.com/150",
      input_message_content: {
        message_text: `<b>${p.title}</b>\nPrice: $${p.price}\nStock: ${stockCount}`,
        parse_mode: "HTML"
      },
      reply_markup: {
        inline_keyboard: [[{ text: "🛍️ Select Quantity & Buy", callback_data: `prod_view_${p.id}` }]]
      }
    };
  });

  await fetch(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/answerInlineQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inline_query_id: inlineQuery.id, results: results.slice(0, 25), cache_time: 1 })
  });
}

// ---------------- UI & QUANTITY SELECTOR ----------------

async function sendCategoryProducts(chatId) {
  const products = await getFirebaseCollection("products");
  if (!products.length) return sendMessage(chatId, "No products available.");

  const buttons = products.map(p => {
    const stockCount = p.stockQueue ? p.stockQueue.split("\n").filter(Boolean).length : 0;
    return [{ text: `${p.title} | $${p.price} | 📦 ${stockCount}`, callback_data: `prod_view_${p.id}` }];
  });

  buttons.unshift([{ text: "🔍 Search Products via Inline Mode", switch_inline_query_current_chat: "" }]);
  await sendMessage(chatId, "<b>🛍️ Products Catalog:</b>", { inline_keyboard: buttons });
}

async function sendProductCard(chatId, prodId, qty) {
  const p = await getFirebaseDoc("products", prodId);
  if (!p) return sendMessage(chatId, "❌ Product not found!");

  const stockCount = p.stockQueue ? p.stockQueue.split("\n").filter(Boolean).length : 0;
  const totalPrice = (p.price * qty).toFixed(2);

  const caption = `<b>📦 ${p.title}</b>\n\n` +
    `💵 <b>Unit Price:</b> $${p.price}\n` +
    `📊 <b>Stock Left:</b> ${stockCount} Pcs\n` +
    `🛒 <b>Selected Quantity:</b> ${qty}\n` +
    `💰 <b>Total Cost:</b> <u>$${totalPrice}</u>`;

  const keyboard = getQuantityKeyboard(prodId, qty, stockCount);

  if (p.imageUrl && p.imageUrl.startsWith("http")) {
    await sendPhoto(chatId, p.imageUrl, caption, keyboard);
  } else {
    await sendMessage(chatId, caption, keyboard);
  }
}

async function updateProductCard(chatId, messageId, prodId, qty) {
  const p = await getFirebaseDoc("products", prodId);
  if (!p) return;

  const stockCount = p.stockQueue ? p.stockQueue.split("\n").filter(Boolean).length : 0;
  const totalPrice = (p.price * qty).toFixed(2);

  const caption = `<b>📦 ${p.title}</b>\n\n` +
    `💵 <b>Unit Price:</b> $${p.price}\n` +
    `📊 <b>Stock Left:</b> ${stockCount} Pcs\n` +
    `🛒 <b>Selected Quantity:</b> ${qty}\n` +
    `💰 <b>Total Cost:</b> <u>$${totalPrice}</u>`;

  const keyboard = getQuantityKeyboard(prodId, qty, stockCount);
  await editMessageCaption(chatId, messageId, caption, keyboard);
}

function getQuantityKeyboard(prodId, qty, maxStock) {
  const prevQty = Math.max(1, qty - 1);
  const nextQty = qty >= maxStock ? maxStock : qty + 1;

  return {
    inline_keyboard: [
      [
        { text: "➖", callback_data: `qty_${prodId}_${prevQty}` },
        { text: `🔢 Qty: ${qty}`, callback_data: `ignore` },
        { text: "➕", callback_data: `qty_${prodId}_${nextQty}` }
      ],
      [
        { text: `💳 Buy Now ($${(qty * 1).toFixed(2)})`, callback_data: `checkout_${prodId}_${qty}` }
      ]
    ]
  };
}

// ---------------- ADMIN PANEL ENGINE ----------------

async function sendAdminPanel(chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "➕ Add New Product (Image Support)", callback_data: "admin_add_product" }],
      [{ text: "📦 Bulk Add Stock Keys", callback_data: "admin_add_stock" }]
    ]
  };
  await sendMessage(chatId, "<b>⚡ ADMIN PANEL</b>", keyboard);
}

async function handleStateInputs(chatId, text, state) {
  if (state.action === "ADD_PROD_TITLE") {
    await setFirebaseDoc("states", chatId, { action: "ADD_PROD_PRICE", title: text.trim() });
    await sendMessage(chatId, "💵 Enter Price ($):");

  } else if (state.action === "ADD_PROD_PRICE") {
    await setFirebaseDoc("states", chatId, { action: "ADD_PROD_IMAGE", title: state.title, price: parseFloat(text) });
    await sendMessage(chatId, "🖼️ Send <b>Image JPG/PNG Link</b> (or send <code>none</code> to skip):");

  } else if (state.action === "ADD_PROD_IMAGE") {
    const prodId = "prod_" + Date.now();
    const imgUrl = text.trim().toLowerCase() === "none" ? "" : text.trim();

    await setFirebaseDoc("products", prodId, { title: state.title, price: state.price, imageUrl: imgUrl, stockQueue: "" });
    await sendMessage(chatId, `✅ Product Created!\n<b>ID:</b> <code>${prodId}</code>\nNow add bulk stock keys for this ID.`);

  } else if (state.action === "BULK_STOCK_PROD_ID") {
    await setFirebaseDoc("states", chatId, { action: "ADD_BULK_STOCK_DATA", targetProd: text.trim() });
    await sendMessage(chatId, "📝 Send accounts/keys separated by NEWLINES:");

  } else if (state.action === "ADD_BULK_STOCK_DATA") {
    const product = await getFirebaseDoc("products", state.targetProd);
    if (!product) return sendMessage(chatId, "❌ Product not found!");

    const existingQueue = product.stockQueue ? product.stockQueue + "\n" : "";
    product.stockQueue = existingQueue + text.trim();

    await setFirebaseDoc("products", state.targetProd, product);
    const addedCount = text.trim().split("\n").filter(Boolean).length;
    await sendMessage(chatId, `✅ Added <b>${addedCount}</b> items to stock!`);

  } else if (state.action === "BUY_STARS") {
    const starsCount = parseInt(text);
    if (!isNaN(starsCount)) await sendStarInvoice(chatId, starsCount);
  }
}

// ---------------- CORE HELPERS & UTILS ----------------

async function sendMainMenu(chatId) {
  const replyKeyboard = {
    keyboard: [
      [{ text: "🛍️ Products" }, { text: "📜 Order History" }],
      [{ text: "👛 Wallet" }, { text: "⭐️ Add Stars Balance" }],
      [{ text: "💬 Support" }]
    ],
    resize_keyboard: true
  };
  await sendMessage(chatId, "Welcome to Store! Select option below:", replyKeyboard);
}

async function sendOrderHistory(chatId) {
  const orders = await getFirebaseCollection("orders");
  const userOrders = orders.filter(o => o.userId === chatId);

  if (!userOrders.length) return sendMessage(chatId, "📜 No purchase history found.");

  let msg = "<b>📜 YOUR ORDER HISTORY:</b>\n\n";
  userOrders.slice(-5).forEach((o, i) => {
    msg += `${i + 1}. <b>${o.productTitle}</b> ($${o.price})\nKey: <code>${o.productKey}</code>\n\n`;
  });

  await sendMessage(chatId, msg);
}

async function sendStarInvoice(chatId, stars) {
  const res = await fetch(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/createInvoiceLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Top-up Wallet",
      description: `Add balance via ${stars} Stars`,
      payload: `stars_${chatId}`,
      currency: "XTR",
      prices: [{ label: "Top-up", amount: stars }]
    })
  });
  const data = await res.json();
  if (data.ok) {
    await sendMessage(chatId, `Click below to pay:`, { inline_keyboard: [[{ text: `⭐️ Pay ${stars} Stars`, url: data.result }]] });
  }
}

async function answerPreCheckoutQuery(queryId, ok) {
  await fetch(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/answerPreCheckoutQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pre_checkout_query_id: queryId, ok: ok })
  });
}

// ---------------- FIREBASE REST HELPERS ----------------

async function getFirebaseDoc(collection, docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return parseFirestoreFields(data.fields);
}

async function setFirebaseDoc(collection, docId, data) {
  const formattedFields = {};
  for (const key in data) {
    if (typeof data[key] === "number") formattedFields[key] = { doubleValue: data[key] };
    else if (typeof data[key] === "boolean") formattedFields[key] = { booleanValue: data[key] };
    else formattedFields[key] = { stringValue: String(data[key]) };
  }

  const url = `https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`;
  await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: formattedFields })
  });
}

async function deleteFirebaseDoc(collection, docId) {
  await fetch(`https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`, { method: "DELETE" });
}

async function getFirebaseCollection(collection) {
  const url = `https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  if (!data.documents) return [];
  return data.documents.map(doc => {
    const fields = parseFirestoreFields(doc.fields);
    fields.id = doc.name.split("/").pop();
    return fields;
  });
}

function parseFirestoreFields(fields) {
  if (!fields) return {};
  const obj = {};
  for (const key in fields) {
    const val = fields[key];
    if (val.stringValue !== undefined) obj[key] = val.stringValue;
    else if (val.doubleValue !== undefined || val.integerValue !== undefined) obj[key] = Number(val.doubleValue || val.integerValue);
    else if (val.booleanValue !== undefined) obj[key] = val.booleanValue;
  }
  return obj;
}

function generateApiKey() {
  return 'tgb_' + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text: text, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function sendPhoto(chatId, photoUrl, caption, replyMarkup = null) {
  const body = { chat_id: chatId, photo: photoUrl, caption: caption, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function editMessageCaption(chatId, messageId, caption, replyMarkup = null) {
  const body = { chat_id: chatId, message_id: messageId, caption: caption, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/editMessageCaption`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}