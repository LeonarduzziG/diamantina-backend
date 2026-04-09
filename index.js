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
    const { items, payer } = req.body;
    const preference = {
      items,
      payer,
      back_urls: {
        success: process.env.FRONTEND_URL + "?pago=aprobado",
        failure: process.env.FRONTEND_URL + "?pago=fallido",
        pending: process.env.FRONTEND_URL + "?pago=pendiente",
      },
      auto_return: "approved",
      statement_descriptor: "DIAMANTINA",
      expires: false,
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
