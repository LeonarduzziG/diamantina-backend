const express = require("express");
const mercadopago = require("mercadopago");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// ── MERCADOPAGO ──────────────────────────────────────────────────────────────
mercadopago.configure({ access_token: process.env.ACCESS_TOKEN });

// ── FIREBASE ADMIN ───────────────────────────────────────────────────────────
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://diamantina-galeria-default-rtdb.firebaseio.com"
  });
  db = admin.database();
  console.log("Firebase Admin conectado ✓");
} catch (e) {
  console.error("Error iniciando Firebase Admin:", e.message);
}

// ── ANDREANI ─────────────────────────────────────────────────────────────────
const ANDREANI_USER = process.env.ANDREANI_USER;
const ANDREANI_PASS = process.env.ANDREANI_PASS;
const ANDREANI_CP_ORIGEN = process.env.ANDREANI_CP_ORIGEN || "1712";
const ANDREANI_CONTRATO = process.env.ANDREANI_CONTRATO || "";
const ANDREANI_SANDBOX = process.env.ANDREANI_SANDBOX !== "false";
const ANDREANI_BASE = ANDREANI_SANDBOX
  ? "https://apis-sandbox.andreani.com"
  : "https://apis.andreani.com";

let _andreaniToken = null;
let _andreaniTokenTs = 0;

async function getAndreaniToken() {
  const ahora = Date.now();
  if (_andreaniToken && ahora - _andreaniTokenTs < 23 * 60 * 60 * 1000) {
    return _andreaniToken;
  }
  const res = await axios.post(
    `${ANDREANI_BASE}/v1/login`, {},
    { auth: { username: ANDREANI_USER, password: ANDREANI_PASS }, timeout: 8000 }
  );
  _andreaniToken = res.headers["x-authorization-token"] || res.data.token;
  _andreaniTokenTs = ahora;
  return _andreaniToken;
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

// Bajar stock de un producto
async function bajarStock(prodId, talla, color, qty) {
  if (!db || !prodId || !talla) return;
  try {
    const colorKey = color && typeof color === "object" ? (color.nombre || color.hex || "") : (color || "");
    const stockKey = colorKey ? `${talla}__${colorKey}` : talla;
    const ref = db.ref(`productos/${prodId}/stock/${stockKey}`);
    const snap = await ref.get();
    const actual = snap.val() || 0;
    const nuevo = Math.max(0, actual - qty);
    await ref.set(nuevo);
    console.log(`Stock ${prodId} [${stockKey}]: ${actual} → ${nuevo}`);

    // Check if ALL stock is 0 → set estado=agotado
    if (nuevo === 0) {
      const stockSnap = await db.ref(`productos/${prodId}/stock`).get();
      const stockData = stockSnap.val() || {};
      const totalStock = Object.values(stockData).reduce((s, v) => s + (Number(v) || 0), 0);
      if (totalStock === 0) {
        await db.ref(`productos/${prodId}/estado`).set("agotado");
        console.log(`Producto ${prodId} marcado como agotado`);
      }
    }
  } catch (e) {
    console.error("Error bajando stock:", e.message);
  }
}

// Guardar pedido en Firebase
async function guardarPedido(pedidoData) {
  if (!db) return null;
  try {
    const ref = await db.ref("pedidos").push(pedidoData);
    console.log("Pedido guardado:", ref.key);
    return ref.key;
  } catch (e) {
    console.error("Error guardando pedido:", e.message);
    return null;
  }
}

// Actualizar pedido existente
async function actualizarPedido(key, data) {
  if (!db || !key) return;
  try {
    await db.ref(`pedidos/${key}`).update(data);
    console.log("Pedido actualizado:", key);
  } catch (e) {
    console.error("Error actualizando pedido:", e.message);
  }
}

// ── WEBHOOK MERCADOPAGO ──────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log("Webhook recibido:", type, data?.id);

    if (type !== "payment") {
      return res.sendStatus(200);
    }

    const paymentId = data?.id;
    if (!paymentId) return res.sendStatus(200);

    // Obtener info del pago de MP
    const payment = await mercadopago.payment.get(paymentId);
    const pago = payment.body;
    const status = pago.status;

    console.log(`Pago ${paymentId}: ${status}`);

    if (status !== "approved") {
      return res.sendStatus(200);
    }

    // Buscar pedido pendiente en Firebase por external_reference o payment_id
    const extRef = pago.external_reference;
    let pedidoPendiente = null;
    let pedidoKey = null;

    if (extRef && db) {
      const snap = await db.ref("pedidos")
        .orderByChild("external_reference")
        .equalTo(extRef)
        .limitToFirst(1)
        .get();
      if (snap.exists()) {
        const entries = Object.entries(snap.val());
        pedidoKey = entries[0][0];
        pedidoPendiente = entries[0][1];
      }
    }

    if (pedidoPendiente && pedidoKey) {
      // Actualizar pedido existente
      await actualizarPedido(pedidoKey, {
        estado: "aprobado",
        payment_id: String(paymentId)
      });

      // Bajar stock
      const items = pedidoPendiente.items || [];
      for (const item of items) {
        if (item.prodId && item.talla) {
          await bajarStock(item.prodId, item.talla, item.color || "", item.qty || 1);
        }
      }
    } else {
      // Crear pedido nuevo desde datos del webhook
      const items = pago.additional_info?.items || [];
      const pedidoNuevo = {
        payment_id: String(paymentId),
        external_reference: extRef || null,
        estado: "aprobado",
        total: pago.transaction_amount || 0,
        nombre: pago.payer?.first_name || "Cliente",
        email: pago.payer?.email || "",
        items: items.map(i => ({
          name: i.title,
          qty: Number(i.quantity) || 1,
          price: Number(i.unit_price) || 0
        })),
        ts: Date.now(),
        fuente: "webhook"
      };
      await guardarPedido(pedidoNuevo);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Error en webhook:", e.message);
    res.sendStatus(500);
  }
});

