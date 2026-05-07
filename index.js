const express = require("express");
const mercadopago = require("mercadopago");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

mercadopago.configure({ access_token: process.env.ACCESS_TOKEN });

const ANDREANI_USER = process.env.ANDREANI_USER;
const ANDREANI_PASS = process.env.ANDREANI_PASS;
const ANDREANI_CP_ORIGEN = process.env.ANDREANI_CP_ORIGEN || "1712";
const ANDREANI_CONTRATO = process.env.ANDREANI_CONTRATO || "";

// Producción vs Sandbox — cambiá a false cuando tengas credenciales reales
const ANDREANI_SANDBOX = process.env.ANDREANI_SANDBOX !== "false";
const ANDREANI_BASE = ANDREANI_SANDBOX
  ? "https://apis-sandbox.andreani.com"
  : "https://apis.andreani.com";

// Cache del token (dura 24hs)
let _andreaniToken = null;
let _andreaniTokenTs = 0;

async function getAndreaniToken() {
  const ahora = Date.now();
  // Reusar token si tiene menos de 23hs
  if (_andreaniToken && ahora - _andreaniTokenTs < 23 * 60 * 60 * 1000) {
    return _andreaniToken;
  }
  const res = await axios.post(
    `${ANDREANI_BASE}/v1/login`,
    {},
    {
      auth: { username: ANDREANI_USER, password: ANDREANI_PASS },
      timeout: 8000,
    }
  );
  _andreaniToken = res.headers["x-authorization-token"] || res.data.token;
  _andreaniTokenTs = ahora;
  return _andreaniToken;
}

// ── COTIZAR ENVÍO (usado por la tienda) ──────────────────────────────────────
// El front llama: POST /andreani-cotizar { cpDestino, peso, largo, ancho, alto }
app.post("/andreani-cotizar", async (req, res) => {
  try {
    if (!ANDREANI_USER || !ANDREANI_PASS) {
      return res.status(503).json({ error: "Credenciales Andreani no configuradas" });
    }

    const {
      cpDestino,
      peso = 0.3,
      largo = 20,
      ancho = 15,
      alto = 5,
    } = req.body;

    if (!cpDestino) {
      return res.status(400).json({ error: "cpDestino requerido" });
    }

    const token = await getAndreaniToken();

    const bultos = [{ peso, volumen: largo * ancho * alto }];

    const params = new URLSearchParams({
      cpOrigen: ANDREANI_CP_ORIGEN,
      cpDestino: String(cpDestino).trim(),
      contrato: ANDREANI_CONTRATO,
      bultos: JSON.stringify(bultos),
    });

    const cotizacion = await axios.get(
      `${ANDREANI_BASE}/v1/tarifas?${params}`,
      {
        headers: { "x-authorization-token": token },
        timeout: 8000,
      }
    );

    const data = cotizacion.data;

    // Andreani devuelve un array de opciones — tomamos la más barata (Estándar)
    let precio = null;
    let nombre = "Andreani";
    let plazo = null;

    if (Array.isArray(data) && data.length > 0) {
      // Ordenar por precio y tomar el más bajo
      const ordenados = data.sort(
        (a, b) =>
          (a.tarifaConIva || a.precio || 0) - (b.tarifaConIva || b.precio || 0)
      );
      const opcion = ordenados[0];
      precio = Math.round(opcion.tarifaConIva || opcion.precio || 0);
      nombre = opcion.descripcion || opcion.nombre || "Andreani Estándar";
      plazo = opcion.plazoDeEntrega || opcion.diasHabiles || null;
    } else if (data.tarifaConIva || data.precio) {
      precio = Math.round(data.tarifaConIva || data.precio);
      nombre = data.descripcion || "Andreani";
      plazo = data.plazoDeEntrega || null;
    }

    if (!precio) {
      return res.status(404).json({ error: "No se pudo obtener precio" });
    }

    res.json({ precio, nombre, plazo, raw: data });
  } catch (err) {
    console.error("Andreani error:", err?.response?.data || err.message);
    res.status(500).json({ error: err?.response?.data || err.message });
  }
});

// ── COTIZAR ENVÍO (endpoint viejo — mantener compatibilidad) ─────────────────
app.post("/cotizar-envio", async (req, res) => {
  try {
    const { cpDestino, bultos } = req.body;
    const token = await getAndreaniToken();
    const params = new URLSearchParams({
      cpOrigen: ANDREANI_CP_ORIGEN,
      cpDestino,
      contrato: ANDREANI_CONTRATO,
      bultos: JSON.stringify(bultos || [{ peso: 0.3, volumen: 1500 }]),
    });
    const cotizacion = await axios.get(
      `${ANDREANI_BASE}/v1/tarifas?${params}`,
      { headers: { "x-authorization-token": token }, timeout: 8000 }
    );
    res.json(cotizacion.data);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: err?.response?.data || err.message });
  }
});

// ── CREAR PREFERENCIA MERCADOPAGO ────────────────────────────────────────────
app.post("/crear-preferencia", async (req, res) => {
  try {
    const { items } = req.body;
    const preference = {
      items: items.map((i) => ({
        title: i.title,
        quantity: Number(i.quantity),
        unit_price: Number(i.unit_price),
        currency_id: "ARS",
      })),
      back_urls: {
        success:
          (process.env.FRONTEND_URL || "https://www.diamantina.shop") +
          "/?page=success",
        failure:
          (process.env.FRONTEND_URL || "https://www.diamantina.shop") +
          "/?page=error",
        pending:
          (process.env.FRONTEND_URL || "https://www.diamantina.shop") +
          "/?page=success",
      },
      auto_return: "approved",
      statement_descriptor: "DIAMANTINA",
      binary_mode: false,
      payment_methods: { installments: 12 },
    };
    const response = await mercadopago.preferences.create(preference);
    res.json({ id: response.body.id, init_point: response.body.init_point });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({
    status: "OK",
    service: "Diamantina Backend",
    andreani: ANDREANI_SANDBOX ? "sandbox" : "producción",
    andreaniUser: ANDREANI_USER ? "configurado" : "NO configurado",
  })
);

app.listen(process.env.PORT || 3000, () =>
  console.log(`Servidor corriendo — Andreani: ${ANDREANI_SANDBOX ? "SANDBOX" : "PRODUCCIÓN"}`)
);
