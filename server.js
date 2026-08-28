import express from "express";

const app = express();
app.use(express.json());

// .trim() por si Render guarda un espacio o salto de línea de más al pegar.
const clean = (v) => (v || "").trim();
const VERIFY_TOKEN = clean(process.env.VERIFY_TOKEN);
const PAGE_TOKEN = clean(process.env.PAGE_TOKEN);   // token de página, sirve para Messenger
const IG_TOKEN = clean(process.env.IG_TOKEN);       // token de Instagram (cuenta essenconflavi)
const WA_TOKEN = clean(process.env.WA_TOKEN);       // WhatsApp Cloud API
const WA_PHONE_ID = clean(process.env.WA_PHONE_ID);
const GEMINI_KEY = clean(process.env.GEMINI_KEY);   // gratis en ai.google.dev

const SYSTEM_PROMPT = `Sos el asistente virtual de Essen con Flavia, una consultora de productos Essen (línea de cocina). Respondé de forma breve, cercana y útil a los mensajes de clientes en redes sociales. Si no sabés algo puntual (precio exacto, stock), decí que Flavia lo confirma a la brevedad.`;

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

// Envuelve fetch: loguea si la respuesta no es 2xx, para poder ver errores en los logs de Render.
async function callAPI(label, url, options) {
  try {
    const r = await fetch(url, options);
    const data = await r.json().catch(() => null);
    if (!r.ok) console.error(`${label} ERROR ${r.status}:`, JSON.stringify(data));
    return data;
  } catch (err) {
    console.error(`${label} EXCEPCION:`, err.message);
    return null;
  }
}

async function askAI(text) {
  const data = await callAPI(
    "GEMINI",
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text }] }],
      }),
    }
  );
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  console.log("GEMINI RESPUESTA:", reply);
  return reply || "Gracias por tu mensaje, te responderemos pronto.";
}

async function sendMessenger(recipientId, text) {
  return callAPI(
    "MESSENGER",
    `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
    }
  );
}

async function sendInstagram(recipientId, text) {
  return callAPI(
    "INSTAGRAM",
    `https://graph.instagram.com/v21.0/me/messages?access_token=${IG_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
    }
  );
}

async function sendWhatsApp(to, text) {
  return callAPI(
    "WHATSAPP",
    `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WA_TOKEN}`,
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to, text: { body: text } }),
    }
  );
}

async function replyToFbComment(commentId, text) {
  return callAPI(
    "FB_COMMENT",
    `https://graph.facebook.com/v20.0/${commentId}/comments?access_token=${PAGE_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    }
  );
}

async function replyToIgComment(commentId, text) {
  return callAPI(
    "IG_COMMENT",
    `https://graph.instagram.com/v21.0/${commentId}/replies?access_token=${IG_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    }
  );
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Meta necesita respuesta inmediata
  const body = req.body;
  console.log("WEBHOOK RECIBIDO:", JSON.stringify(body));

  if (body.object === "page" || body.object === "instagram") {
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender?.id;
        const text = event.message?.text;
        if (senderId && text) {
          const reply = await askAI(text);
          if (body.object === "page") await sendMessenger(senderId, reply);
          else await sendInstagram(senderId, reply);
        }
      }

      for (const change of entry.changes || []) {
        if (body.object === "page" && change.field === "feed" && change.value?.item === "comment") {
          const text = change.value?.message;
          const commentId = change.value?.comment_id;
          const isOwnComment = change.value?.from?.id === entry.id;
          if (text && commentId && !isOwnComment) {
            const reply = await askAI(text);
            await replyToFbComment(commentId, reply);
          }
        }

        if (body.object === "instagram" && change.field === "comments") {
          const text = change.value?.text;
          const commentId = change.value?.id;
          const isOwnComment = change.value?.from?.id === entry.id;
          if (text && commentId && !isOwnComment) {
            const reply = await askAI(text);
            await replyToIgComment(commentId, reply);
          }
        }

        // Instagram también puede mandar el mensaje de texto real por "changes"
        // con field "messages" (en vez de entry.messaging), formato Graph API.
        if (body.object === "instagram" && change.field === "messages") {
          const senderId = change.value?.sender?.id;
          const text = change.value?.message?.text;
          const isOwnMessage = senderId === entry.id;
          if (senderId && text && !isOwnMessage) {
            const reply = await askAI(text);
            await sendInstagram(senderId, reply);
          }
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