// ── CREAR PREFERENCIA ────────────────────────────────────────────────────────
app.post("/crear-preferencia", async (req, res) => {
  try {
    const { items, pedido } = req.body;

    // Guardar pedido como pendiente antes de ir a MP
    let pedidoKey = null;
    if (pedido && db) {
      const pedidoPendiente = {
        ...pedido,
        estado: "pendiente",
        ts: Date.now()
      };
      try {
        const ref = await db.ref("pedidos").push(pedidoPendiente);
        pedidoKey = ref.key;
        console.log("Pedido pendiente guardado:", pedidoKey);
      } catch (e) {
        console.error("Error guardando pedido pendiente:", e.message);
      }
    }

    const preference = {
      items: items.map(i => ({
        title: i.title,
        quantity: Number(i.quantity),
        unit_price: Number(i.unit_price),
        currency_id: "ARS",
      })),
      back_urls: {
        success: (process.env.FRONTEND_URL || "https://www.diamantina.shop") + "/?page=success",
        failure: (process.env.FRONTEND_URL || "https://www.diamantina.shop") + "/?page=error",
        pending: (process.env.FRONTEND_URL || "https://www.diamantina.shop") + "/?page=success",
      },
      auto_return: "approved",
      statement_descriptor: "DIAMANTINA",
      binary_mode: true,
      payment_methods: { installments: 12 },
      external_reference: pedidoKey || String(Date.now()),
      notification_url: "https://diamantina-backend.onrender.com/webhook"
    };

    const response = await mercadopago.preferences.create(preference);
    res.json({
      id: response.body.id,
      init_point: response.body.init_point,
      pedidoKey
    });
  } catch (err) {
    console.error("Error creando preferencia:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── BORRAR PEDIDO ───────────────────────────────────────────────────────────
app.post("/borrar-pedido", async (req, res) => {
  try {
    const { key } = req.body;
    if (!key || !db) return res.status(400).json({ error: "key requerida" });
    await db.ref("pedidos/" + key).remove();
    console.log("Pedido borrado:", key);
    res.json({ ok: true });
  } catch (e) {
    console.error("Error borrando pedido:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GUARDAR PEDIDO (desde frontend cuando no hay webhook) ───────────────────
app.post("/guardar-pedido", async (req, res) => {
  try {
    const { pedido } = req.body;
    if (!pedido || !db) return res.status(400).json({ error: "Pedido requerido" });
    const ref = await db.ref("pedidos").push({
      ...pedido,
      estado: pedido.estado || "aprobado",
      ts: pedido.ts || Date.now()
    });
    console.log("Pedido guardado via /guardar-pedido:", ref.key);
    res.json({ ok: true, key: ref.key });
  } catch (e) {
    console.error("Error guardando pedido:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BAJAR STOCK MANUAL (fallback desde frontend) ─────────────────────────────
app.post("/bajar-stock", async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !db) return res.json({ ok: true });
    for (const item of items) {
      if (item.prodId && item.talla) {
        await bajarStock(item.prodId, item.talla, item.color || "", item.qty || 1);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Error bajando stock:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ANDREANI COTIZAR ─────────────────────────────────────────────────────────
app.post("/andreani-cotizar", async (req, res) => {
  try {
    if (!ANDREANI_USER || !ANDREANI_PASS) {
      return res.status(503).json({ error: "Credenciales Andreani no configuradas" });
    }
    const { cpDestino, peso = 0.3, largo = 20, ancho = 15, alto = 5 } = req.body;
    if (!cpDestino) return res.status(400).json({ error: "cpDestino requerido" });
    const token = await getAndreaniToken();
    const bultos = [{ peso, volumen: largo * ancho * alto }];
    const params = new URLSearchParams({
      cpOrigen: ANDREANI_CP_ORIGEN,
      cpDestino: String(cpDestino).trim(),
      contrato: ANDREANI_CONTRATO,
      bultos: JSON.stringify(bultos),
    });
    const cotizacion = await axios.get(`${ANDREANI_BASE}/v1/tarifas?${params}`, {
      headers: { "x-authorization-token": token },
      timeout: 8000,
    });
    const data = cotizacion.data;
    let precio = null, nombre = "Andreani", plazo = null;
    if (Array.isArray(data) && data.length > 0) {
      const ordenados = data.sort((a, b) => (a.tarifaConIva || 0) - (b.tarifaConIva || 0));
      const opcion = ordenados[0];
      precio = Math.round(opcion.tarifaConIva || opcion.precio || 0);
      nombre = opcion.descripcion || "Andreani Estándar";
      plazo = opcion.plazoDeEntrega || null;
    }
    if (!precio) return res.status(404).json({ error: "No se pudo obtener precio" });
    res.json({ precio, nombre, plazo });
  } catch (err) {
    console.error("Andreani error:", err?.response?.data || err.message);
    res.status(500).json({ error: err?.response?.data || err.message });
  }
});

// ── PRODUCT PREVIEW (para WhatsApp/redes sociales) ──────────────────────────
// Cuando WhatsApp escanea diamantina-backend.onrender.com/p/ID
// devuelve HTML con meta tags del producto y redirige a la tienda
app.get("/p/:id", async (req, res) => {
  const id = req.params.id;
  const TIENDA = process.env.FRONTEND_URL || "https://www.diamantina.shop";

  try {
    if (!db) throw new Error("DB no disponible");
    const snap = await db.ref("productos/" + id).get();
    const p = snap.val();

    if (!p) {
      return res.redirect(302, TIENDA + "/?producto=" + encodeURIComponent(id));
    }

    const nombre = p.name || "Diamantina Lencería";
    const desc = (p.desc || "Lencería de diseño en Argentina")
      .replace(/<[^>]+>/g, "")
      .slice(0, 160);
    const precio = p.precioFinal || p.price || 0;
    const img = (p.imgs && p.imgs[0]) || p.img || 
      "https://res.cloudinary.com/dy1yckjcj/image/upload/v1780442730/6011F3D2-4EA7-4B2B-A4C8-9F217ADD2F2B_lmotkd.png";
    const url = TIENDA + "/?producto=" + encodeURIComponent(id);
    const precioStr = precio ? " — $" + Number(precio).toLocaleString("es-AR") : "";

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${nombre} — Diamantina Lencería</title>
  <meta name="description" content="${desc}${precioStr}">
  
  <!-- Open Graph / WhatsApp / Facebook -->
  <meta property="og:type" content="product">
  <meta property="og:title" content="${nombre} — Diamantina Lencería">
  <meta property="og:description" content="${desc}${precioStr}">
  <meta property="og:image" content="${img}">
  <meta property="og:image:width" content="800">
  <meta property="og:image:height" content="800">
  <meta property="og:url" content="${url}">
  <meta property="og:site_name" content="Diamantina Lencería">
  
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${nombre} — Diamantina Lencería">
  <meta name="twitter:description" content="${desc}${precioStr}">
  <meta name="twitter:image" content="${img}">
  
  <!-- Redirect inmediato a la tienda -->
  <meta http-equiv="refresh" content="0; url=${url}">
  <link rel="canonical" href="${url}">
</head>
<body>
  <p>Redirigiendo a <a href="${url}">${nombre}</a>...</p>
  <script>window.location.replace("${url}");</script>
</body>
</html>`);
  } catch (e) {
    console.error("Error product preview:", e.message);
    res.redirect(302, TIENDA + "/?producto=" + encodeURIComponent(id));
  }
});

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({
    status: "OK",
    service: "Diamantina Backend v2",
    firebase: db ? "conectado" : "NO conectado",
    andreani: ANDREANI_SANDBOX ? "sandbox" : "producción",
    mp: process.env.ACCESS_TOKEN ? "configurado" : "NO configurado"
  })
);

app.listen(process.env.PORT || 3000, () =>
  console.log("Diamantina Backend v2 corriendo")
);
