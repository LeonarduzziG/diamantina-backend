const express = require("express");
const mercadopago = require("mercadopago");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1); // Render está detrás de un proxy; necesario para que el rate limit lea la IP real

// ── CORS ─────────────────────────────────────────────────────────────────────
// Solo la tienda puede llamar al backend desde un navegador. El webhook de
// Mercado Pago no pasa por CORS (es servidor a servidor), así que no lo afecta.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://www.diamantina.shop,https://diamantina.shop")
  .split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));
app.use(express.json({ limit: "100kb" }));

// ── RATE LIMITING ────────────────────────────────────────────────────────────
const limiteCompra = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos. Esperá un momento y volvé a probar." }
});
// Los pedidos por transferencia reservan stock apenas se crean, así que el
// límite es más estricto: si no, alguien podría "comprar" todo sin pagar.
const limiteTransferencia = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Ya registramos varios pedidos desde tu conexión. Si necesitás otro, escribinos por WhatsApp." }
});

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

// ── HELPERS GENERALES ────────────────────────────────────────────────────────
class ErrorCliente extends Error {} // errores que se pueden mostrar al comprador

// Limpia un texto que viene del navegador: lo pasa a string y lo recorta
function txt(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}

// Misma función que usa el panel admin para armar las claves de stock
function safeKey(s) { return String(s).replace(/[.#$/\[\]]/g, "-"); }

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── ADMIN (login de Firebase) ────────────────────────────────────────────────
// El panel manda el token de la sesión de Firebase. Acá verificamos que sea
// válido y que ese usuario esté en /admins/{uid} = true en la base.
async function requireAdmin(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token || !db) return res.status(401).json({ error: "No autorizado" });
    const decoded = await admin.auth().verifyIdToken(token);
    const esAdmin = (await db.ref("admins/" + decoded.uid).get()).val() === true;
    if (!esAdmin) {
      console.warn("Usuario logueado pero no admin intentó una acción de admin:", decoded.uid);
      return res.status(403).json({ error: "No autorizado" });
    }
    req.adminUid = decoded.uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Sesión inválida o vencida" });
  }
}

// ── EMAILJS ──────────────────────────────────────────────────────────────────
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || "aIVvakD_ibBlrMGTF";
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY || "";
const EMAILJS_SERVICE_ID = "service_thw68fg";
const EMAILJS_TEMPLATE_ID = "template_4tth7pc";
const EMAIL_AVISOS = process.env.EMAIL_AVISOS || "gel340@gmail.com";

async function enviarEmailPedido(pedido) {
  if (!EMAILJS_PRIVATE_KEY) {
    console.warn("EMAILJS_PRIVATE_KEY no configurada — no se puede enviar el mail desde el backend.");
    return false;
  }
  try {
    const items = (pedido.items || []).map(i => {
      const t = i.talla && i.talla !== "—" ? ` · Talle ${i.talla}` : "";
      const c = i.color ? ` · ${i.color}` : "";
      const rol = i.giftRol ? `[${i.giftRol}] ` : "";
      return `${rol}${i.title || i.name || "—"}${t}${c} x${i.qty || 1}`;
    }).join(" | ");
    // Caja de regalo: marcar el pedido y sumar la dedicatoria a las observaciones
    const esCajaRegalo = (pedido.items || []).some(i => i.giftRol);
    const dedicatoria = (pedido.items || []).map(i => i.giftNota).find(Boolean) || "";
    const observacionesFull = [
      pedido.observaciones || "",
      esCajaRegalo ? "🎁 CAJA DE REGALO" : "",
      dedicatoria ? `Dedicatoria: "${dedicatoria}"` : ""
    ].filter(Boolean).join(" | ") || "Sin observaciones";
    const templateParams = {
      to_email: EMAIL_AVISOS,
      order_id: pedido.payment_id || String(Date.now()),
      cliente: pedido.nombre || "Cliente",
      telefono: pedido.telefono || "No especificado",
      email_cliente: pedido.email || "No especificado",
      direccion: pedido.direccion || "No especificada",
      cp: pedido.cpDestino || "No especificado",
      tipo_envio: pedido.tipoEnvio || "No especificado",
      observaciones: observacionesFull,
      total: "$" + (Number(pedido.total) || 0).toLocaleString("es-AR"),
      items,
      estado: pedido.estado || "aprobado",
      envio: pedido.envio || "Sin especificar",
      payment_id: pedido.payment_id || "—",
      fecha: new Date(pedido.ts || Date.now()).toLocaleString("es-AR")
    };
    await axios.post("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: templateParams
    }, { headers: { "Content-Type": "application/json" }, timeout: 8000 });
    console.log("Email enviado desde el backend OK para pedido", pedido.payment_id);
    return true;
  } catch (e) {
    console.error("Error enviando email desde el backend:", e?.response?.data || e.message);
    return false;
  }
}

