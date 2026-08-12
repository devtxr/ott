// ---------------- CONFIGURATION ----------------
const CONFIG = {
  BOT_TOKEN: "8885018648:AAGDidc1I2MyG-arBYqN0HyVI8xKa9HmEmo",
  ADMIN_ID: "6014400840",
  FIREBASE_PROJECT_ID: "devt-xr",
  WEBHOOK_SECRET: "hw882hwvs"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const botToken = env.BOT_TOKEN || CONFIG.BOT_TOKEN;
    const adminId = env.ADMIN_ID || CONFIG.ADMIN_ID;
    const firebaseProj = env.FIREBASE_PROJECT_ID || CONFIG.FIREBASE_PROJECT_ID;
    const webhookSecret = env.WEBHOOK_SECRET || CONFIG.WEBHOOK_SECRET;

    const currentConfig = {
      BOT_TOKEN: botToken,
      ADMIN_ID: adminId,
      FIREBASE_PROJECT_ID: firebaseProj,
      WEBHOOK_SECRET: webhookSecret
    };

    if (request.method === "POST" && url.pathname === "/webhook") {
      const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (currentConfig.WEBHOOK_SECRET && secretToken !== currentConfig.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 403 });
      }

      try {
        const update = await request.json();
        await handleTelegramUpdate(update, currentConfig);
      } catch (e) {
        console.error("CRITICAL ERROR IN BOT LOGIC:", e.stack || e.message || e);
      }
      return new Response("OK");
    }

    if (url.pathname.startsWith("/api/v2/")) {
      return await handleApiRequests(request, url, currentConfig);
    }

    return new Response("Bot Provider Server Running!");
  }
};

// ---------------- TELEGRAM BOT CORE ENGINE ----------------

