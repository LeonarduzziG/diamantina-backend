const express = require("express");
const mercadopago = require("mercadopago");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
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
        success: process.env.FRONTEND_URL + "?pago=aprobado",
        failure: process.env.FRONTEND_URL + "?pago=fallido",
        pending: process.env.FRONTEND_URL + "?pago=pendiente",
      },
      auto_return: "approved",
      statement_descriptor: "DIAMANTINA",
      binary_mode: false,
      payment_methods: {
        excluded_payment_types: [],
        installments: 12,
      },
    };
    const response = await mercadopago.preferences.create(preference);
    res.json({
      id: response.body.id,
      init_point: response.body.init_point,
    });
  } catch (err) {
    console.error(JSON.stringify(err, null, 2));
    res.status(500).json({ error: err.message, detail: err });
  }
});

app.get("/", (req, res) => res.send("Diamantina backend OK"));

app.listen(process.env.PORT || 3000, () => console.log("Servidor corriendo"));