// ── CORREO ARGENTINO ─────────────────────────────────────────────────────────
// Credenciales via env vars; los valores son el fallback de desarrollo —
// en Render siempre usar las variables de entorno para no exponerlos.
const CORREO_USER = process.env.CORREO_USER || "";
const CORREO_PASS = process.env.CORREO_PASS || "";
const CORREO_CUSTOMER_ID = process.env.CORREO_CUSTOMER_ID || ""; // número de cliente MiCorreo (ej: 0000550137)
const CORREO_CP_ORIGEN = process.env.CORREO_CP_ORIGEN || "1712";
// Usar ambiente productivo (el PDF confirma que las credenciales sirven para ambos)
const CORREO_BASE = process.env.CORREO_SANDBOX === "true"
  ? "https://apitest.correoargentino.com.ar/micorreo/v1"
  : "https://api.correoargentino.com.ar/micorreo/v1";

let _correoToken = null;
let _correoTokenTs = 0;
let _correoCustomerId = null; // se obtiene al hacer login

async function getCorreoToken() {
  const ahora = Date.now();
  // El JWT de Correo dura ~24h; refrescamos antes de las 23h para evitar expiración
  if (_correoToken && ahora - _correoTokenTs < 23 * 60 * 60 * 1000) {
    return _correoToken;
  }
  const res = await axios.post(
    `${CORREO_BASE}/token`,
    {},
    {
      auth: { username: CORREO_USER, password: CORREO_PASS },
      timeout: 8000
    }
  );
  _correoToken = res.data.token;
  _correoTokenTs = ahora;
  // La respuesta también devuelve el customerId que necesita /rates
  if (res.data.customerId) _correoCustomerId = res.data.customerId;
  return _correoToken;
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

// ── STOCK ────────────────────────────────────────────────────────────────────
// Usa una transacción para que dos compras simultáneas no se pisen.
async function bajarStock(prodId, talla, color, qty) {
  if (!db || !prodId || !talla || talla === "—") return;
  try {
    const stockKey = color ? `${safeKey(talla)}__${safeKey(color)}` : safeKey(talla);
    const ref = db.ref(`productos/${safeKey(prodId)}/stock/${stockKey}`);
    let antes = 0, despues = 0;
    await ref.transaction(actual => {
      antes = Number(actual) || 0;
      despues = Math.max(0, antes - (Number(qty) || 1));
      return despues;
    });
    console.log(`Stock ${prodId} [${stockKey}]: ${antes} → ${despues}`);

    if (despues === 0) {
      const stockData = (await db.ref(`productos/${safeKey(prodId)}/stock`).get()).val() || {};
      const totalStock = Object.values(stockData).reduce((s, v) => s + (Number(v) || 0), 0);
      if (totalStock === 0) {
        await db.ref(`productos/${safeKey(prodId)}/estado`).set("agotado");
        console.log(`Producto ${prodId} marcado como agotado`);
      }
    }
  } catch (e) {
    console.error("Error bajando stock:", e.message);
  }
}

async function bajarStockItems(items) {
  for (const item of items || []) {
    if (item.prodId && item.talla) {
      await bajarStock(item.prodId, item.talla, item.color || "", item.qty || 1);
    }
  }
}

// ── CLIENTES (antes lo hacía el navegador del comprador) ─────────────────────
async function guardarCliente(pedido) {
  if (!db || !pedido || !pedido.nombre || pedido.nombre === "Cliente") return;
  try {
    const uid = String(pedido.telefono || pedido.email || "").replace(/[^a-zA-Z0-9]/g, "");
    if (!uid) return;
    const ref = db.ref("clientes/" + uid);
    const existing = (await ref.get()).val() || {};
    let historial = Array.isArray(existing.historial) ? existing.historial : [];
    const resumen = (pedido.items || []).map(i => {
      const talla = i.talla && i.talla !== "—" ? ` (T.${i.talla})` : "";
      const color = i.color ? ` · ${i.color}` : "";
      const qty = i.qty > 1 ? ` x${i.qty}` : "";
      return `${i.name || "Producto"}${talla}${color}${qty}`;
    });
    if (resumen.length) {
      historial.push({ fecha: Date.now(), productos: resumen, total: pedido.total || null });
      if (historial.length > 30) historial = historial.slice(-30);
    }
    await ref.set({
      nombre: pedido.nombre,
      tel: pedido.telefono || existing.tel || null,
      email: pedido.email || existing.email || null,
      cp: pedido.cpDestino || existing.cp || null,
      ultimaCompra: Date.now(),
      cantidadCompras: (existing.cantidadCompras || 0) + 1,
      primeraCompra: existing.primeraCompra || Date.now(),
      historial
    });
    console.log("Cliente guardado:", pedido.nombre);
  } catch (e) {
    console.error("Error guardando cliente:", e.message);
  }
}

// ── CUPONES ──────────────────────────────────────────────────────────────────
function cuponValido(c) {
  if (!c || !c.activo) return false;
  if (c.unUso && c.usado) return false;
  const hoy = new Date().toISOString().slice(0, 10);
  if (c.fechaInicio && c.fechaInicio > hoy) return false;
  if (c.fechaFin && c.fechaFin < hoy) return false;
  return true;
}

async function marcarCuponUsado(code) {
  if (!db || !code) return;
  try {
    const ref = db.ref("config/cupones/" + code);
    const c = (await ref.get()).val();
    if (c && c.unUso) await ref.update({ usado: true, activo: false });
  } catch (e) {
    console.error("Error marcando cupón como usado:", e.message);
  }
}

// ── PROMOS 2x1 / 3x1 (misma lógica que la tienda) ────────────────────────────
function promoVigente(p) {
  if (!p || !p.activo) return false;
  const hoy = new Date().toISOString().slice(0, 10);
  if (p.fechaInicio && p.fechaInicio > hoy) return false;
  if (p.fechaFin && p.fechaFin < hoy) return false;
  return true;
}

function calcPromos(items, promos) {
  let total = 0;
  Object.values(promos || {}).forEach(p => {
    if (!promoVigente(p)) return;
    const lleva = Number(p.lleva) || 0;
    const paga = Number(p.paga) || 0;
    if (lleva < 2 || paga < 1 || paga >= lleva) return;
    const prodsPromo = p.tipo === "productos" ? Object.values(p.productos || {}) : [];
    const unidades = [];
    items.forEach(it => {
      const aplica = p.tipo === "categoria" ? it.cat === p.categoria : prodsPromo.includes(it.prodId);
      if (aplica) for (let i = 0; i < it.qty; i++) unidades.push(it.price);
    });
    unidades.sort((a, b) => b - a);
    const sets = Math.floor(unidades.length / lleva);
    const gratisPorSet = lleva - paga;
    for (let s = 0; s < sets; s++) {
      const set = unidades.slice(s * lleva, (s + 1) * lleva);
      total += set.slice(-gratisPorSet).reduce((a, b) => a + b, 0);
    }
  });
  return total;
}

// ── CÁLCULO DEL TOTAL EN EL SERVIDOR ─────────────────────────────────────────
// Los precios, el cupón y las promos se leen de Firebase. Lo único que todavía
// viene del navegador es el costo de envío (el cotizador corre en la tienda).
async function calcularTotales(pedido, metodo) {
  if (!db) throw new Error("Base de datos no disponible");
  const itemsIn = Array.isArray(pedido && pedido.items) ? pedido.items : [];
  if (!itemsIn.length) throw new ErrorCliente("El carrito está vacío.");
  if (itemsIn.length > 50) throw new ErrorCliente("Demasiados productos en un solo pedido.");

  const items = [];
  let subtotal = 0;
  const usados = {}; // acumula cantidades por bucket de stock (prodId|clave) entre líneas
  for (const it of itemsIn) {
    const prodId = txt(it.prodId || it.id, 60);
    const qty = Math.floor(Number(it.qty));
    if (!prodId || !(qty >= 1 && qty <= 50)) throw new ErrorCliente("Hay un producto inválido en el carrito. Recargá la página.");

    const p = (await db.ref("productos/" + safeKey(prodId)).get()).val();
    if (!p || p.estado === "oculto" || p.estado === "agotado") {
      throw new ErrorCliente(`"${(p && p.name) || "Un producto"}" ya no está disponible. Sacalo del carrito para seguir.`);
    }

    let unit = (Number(p.descuento) > 0 && Number(p.precioFinal) > 0) ? Number(p.precioFinal) : Number(p.price);
    const packQty = Number(p.packQty), packPrice = Number(p.packPrice);
    let esPack = false;
    if (it.esPack && packQty >= 2 && packPrice > 0 && qty % packQty === 0) {
      unit = Math.round(packPrice / packQty);
      esPack = true;
    }
    if (!(unit > 0)) throw new ErrorCliente(`"${p.name}" no tiene precio cargado.`);

    const color = (it.color && typeof it.color === "object") ? (it.color.nombre || it.color.hex || "") : (it.color || "");

    // ── Validar stock disponible (evita vender más de lo que hay) ──
    // Solo bloquea si el producto tiene mapa de stock cargado; si no, no limita
    // (mismo criterio que el front). Para packs, qty ya viene en unidades.
    if (p.stock && typeof p.stock === "object") {
      const tallaRaw = txt(it.talla, 20) || "—";
      const ck = color ? (safeKey(tallaRaw) + "__" + safeKey(color)) : safeKey(tallaRaw);
      let disp, bucketKey;
      if (p.stock[ck] !== undefined) { disp = Number(p.stock[ck]); bucketKey = ck; }
      else if (p.stock[tallaRaw] !== undefined) { disp = Number(p.stock[tallaRaw]); bucketKey = tallaRaw; }
      else if (p.stock[safeKey(tallaRaw)] !== undefined) { disp = Number(p.stock[safeKey(tallaRaw)]); bucketKey = safeKey(tallaRaw); }
      // Acumulamos por bucket: si el mismo producto/talle/color viene en varias
      // líneas (ej. una unidad suelta + un pack), sumamos antes de comparar.
      if (disp !== undefined && !isNaN(disp)) {
        const clave = prodId + "|" + bucketKey;
        usados[clave] = (usados[clave] || 0) + qty;
        if (usados[clave] > disp) {
          if (disp <= 0) throw new ErrorCliente(`"${p.name}" se quedó sin stock. Sacalo del carrito para seguir.`);
          throw new ErrorCliente(`"${p.name}" no tiene stock suficiente (quedan ${disp}). Bajá la cantidad en el carrito.`);
        }
      }
    }

    const name = esPack ? `${p.name} (Pack x${packQty})` : p.name;
    // Preservar datos de "caja de regalo" si el ítem los trae (no afectan el precio)
    const giftExtra = {};
    if (it.giftBoxId) giftExtra.giftBoxId = txt(it.giftBoxId, 40);
    if (it.giftRol) giftExtra.giftRol = txt(it.giftRol, 20);
    if (it.giftNota) giftExtra.giftNota = txt(it.giftNota, 200);
    items.push({
      prodId, name, title: name,
      cat: p.cat || "",
      talla: txt(it.talla, 20) || "—",
      color: txt(color, 40) || "",
      qty, price: unit,
      ...giftExtra
    });
    subtotal += unit * qty;
  }

  let cupon = null, descuentoCupon = 0;
  if (pedido.cupon) {
    const code = String(pedido.cupon).trim().toUpperCase();
    if (/^[A-Z0-9_-]{1,40}$/.test(code)) {
      const c = (await db.ref("config/cupones/" + code).get()).val();
      if (cuponValido(c)) {
        cupon = code;
        descuentoCupon = c.tipo === "porcentaje"
          ? Math.round(subtotal * Math.min(100, Number(c.valor) || 0) / 100)
          : Math.min(Number(c.valor) || 0, subtotal);
      }
    }
  }

  const promos = (await db.ref("config/promos").get()).val() || {};
  const descuentoPromo = calcPromos(items, promos);

  const envio = Math.round(Number(pedido.envio_precio) || 0);
  if (envio < 0 || envio > 300000) throw new ErrorCliente("El costo de envío no es válido. Volvé a calcularlo.");

  let total = subtotal - descuentoCupon - descuentoPromo + envio;
  let descuentoTransferencia = 0;
  if (metodo === "transferencia") {
    descuentoTransferencia = Math.round(total * 0.05);
    total -= descuentoTransferencia;
  }
  total = Math.max(1, Math.round(total));

  return { items, subtotal, cupon, descuentoCupon, descuentoPromo, envio, descuentoTransferencia, total };
}

// Arma el registro del pedido solo con campos conocidos y recortados
function armarPedido(pedido, tot, extra) {
  return {
    ts: Date.now(),
    nombre: txt(pedido.nombre, 80) || "Cliente",
    telefono: txt(pedido.telefono, 40),
    email: txt(pedido.email, 120),
    cpDestino: txt(pedido.cpDestino, 10),
    direccion: txt(pedido.direccion, 200),
    tipoEnvio: txt(pedido.tipoEnvio, 20),
    observaciones: txt(pedido.observaciones, 500),
    items: tot.items,
    subtotal: tot.subtotal,
    cupon: tot.cupon,
    descuentoCupon: tot.descuentoCupon,
    promoDescuento: tot.descuentoPromo,
    envio: txt(pedido.envio, 150),
    envio_tipo: txt(pedido.envio_tipo, 20),
    envio_servicio: txt(pedido.envio_servicio, 40),
    contacto_tipo: txt(pedido.contacto_tipo, 20),
    contacto_dato: txt(pedido.contacto_dato, 120),
    envio_precio: tot.envio,
    descuentoTransferencia: tot.descuentoTransferencia,
    total: tot.total,
    ...extra
  };
}

function responderError(res, e, contexto) {
  if (e instanceof ErrorCliente) return res.status(400).json({ error: e.message });
  console.error(contexto, e);
  return res.status(500).json({ error: "Hubo un problema procesando el pedido. Probá de nuevo en un momento." });
}

// ── WEBHOOK MERCADOPAGO ──────────────────────────────────────────────────────
// Es el ÚNICO lugar donde un pedido de Mercado Pago pasa a "aprobado".
// La info del pago se pide directo a Mercado Pago, así que no se puede falsificar.
app.post("/webhook", async (req, res) => {
  let marcaRef = null;
  try {
    const { type, data } = req.body || {};
    if (type !== "payment") return res.sendStatus(200);
    const paymentId = data && data.id;
    if (!paymentId) return res.sendStatus(200);

    const pago = (await mercadopago.payment.get(paymentId)).body;
    console.log(`Webhook pago ${paymentId}: ${pago.status}`);
    if (pago.status !== "approved") return res.sendStatus(200);
    if (!db) return res.sendStatus(500);

    // Anti-duplicados atómico: solo la primera notificación de este pago sigue
    marcaRef = db.ref("webhook_procesados/" + safeKey(paymentId));
    const marca = await marcaRef.transaction(actual => (actual ? undefined : { ts: Date.now() }));
    if (!marca.committed) {
      marcaRef = null;
      console.log("Pago", paymentId, "ya procesado, ignoro el duplicado");
      return res.sendStatus(200);
    }

    const pedidoKey = (pago.metadata && pago.metadata.pedido_key) || pago.external_reference;
    let pedido = null;
    if (pedidoKey && /^[A-Za-z0-9_-]{5,40}$/.test(pedidoKey)) {
      pedido = (await db.ref("pedidos/" + pedidoKey).get()).val();
    }

    let pedidoFinal;
    if (pedido) {
      if (pedido.estado === "aprobado") return res.sendStatus(200);
      const montoOk = Number(pago.transaction_amount) + 1 >= Number(pedido.total || 0);
      if (!montoOk) console.warn(`Monto pagado ${pago.transaction_amount} menor al total ${pedido.total} del pedido ${pedidoKey}`);
      const cambios = { estado: "aprobado", payment_id: String(paymentId), montoPagado: pago.transaction_amount || 0 };
      if (!montoOk) cambios.revisarMonto = true;
      await db.ref("pedidos/" + pedidoKey).update(cambios);
      pedidoFinal = { ...pedido, ...cambios };
    } else {
      // No encontramos el pedido: lo reconstruimos con la metadata del pago
      console.warn("No encontré el pedido", pedidoKey, "— reconstruyendo desde metadata");
      let itemsDetalle = [];
      try { itemsDetalle = JSON.parse((pago.metadata && pago.metadata.items_detalle) || "[]"); } catch (e) {}
      pedidoFinal = {
        payment_id: String(paymentId),
        estado: "aprobado",
        total: pago.transaction_amount || 0,
        montoPagado: pago.transaction_amount || 0,
        nombre: (pago.payer && pago.payer.first_name) || "Cliente",
        email: (pago.payer && pago.payer.email) || null,
        items: itemsDetalle,
        ts: Date.now(),
        fuente: "webhook_sin_match"
      };
      await db.ref("pedidos").push(pedidoFinal);
    }

    await bajarStockItems(pedidoFinal.items);
    await guardarCliente(pedidoFinal);
    if (pedidoFinal.cupon) await marcarCuponUsado(pedidoFinal.cupon);
    await enviarEmailPedido(pedidoFinal);

    res.sendStatus(200);
  } catch (e) {
    console.error("Error en webhook:", e.message);
    // Si falló a mitad de camino, borramos la marca para que el reintento de MP lo procese
    if (marcaRef) { try { await marcaRef.remove(); } catch (_) {} }
    res.sendStatus(500);
  }
});

// ── CREAR PREFERENCIA (pago con Mercado Pago) ────────────────────────────────
app.post("/crear-preferencia", limiteCompra, async (req, res) => {
  try {
    const pedido = (req.body && req.body.pedido) || {};
    const tot = await calcularTotales(pedido, "mp");

    const ref = db.ref("pedidos").push();
    const pedidoKey = ref.key;
    await ref.set(armarPedido(pedido, tot, {
      estado: "pendiente",
      metodoPago: "mp",
      external_reference: pedidoKey
    }));

    const cantidad = tot.items.reduce((s, i) => s + i.qty, 0);
    const FRONT = process.env.FRONTEND_URL || "https://www.diamantina.shop";
    const preference = {
      // Un solo ítem con el total calculado acá: incluye cupón, promos y envío.
      // El detalle de productos queda guardado en el pedido y en la metadata.
      items: [{
        title: `Compra en Diamantina (${cantidad} producto${cantidad !== 1 ? "s" : ""})`,
        quantity: 1,
        unit_price: tot.total,
        currency_id: "ARS"
      }],
      back_urls: {
        success: FRONT + "/?page=success",
        failure: FRONT + "/?page=error",
        pending: FRONT + "/?page=success"
      },
      auto_return: "approved",
      statement_descriptor: "DIAMANTINA",
      binary_mode: true,
      payment_methods: { installments: 12 },
      external_reference: pedidoKey,
      notification_url: (process.env.BACKEND_URL || "https://diamantina-backend.onrender.com") + "/webhook",
      metadata: {
        pedido_key: pedidoKey,
        items_detalle: JSON.stringify(tot.items.map(i => ({
          prodId: i.prodId, talla: i.talla, color: i.color, qty: i.qty, name: i.name, price: i.price
        })))
      }
    };

    const response = await mercadopago.preferences.create(preference);
    res.json({
      id: response.body.id,
      init_point: response.body.init_point,
      pedidoKey,
      total: tot.total
    });
  } catch (e) {
    responderError(res, e, "Error creando preferencia:");
  }
});

// ── PEDIDO POR TRANSFERENCIA ─────────────────────────────────────────────────
// El estado siempre es "pendiente_transferencia" (ya no se puede mandar
// "aprobado" desde afuera). Reserva stock, guarda cliente, marca cupón y avisa.
app.post("/guardar-pedido", limiteTransferencia, async (req, res) => {
  try {
    const pedido = (req.body && req.body.pedido) || {};
    const tot = await calcularTotales(pedido, "transferencia");
    const orderId = "TRANSF-" + Date.now();
    const registro = armarPedido(pedido, tot, {
      estado: "pendiente_transferencia",
      metodoPago: "transferencia",
      payment_id: orderId
    });
    const ref = await db.ref("pedidos").push(registro);

    await bajarStockItems(registro.items);
    await guardarCliente(registro);
    if (registro.cupon) await marcarCuponUsado(registro.cupon);
    await enviarEmailPedido(registro);

    res.json({ ok: true, key: ref.key, total: tot.total, orderId });
  } catch (e) {
    responderError(res, e, "Error guardando pedido por transferencia:");
  }
});

// ── BORRAR PEDIDO (solo admin logueado) ──────────────────────────────────────
app.post("/borrar-pedido", requireAdmin, async (req, res) => {
  try {
    const key = req.body && req.body.key;
    if (!key || !/^[A-Za-z0-9_-]{5,40}$/.test(key)) return res.status(400).json({ error: "key inválida" });
    await db.ref("pedidos/" + key).remove();
    console.log("Pedido borrado por", req.adminUid, ":", key);
    res.json({ ok: true });
  } catch (e) {
    console.error("Error borrando pedido:", e.message);
    res.status(500).json({ error: "No se pudo borrar" });
  }
});

// ── BAJAR STOCK MANUAL (solo admin logueado) ─────────────────────────────────
app.post("/bajar-stock", requireAdmin, async (req, res) => {
  try {
    await bajarStockItems((req.body && req.body.items) || []);
    res.json({ ok: true });
  } catch (e) {
    console.error("Error bajando stock:", e.message);
    res.status(500).json({ error: "No se pudo bajar el stock" });
  }
});

// ── ANDREANI COTIZAR ─────────────────────────────────────────────────────────
app.post("/andreani-cotizar", limiteCompra, async (req, res) => {
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
    res.status(500).json({ error: "No se pudo cotizar con Andreani" });
  }
});