async function handleTelegramUpdate(update, config) {
  const ADMIN_ID = config.ADMIN_ID;

  if (update.inline_query) {
    await handleInlineQuery(update.inline_query, config);
    return;
  }

  if (update.pre_checkout_query) {
    await answerPreCheckoutQuery(update.pre_checkout_query.id, true, config);
    return;
  }

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id.toString();
    const text = msg.text ? msg.text.trim() : "";

    if (msg.successful_payment) {
      const starsPaid = msg.successful_payment.total_amount;
      const usdValue = (starsPaid * 0.02).toFixed(2);

      let user = await getFirebaseDoc("users", chatId, config) || {};
      user.balance = (Number(user.balance) || 0) + Number(usdValue);
      await setFirebaseDoc("users", chatId, user, config);

      await sendMessage(chatId, `🎉 <b>Payment Successful!</b>\nAdded <b>$${usdValue}</b> to your wallet balance.`, null, config);
      return;
    }

    let user = await getFirebaseDoc("users", chatId, config);
    if (!user) {
      user = { 
        chatId: chatId, 
        balance: 0, 
        totalPurchased: 0, 
        apiKey: generateApiKey(), 
        joinedAt: new Date().toISOString() 
      };
      await setFirebaseDoc("users", chatId, user, config);
    }

    // CHECK STATE FIRST (for multi-step forms like Add Product)
    const state = await getFirebaseDoc("states", chatId, config);

    if (state && state.action && text !== "/cancel") {
      await handleStateInputs(chatId, text, state, config);
      return;
    }

    if (text === "/cancel") {
      await deleteFirebaseDoc("states", chatId, config);
      await sendMessage(chatId, "❌ Action cancelled.", null, config);
      await sendMainMenu(chatId, config);
      return;
    }

    // COMMANDS & MAIN BUTTONS
    if (text === "/start") {
      await sendMainMenu(chatId, config);
    } else if (text === "/admin" && chatId === ADMIN_ID) {
      await sendAdminPanel(chatId, config);
    } else if (text === "/apikey" || text === "🔗 API") {
      await sendApiDetails(chatId, user, config);
    } else if (text === "🛍️ Products" || text === "🛒 Buy" || text === "/products") {
      await sendCategoryProducts(chatId, config);
    } else if (text === "📜 Order History" || text === "/orders") {
      await sendOrderHistory(chatId, config);
    } else if (text === "👛 Wallet" || text === "/wallet") {
      await sendMessage(chatId, `<b>👤 PROFILE & WALLET</b>\n\n🆔 <b>ID:</b> <code>${chatId}</code>\n💰 <b>Balance:</b> <b>$${user.balance || 0}</b>\n🛒 <b>Total Spent:</b> <b>$${user.totalPurchased || 0}</b>`, null, config);
    } else if (text === "⭐️ Add Stars Balance") {
      await setFirebaseDoc("states", chatId, { action: "BUY_STARS" }, config);
      await sendMessage(chatId, "⭐ Enter amount of <b>Telegram Stars</b> to top up:\n\n<i>Send /cancel to abort</i>", null, config);
    } else if (text === "💬 Support") {
      await sendMessage(chatId, "💬 <b>Support Bot:</b> https://t.me/Somnathtxr_sbot\n📢 <b>Official Channel:</b> @Code_Scan", null, config);
    }

  } else if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id.toString();
    const messageId = cb.message.message_id;
    const data = cb.data;

    if (chatId === ADMIN_ID) {
      if (data === "admin_add_product") {
        await setFirebaseDoc("states", chatId, { action: "ADD_PROD_TITLE" }, config);
        await sendMessage(chatId, "📦 <b>[Step 1/3]</b> Enter Product Title:\n\n<i>Send /cancel to abort</i>", null, config);
      } else if (data === "admin_add_stock") {
        await setFirebaseDoc("states", chatId, { action: "BULK_STOCK_PROD_ID" }, config);
        await sendMessage(chatId, "🔑 Enter Product ID to add stock:\n\n<i>Send /cancel to abort</i>", null, config);
      } else if (data === "admin_add_balance") {
        await setFirebaseDoc("states", chatId, { action: "ADD_BAL_USER" }, config);
        await sendMessage(chatId, "👤 Enter User Chat ID to add balance:\n\n<i>Send /cancel to abort</i>", null, config);
      } else if (data === "admin_gen_apikey") {
        const userDoc = await getFirebaseDoc("users", chatId, config);
        userDoc.apiKey = generateApiKey();
        await setFirebaseDoc("users", chatId, userDoc, config);
        await sendMessage(chatId, `🔑 <b>New Admin API Key Generated:</b>\n<code>${userDoc.apiKey}</code>`, null, config);
      }
    }

    if (data.startsWith("prod_view_")) {
      const prodId = data.replace("prod_view_", "");
      await sendProductCard(chatId, prodId, 1, config);

    } else if (data.startsWith("qty_")) {
      const parts = data.split("_");
      const prodId = parts[1];
      let qty = parseInt(parts[2]);
      qty = isNaN(qty) || qty < 1 ? 1 : qty;
      await updateProductCard(chatId, messageId, prodId, qty, config);

    } else if (data.startsWith("checkout_")) {
      const parts = data.split("_");
      const prodId = parts[1];
      const qty = parseInt(parts[2]);
      await processDirectPurchase(chatId, prodId, qty, config);
    }
  }
}

// ---------------- FIXED STATE & INPUT SYSTEM ----------------

