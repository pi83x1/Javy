import express from "express";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_TOKEN = process.env.PAGE_TOKEN;   // sirve para Messenger e Instagram
const WA_TOKEN = process.env.WA_TOKEN;       // WhatsApp Cloud API
const WA_PHONE_ID = process.env.WA_PHONE_ID;
const GEMINI_KEY = process.env.GEMINI_KEY;   // gratis en ai.google.dev

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

async function askAI(text) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
    }
  );
  const data = await r.json();
  return (
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "Gracias por tu mensaje, te responderemos pronto."
  );
}

async function sendFbOrIg(recipientId, text) {
  await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
}

async function sendWhatsApp(to, text) {
  await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_TOKEN}`,
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to, text: { body: text } }),
  });
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Meta necesita respuesta inmediata
  const body = req.body;

  if (body.object === "page" || body.object === "instagram") {
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender?.id;
        const text = event.message?.text;
        if (senderId && text) {
          const reply = await askAI(text);
          await sendFbOrIg(senderId, reply);
        }
      }
    }
  }

  if (body.object === "whatsapp_business_account") {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        for (const msg of change.value?.messages || []) {
          const from = msg.from;
          const text = msg.text?.body;
          if (from && text) {
            const reply = await askAI(text);
            await sendWhatsApp(from, reply);
          }
        }
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook activo en puerto ${PORT}`));