// ── CORREO ARGENTINO COTIZAR ──────────────────────────────────────────────────
// Acepta { cpDestino, peso?, largo?, ancho?, alto? } y devuelve las opciones
// Clásico y Expreso con precio en ARS, o un error si la API no responde.
app.post("/correo-cotizar", limiteCompra, async (req, res) => {
  try {
    if (!CORREO_USER || !CORREO_PASS) {
      return res.status(503).json({ error: "Credenciales Correo no configuradas" });
    }
    const {
      cpDestino,
      peso  = 500,   // gramos — un típico paquete de lencería
      largo = 20,    // cm
      ancho = 15,    // cm
      alto  = 8      // cm
    } = req.body || {};

    if (!cpDestino) return res.status(400).json({ error: "cpDestino requerido" });

    // Validación básica: CP argentino = 4 dígitos
    const cp = String(cpDestino).trim();
    if (!/^\d{4}$/.test(cp)) return res.status(400).json({ error: "cpDestino debe ser un código postal de 4 dígitos" });

    // Validar dimensiones dentro de los límites del API (máx 50 000g / 200cm)
    const pesoG    = Math.min(Math.max(Number(peso)  || 500,    1), 50000);
    const largoC   = Math.min(Math.max(Number(largo) || 20,     1), 200);
    const anchoC   = Math.min(Math.max(Number(ancho) || 15,     1), 200);
    const altoC    = Math.min(Math.max(Number(alto)  || 8,      1), 200);
    const sumaLados = largoC + anchoC + altoC;
    if (sumaLados > 300) {
      return res.status(400).json({ error: "Las dimensiones superan el máximo de 300 cm de suma de lados" });
    }

    const token      = await getCorreoToken();
    const customerId = CORREO_CUSTOMER_ID || _correoCustomerId || CORREO_USER;

    // Omitimos deliveredType: la API devuelve en "rates" las dos modalidades
    // (D = domicilio, S = sucursal) en un solo request.
    const cotizacion = await axios.post(
      `${CORREO_BASE}/rates`,
      {
        customerId,
        postalCodeOrigin:      CORREO_CP_ORIGEN,
        postalCodeDestination: cp,
        dimensions: { weight: pesoG, height: altoC, width: anchoC, length: largoC }
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 10000 }
    );

    // La respuesta real es { rates: [{ deliveredType, productName, price, deliveryTimeMin, deliveryTimeMax }] }
    const rates = (cotizacion.data && Array.isArray(cotizacion.data.rates)) ? cotizacion.data.rates : [];
    const resultado = rates.map(r => {
      const precio = Math.round(Number(r.price) || 0);
      const dMin = r.deliveryTimeMin, dMax = r.deliveryTimeMax;
      const plazo = (dMin && dMax) ? `${dMin}–${dMax} días hábiles` : (dMax ? `${dMax} días hábiles` : null);
      return {
        nombre: r.productName || "Correo Argentino",
        precio,
        plazo,
        tipo: r.deliveredType === "S" ? "sucursal" : "domicilio"
      };
    }).filter(o => o.precio > 0);

    if (!resultado.length) {
      return res.status(404).json({ error: "No se obtuvieron tarifas para ese código postal" });
    }
    resultado.sort((a, b) => a.precio - b.precio);
    res.json({ opciones: resultado });

  } catch (err) {
    // Si el token expiró antes de las 23h (edge case), limpiarlo para que el próximo
    // request lo regenere
    if (err?.response?.status === 401) {
      _correoToken = null;
      _correoTokenTs = 0;
    }
    console.error("Correo Argentino error:", err?.response?.data || err.message);
    res.status(500).json({ error: "No se pudo cotizar con Correo Argentino" });
  }
});