async function handleStateInputs(chatId, text, state, config) {
  if (state.action === "ADD_PROD_TITLE") {
    if (!text) {
      await sendMessage(chatId, "⚠️ Title cannot be empty. Please enter Product Title:", null, config);
      return;
    }
    await setFirebaseDoc("states", chatId, { action: "ADD_PROD_PRICE", prodTitle: text }, config);
    await sendMessage(chatId, `📦 Title set to: <b>${text}</b>\n\n💵 <b>[Step 2/3]</b> Enter Price in USD ($) (e.g. <code>2.5</code>):`, null, config);

  } else if (state.action === "ADD_PROD_PRICE") {
    const price = parseFloat(text);
    if (isNaN(price) || price <= 0) {
      await sendMessage(chatId, "⚠️ Invalid price! Please enter a valid positive number (e.g. <code>1.5</code> or <code>10</code>):", null, config);
      return;
    }

    await setFirebaseDoc("states", chatId, { action: "ADD_PROD_IMAGE", prodTitle: state.prodTitle, prodPrice: price }, config);
    await sendMessage(chatId, `💵 Price set to: <b>$${price}</b>\n\n🖼️ <b>[Step 3/3]</b> Send <b>Image HTTP Direct Link</b> (or send <code>none</code> to skip):`, null, config);

  } else if (state.action === "ADD_PROD_IMAGE") {
    const prodId = "prod_" + Date.now();
    const imgUrl = text.toLowerCase() === "none" ? "" : text;

    const newProduct = {
      title: state.prodTitle || "Untitled Product",
      price: Number(state.prodPrice) || 0,
      imageUrl: imgUrl,
      stockQueue: ""
    };

    await setFirebaseDoc("products", prodId, newProduct, config);
    await deleteFirebaseDoc("states", chatId, config);

    await sendMessage(
      chatId, 
      `✅ <b>Product Successfully Created!</b>\n\n` +
      `📌 <b>Title:</b> ${newProduct.title}\n` +
      `💵 <b>Price:</b> $${newProduct.price}\n` +
      `🆔 <b>Product ID:</b> <code>${prodId}</code>\n\n` +
      `👉 Now add stock using <b>/admin</b> > <b>Bulk Add Stock</b> button.`, 
      null, 
      config
    );

  } else if (state.action === "BULK_STOCK_PROD_ID") {
    const targetProdId = text;
    const product = await getFirebaseDoc("products", targetProdId, config);

    if (!product) {
      await sendMessage(chatId, `❌ Product with ID <code>${targetProdId}</code> not found! Please check ID and try again:`, null, config);
      return;
    }

    await setFirebaseDoc("states", chatId, { action: "ADD_BULK_STOCK_DATA", targetProd: targetProdId }, config);
    await sendMessage(chatId, `📦 Selected Product: <b>${product.title}</b>\n\n📝 Send accounts/stock keys separated by NEWLINES:`, null, config);

  } else if (state.action === "ADD_BULK_STOCK_DATA") {
    const product = await getFirebaseDoc("products", state.targetProd, config);
    if (!product) {
      await deleteFirebaseDoc("states", chatId, config);
      return sendMessage(chatId, "❌ Product not found!", null, config);
    }

    const newItems = text.split("\n").map(s => s.trim()).filter(Boolean);
    if (newItems.length === 0) {
      await sendMessage(chatId, "⚠️ No valid stock line detected. Please send stock lines:", null, config);
      return;
    }

    const existingQueue = product.stockQueue ? product.stockQueue + "\n" : "";
    product.stockQueue = existingQueue + newItems.join("\n");

    await setFirebaseDoc("products", state.targetProd, product, config);
    await deleteFirebaseDoc("states", chatId, config);

    await sendMessage(chatId, `✅ Added <b>${newItems.length}</b> stock items to <b>${product.title}</b>!`, null, config);

  } else if (state.action === "ADD_BAL_USER") {
    await setFirebaseDoc("states", chatId, { action: "ADD_BAL_AMOUNT", targetUser: text }, config);
    await sendMessage(chatId, `👤 Target User: <code>${text}</code>\n\n💰 Enter Balance Amount to add ($):`, null, config);

  } else if (state.action === "ADD_BAL_AMOUNT") {
    const amount = parseFloat(text);
    if (isNaN(amount)) {
      await sendMessage(chatId, "⚠️ Enter a valid numeric amount:", null, config);
      return;
    }

    const targetUser = state.targetUser;
    let user = await getFirebaseDoc("users", targetUser, config) || {};

    user.balance = (Number(user.balance) || 0) + amount;
    await setFirebaseDoc("users", targetUser, user, config);
    await deleteFirebaseDoc("states", chatId, config);

    await sendMessage(chatId, `✅ Added <b>$${amount}</b> to User ID: <code>${targetUser}</code>`, null, config);

  } else if (state.action === "BUY_STARS") {
    const starsCount = parseInt(text);
    if (!isNaN(starsCount) && starsCount > 0) {
      await deleteFirebaseDoc("states", chatId, config);
      await sendStarInvoice(chatId, starsCount, config);
    } else {
      await sendMessage(chatId, "⚠️ Enter a valid number of stars:", null, config);
    }
  }
}

