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
const ANDREANI_BASE = "https://apis-sandbox.andreani.com";

async function getAndreaniToken() {
  const res = await axios.post(`${ANDREANI_BASE}/v1/login`, {
    usuario: ANDREANI_USER,
    password: ANDREANI_PASS,
  });
  return res.headers["x-authorization-token"] || res.data.token;
}

app.post("/cotizar-envio", async (req, res) => {
  try {
    const { cpDestino, bultos } = req.body;
    const token = await getAndreaniToken();
    const params = new URLSearchParams({
      cpOrigen: ANDREANI_CP_ORIGEN,
      cpDestino,
      contrato: process.env.ANDREANI_CONTRATO || "",
      bultos: JSON.stringify(bultos || [{ peso: 0.5, volumen: 1000 }]),
    });
    const cotizacion = await axios.get(
      `${ANDREANI_BASE}/v1/tarifas?${params}`,
      { headers: { "x-authorization-token": token } }
    );
    res.json(cotizacion.data);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: err?.response?.data || err.message });
  }
});

app.post("/crear-preferencia", async (req, res) => {
  try {
    const { items } = req.body;
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

app.get("/", (req, res) => res.send("Diamantina backend OK"));
app.listen(process.env.PORT || 3000, () => console.log("Servidor corriendo"));