// ── PRODUCT PREVIEW (para WhatsApp/redes sociales) ──────────────────────────
app.get("/p/:id", async (req, res) => {
  const id = req.params.id;
  const TIENDA = process.env.FRONTEND_URL || "https://www.diamantina.shop";
  try {
    if (!db) throw new Error("DB no disponible");
    const p = (await db.ref("productos/" + safeKey(id)).get()).val();
    if (!p) return res.redirect(302, TIENDA + "/?producto=" + encodeURIComponent(id));

    const nombre = escHtml(p.name || "Diamantina Lencería");
    const desc = escHtml(String(p.desc || "Lencería de diseño en Argentina").replace(/<[^>]+>/g, "").slice(0, 160));
    const precio = p.precioFinal || p.price || 0;
    const img = escHtml((p.imgs && p.imgs[0]) || p.img ||
      "https://res.cloudinary.com/dy1yckjcj/image/upload/v1780442730/6011F3D2-4EA7-4B2B-A4C8-9F217ADD2F2B_lmotkd.png");
    const url = TIENDA + "/?producto=" + encodeURIComponent(id);
    const urlHtml = escHtml(url);
    const precioStr = precio ? " — $" + Number(precio).toLocaleString("es-AR") : "";

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${nombre} — Diamantina Lencería</title>
  <meta name="description" content="${desc}${precioStr}">
  <meta property="og:type" content="product">
  <meta property="og:title" content="${nombre} — Diamantina Lencería">
  <meta property="og:description" content="${desc}${precioStr}">
  <meta property="og:image" content="${img}">
  <meta property="og:image:width" content="800">
  <meta property="og:image:height" content="800">
  <meta property="og:url" content="${urlHtml}">
  <meta property="og:site_name" content="Diamantina Lencería">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${nombre} — Diamantina Lencería">
  <meta name="twitter:description" content="${desc}${precioStr}">
  <meta name="twitter:image" content="${img}">
  <meta http-equiv="refresh" content="0; url=${urlHtml}">
  <link rel="canonical" href="${urlHtml}">
</head>
<body>
  <p>Redirigiendo a <a href="${urlHtml}">${nombre}</a>...</p>
  <script>window.location.replace(${JSON.stringify(url)});</script>
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
    service: "Diamantina Backend v4",
    firebase: db ? "conectado" : "NO conectado",
    andreani: ANDREANI_SANDBOX ? "sandbox" : "producción",
    correo: CORREO_BASE.includes("apitest") ? "sandbox" : "producción",
    mp: process.env.ACCESS_TOKEN ? "configurado" : "NO configurado",
    email: EMAILJS_PRIVATE_KEY ? "configurado" : "NO configurado"
  })
);

app.listen(process.env.PORT || 3000, () =>
  console.log("Diamantina Backend v3 corriendo")
);