// ---------------- API INFO DISPLAY ----------------

async function sendApiDetails(chatId, user, config) {
  const workerDomain = "https://apiott.codescan.workers.dev";

  const apiInfo = `<b>🗣️ YOUR API CREDENTIALS & DOCUMENTATION</b>\n\n` +
    `🔑 <b>Your Personal API Key:</b>\n<code>${user.apiKey}</code>\n\n` +
    `───────────────────\n` +
    `📌 <b>1. Get Product List & Stock</b>\n` +
    `<b>Method:</b> <code>GET</code>\n` +
    `<b>URL:</b> <code>${workerDomain}/api/v2/products</code>\n` +
    `<b>Header:</b> <code>X-API-KEY: ${user.apiKey}</code>\n\n` +
    `───────────────────\n` +
    `📌 <b>2. Get Product Data by Product Key</b>\n` +
    `<b>Method:</b> <code>GET</code>\n` +
    `<b>URL:</b>\n<code>${workerDomain}/api/v2/product_data?product_key=YOUR_KEY&api_key=${user.apiKey}</code>`;

  await sendMessage(chatId, apiInfo, null, config);
}

// ---------------- PURCHASE & PRODUCT KEY GENERATION ----------------

async function processDirectPurchase(chatId, productId, quantity, config) {
  const user = await getFirebaseDoc("users", chatId, config);
  const product = await getFirebaseDoc("products", productId, config);

  let stockList = product && product.stockQueue ? product.stockQueue.split("\n").map(s => s.trim()).filter(Boolean) : [];

  if (!product || stockList.length < quantity) {
    return sendMessage(chatId, `❌ Not enough stock! Available: ${stockList.length} Pcs.`, null, config);
  }

  const totalCost = product.price * quantity;
  if (Number(user.balance) < totalCost) {
    return sendMessage(chatId, `❌ Insufficient balance! Required: $${totalCost.toFixed(2)}, Current: $${user.balance || 0}`, null, config);
  }

  const deliveredItems = stockList.splice(0, quantity);
  product.stockQueue = stockList.join("\n");

  user.balance = Number(user.balance) - totalCost;
  user.totalPurchased = (Number(user.totalPurchased) || 0) + totalCost;

  await setFirebaseDoc("users", chatId, user, config);
  await setFirebaseDoc("products", productId, product, config);

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

  await setFirebaseDoc("orders", orderId, orderData, config);
  await setFirebaseDoc("product_keys", productKey, orderData, config);

  const deliveryMsg = `✅ <b>Purchase Successful!</b>\n\n` +
    `📦 <b>Item:</b> ${product.title}\n` +
    `🔢 <b>Quantity:</b> ${quantity} Pcs\n` +
    `💰 <b>Total Paid:</b> $${totalCost.toFixed(2)}\n\n` +
    `🔑 <b>Generated Product Key:</b>\n<code>${productKey}</code>\n\n` +
    `📄 <b>Product Data / Content:</b>\n<code>${deliveredItems.join("\n")}</code>`;

  await sendMessage(chatId, deliveryMsg, null, config);
}

// ---------------- EXTERNAL API SYSTEM ----------------

async function handleApiRequests(request, url, config) {
  if (url.pathname === "/api/v2/products" && request.method === "GET") {
    const products = await getFirebaseCollection("products", config);
    const formatted = products.map(p => {
      const stock = p.stockQueue ? p.stockQueue.split("\n").map(s => s.trim()).filter(Boolean).length : 0;
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
      const users = await getFirebaseCollection("users", config);
      const user = users.find(u => u.apiKey === apiKey);
      if (!user) {
        return new Response(JSON.stringify({ success: false, message: "Invalid API Key" }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
    }

    const keyData = await getFirebaseDoc("product_keys", productKey, config);

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

async function handleInlineQuery(inlineQuery, config) {
  const query = inlineQuery.query.toLowerCase().trim();
  const products = await getFirebaseCollection("products", config);
  const filtered = products.filter(p => p.title.toLowerCase().includes(query));

  const results = filtered.map(p => {
    const stockCount = p.stockQueue ? p.stockQueue.split("\n").map(s => s.trim()).filter(Boolean).length : 0;
    return {
      type: "article",
      id: p.id,
      title: `${p.title} - $${p.price}`,
      description: `Stock: ${stockCount} available`,
      input_message_content: {
        message_text: `<b>📦 ${p.title}</b>\n💵 Price: $${p.price}\n📊 Stock: ${stockCount}`,
        parse_mode: "HTML"
      },
      reply_markup: {
        inline_keyboard: [[{ text: "🛍️ Select Quantity & Buy", callback_data: `prod_view_${p.id}` }]]
      }
    };
  });

  await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/answerInlineQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inline_query_id: inlineQuery.id, results: results.slice(0, 25), cache_time: 1 })
  });
}

// ---------------- UI & QUANTITY SELECTOR ----------------

async function sendCategoryProducts(chatId, config) {
  const products = await getFirebaseCollection("products", config);
  if (!products.length) return sendMessage(chatId, "No products available.", null, config);

  const buttons = products.map(p => {
    const stockCount = p.stockQueue ? p.stockQueue.split("\n").map(s => s.trim()).filter(Boolean).length : 0;
    return [{ text: `${p.title} | $${p.price} | 📦 ${stockCount}`, callback_data: `prod_view_${p.id}` }];
  });

  buttons.unshift([{ text: "🔍 Search Products via Inline Mode", switch_inline_query_current_chat: "" }]);
  await sendMessage(chatId, "<b>🛍️ Products Catalog:</b>", { inline_keyboard: buttons }, config);
}

async function sendProductCard(chatId, prodId, qty, config) {
  const p = await getFirebaseDoc("products", prodId, config);
  if (!p) return sendMessage(chatId, "❌ Product not found!", null, config);

  const stockCount = p.stockQueue ? p.stockQueue.split("\n").map(s => s.trim()).filter(Boolean).length : 0;
  const totalPrice = (p.price * qty).toFixed(2);

  const caption = `<b>📦 ${p.title}</b>\n\n` +
    `💵 <b>Unit Price:</b> $${p.price}\n` +
    `📊 <b>Stock Left:</b> ${stockCount} Pcs\n` +
    `🛒 <b>Selected Quantity:</b> ${qty}\n` +
    `💰 <b>Total Cost:</b> <u>$${totalPrice}</u>`;

  const keyboard = getQuantityKeyboard(prodId, qty, stockCount, p.price);

  if (p.imageUrl && p.imageUrl.startsWith("http")) {
    await sendPhoto(chatId, p.imageUrl, caption, keyboard, config);
  } else {
    await sendMessage(chatId, caption, keyboard, config);
  }
}

async function updateProductCard(chatId, messageId, prodId, qty, config) {
  const p = await getFirebaseDoc("products", prodId, config);
  if (!p) return;

  const stockCount = p.stockQueue ? p.stockQueue.split("\n").map(s => s.trim()).filter(Boolean).length : 0;
  const totalPrice = (p.price * qty).toFixed(2);

  const caption = `<b>📦 ${p.title}</b>\n\n` +
    `💵 <b>Unit Price:</b> $${p.price}\n` +
    `📊 <b>Stock Left:</b> ${stockCount} Pcs\n` +
    `🛒 <b>Selected Quantity:</b> ${qty}\n` +
    `💰 <b>Total Cost:</b> <u>$${totalPrice}</u>`;

  const keyboard = getQuantityKeyboard(prodId, qty, stockCount, p.price);
  await editMessageCaption(chatId, messageId, caption, keyboard, config);
}

function getQuantityKeyboard(prodId, qty, maxStock, unitPrice) {
  const prevQty = Math.max(1, qty - 1);
  const nextQty = qty >= maxStock ? maxStock : qty + 1;
  const total = (qty * unitPrice).toFixed(2);

  return {
    inline_keyboard: [
      [
        { text: "➖", callback_data: `qty_${prodId}_${prevQty}` },
        { text: `🔢 Qty: ${qty}`, callback_data: `ignore` },
        { text: "➕", callback_data: `qty_${prodId}_${nextQty}` }
      ],
      [
        { text: `💳 Buy Now ($${total})`, callback_data: `checkout_${prodId}_${qty}` }
      ]
    ]
  };
}

// ---------------- ADMIN PANEL ENGINE ----------------

async function sendAdminPanel(chatId, config) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "➕ Add New Product", callback_data: "admin_add_product" }],
      [{ text: "📦 Bulk Add Stock", callback_data: "admin_add_stock" }],
      [{ text: "💰 Add User Balance", callback_data: "admin_add_balance" }],
      [{ text: "🔑 Regenerate Admin API Key", callback_data: "admin_gen_apikey" }]
    ]
  };
  await sendMessage(chatId, "<b>⚡ ADMIN CONTROL PANEL</b>", keyboard, config);
}

// ---------------- CORE HELPERS & UTILS ----------------

async function sendMainMenu(chatId, config) {
  const replyKeyboard = {
    keyboard: [
      [{ text: "🛍️ Products" }, { text: "📜 Order History" }],
      [{ text: "👛 Wallet" }, { text: "⭐️ Add Stars Balance" }],
      [{ text: "🔗 API" }, { text: "💬 Support" }]
    ],
    resize_keyboard: true
  };
  await sendMessage(chatId, "Welcome to Store! Select option below:", replyKeyboard, config);
}

async function sendOrderHistory(chatId, config) {
  const orders = await getFirebaseCollection("orders", config);
  const userOrders = orders.filter(o => o.userId === chatId);

  if (!userOrders.length) return sendMessage(chatId, "📜 No purchase history found.", null, config);

  let msg = "<b>📜 YOUR ORDER HISTORY:</b>\n\n";
  userOrders.slice(-5).forEach((o, i) => {
    msg += `${i + 1}. <b>${o.productTitle}</b> ($${o.price})\nKey: <code>${o.productKey}</code>\n\n`;
  });

  await sendMessage(chatId, msg, null, config);
}

async function sendStarInvoice(chatId, stars, config) {
  const res = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/createInvoiceLink`, {
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
    await sendMessage(chatId, `Click below to pay:`, { inline_keyboard: [[{ text: `⭐️ Pay ${stars} Stars`, url: data.result }]] }, config);
  }
}

async function answerPreCheckoutQuery(queryId, ok, config) {
  await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/answerPreCheckoutQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pre_checkout_query_id: queryId, ok: ok })
  });
}

// ---------------- FIREBASE REST HELPERS ----------------

async function getFirebaseDoc(collection, docId, config) {
  const url = `https://firestore.googleapis.com/v1/projects/${config.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return parseFirestoreFields(data.fields);
}

async function setFirebaseDoc(collection, docId, data, config) {
  const formattedFields = {};
  for (const key in data) {
    if (typeof data[key] === "number") formattedFields[key] = { doubleValue: data[key] };
    else if (typeof data[key] === "boolean") formattedFields[key] = { booleanValue: data[key] };
    else formattedFields[key] = { stringValue: String(data[key] || "") };
  }

  const url = `https://firestore.googleapis.com/v1/projects/${config.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`;
  await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: formattedFields })
  });
}

async function deleteFirebaseDoc(collection, docId, config) {
  await fetch(`https://firestore.googleapis.com/v1/projects/${config.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`, { method: "DELETE" });
}

async function getFirebaseCollection(collection, config) {
  const url = `https://firestore.googleapis.com/v1/projects/${config.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}`;
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

async function sendMessage(chatId, text, replyMarkup = null, config) {
  const body = { chat_id: chatId, text: text, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function sendPhoto(chatId, photoUrl, caption, replyMarkup = null, config) {
  const body = { chat_id: chatId, photo: photoUrl, caption: caption, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function editMessageCaption(chatId, messageId, caption, replyMarkup = null, config) {
  const body = { chat_id: chatId, message_id: messageId, caption: caption, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/editMessageCaption`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}