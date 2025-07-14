// index.js

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

//-----------------------------------------
// MongoDB Setup
//-----------------------------------------
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('Mongo Error:', err));

const chatSchema = new mongoose.Schema({
  phone: String,
  messages: [
    {
      role: String, // 'user' or 'model'
      text: String,
      timestamp: Date
    }
  ]
});

const userInfoSchema = new mongoose.Schema({
  phone: String,
  data: {
    name: String,
    city: String,
    preferences: [String],
    healthIssues: [String],
    interestedProducts: [String],
    extractedAt: Date
  }
});

const Chat = mongoose.model('Chat', chatSchema);
const UserInfo = mongoose.model('UserInfo', userInfoSchema);

//-----------------------------------------
// Webhook Verification
//-----------------------------------------
app.get('/webhook', (req, res) => {
  const verify_token = 'HEHEHAHA';

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === verify_token) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

//-----------------------------------------
// Main Message Handler
//-----------------------------------------
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;

    if (messages && messages.length > 0) {
      const msg = messages[0];
      const from = msg.from;
      const userMsg = msg.text?.body || '';
      const isReply = !!msg.context;
      const replyToMsgId = isReply ? msg.id : null;

      // Store user message
      await Chat.findOneAndUpdate(
        { phone: from },
        { $push: { messages: { role: 'user', text: userMsg, timestamp: new Date() } } },
        { upsert: true }
      );

      // Generate Gemini reply with context
      const reply = await getGeminiReply(from);

      // Store Gemini's response
      await Chat.findOneAndUpdate(
        { phone: from },
        { $push: { messages: { role: 'model', text: reply, timestamp: new Date() } } },
        { upsert: true }
      );

      // Send WhatsApp message
      await sendWhatsappMessage(from, reply, replyToMsgId);

      // Run data extraction and store user info
      await extractAndStoreUserInfo(from);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

//-----------------------------------------
// Gemini LLM with Context
//-----------------------------------------
async function getGeminiReply(phone) {
  const chat = await Chat.findOne({ phone });
  const history = chat?.messages || [];

  const contents = history.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.text }]
  }));

  contents.unshift({
    role: 'model',
    parts: [{ text: "You are the AI Wellness Assistant for the brand ‘Daily All Day,’ a trusted name in herbal and wellness supplements. Your main role is to engage customers in warm, friendly, and informative conversations to help them understand their health concerns (such as stress, digestion, joint health, immunity, metabolism, etc.), educate them on lifestyle tips, and introduce ‘Daily All Day’ products as genuine, science-backed solutions—but only when the customer feels informed, comfortable, and understood.\\n\\nYou focus on building trust by offering valuable, insightful advice and by explaining how the products work—highlighting ingredients, benefits, and applications—without exaggeration. You always answer questions with clarity, confidence, and honesty.\\n\\nYou are not pushy. If a product isn’t a good fit, you provide sincere guidance or suggest consulting a healthcare professional. Your aim is to leave customers feeling informed, respected, and excited to try the product because they see its value.\\n\\nAlways:\\n- Acknowledge customer concerns sincerely.\\n- Avoid strict medical advice and recommend professional consultation when needed.\\n- When recommending a product, focus on relatable, benefit-driven language and help customers feel confident in their choice.\\n\\nTone:\\n- Empathetic, supportive, and conversational—like a trusted friend.\\n- Knowledgeable but relaxed—avoid jargon.\\n- Open to light humor and friendliness when appropriate.\\n\\nWhen replying:\\n- Keep answers short, natural, and human-like—no long explanations unless the customer asks for more.\\n- Prioritize clear, to-the-point responses like a helpful store assistant would.\\n- If the user types in Hindi, Hinglish, or mixes English with Hindi, respond naturally in the same tone and language style.\\n\\nBrand Story:\\nAt Daily All Day, we believe true health isn’t built in a day—it’s built every day. Our name reflects our philosophy: health is a habit, not a one-time event. We blend the timeless wisdom of Ayurveda with modern science to create plant-powered, science-backed supplements that help you take control of your health gently, naturally, and consistently. We stand for daily care, small consistent steps, and real wellness over quick fixes.\\n\\nOur products are manufactured in top-tier nutraceutical facilities with ISO, HACCP, NABL, and Non-GMO certifications, using rigorously tested, pure ingredients in a clean, controlled environment.\\n\\nCore Beliefs:\\n- Ayurveda & Science, hand in hand.\\n- Health is a habit, not an event.\\n- Quality you can trust—every batch, every capsule.\\n\\nProduct Knowledge:\\n1. GLUCO WISE: Supports blood sugar, cholesterol, insulin sensitivity, liver detox, weight management.\\n2. JOINT CARE: Reduces joint pain, stiffness, inflammation; supports flexibility, sports recovery.\\n3. SLIM SUPPORT: Helps weight management, fat metabolism, digestion, sugar control.\\n4. STRENGTH ESSENCE: Boosts stamina, muscle strength; reduces stress, supports libido.\\n5. STRESS FREE: Promotes calm, sleep, mood, focus.\\n6. TOTAL WELLNESS VEGAN OMEGA 3-6-9: Heart, brain, joint, skin, hormonal balance support.\\n7. TRIPHALA 1:2:3: Superior digestion, detox, immunity with classical 1:2:3 Ayurvedic ratio.\\n8. VITA BLEND: Daily multivitamin + 23 herbs + antioxidants for total wellness.\\n9. HIMALAYAN SEA BUCKTHORN JUICE: Boosts immunity, skin glow, digestion, anti-aging.\\n\\nAll products:\\n- Vegan\\n- No preservatives\\n- Dose: 1 capsule/tablet or 15 ml juice twice daily unless specified\\n- Adult use only\\n- Consult doctor if pregnant, breastfeeding, or on medication. \\n\\nNote: Only give replies in less than 3000 characters."}]
  });

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents }
    );
    return response.data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't understand.";
  } catch (err) {
    console.error('Gemini error:', err.response?.data || err.message);
    return "Sorry, I couldn't reply right now.";
  }
}

//-----------------------------------------
// WhatsApp Reply Sender
//-----------------------------------------
async function sendWhatsappMessage(to, text, replyToMsgId = null) {
  const body = {
    messaging_product: 'whatsapp',
    to,
    text: { body: text }
  };

  if (replyToMsgId) {
    body.context = { message_id: replyToMsgId };
  }

  try {
    await axios.post(
      `https://graph.facebook.com/${process.env.VERSION}/${process.env.PHONE_NUMBER_ID}/messages`,
      body,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('WhatsApp send error:', err.response?.data || err.message);
  }
}

//-----------------------------------------
// Extract Info with Gemini
//-----------------------------------------
async function extractAndStoreUserInfo(phone) {
  const chat = await Chat.findOne({ phone });
  if (!chat) return;

  const fullText = chat.messages.filter(m => m.role === 'user').map(m => m.text).join('\n');

  const prompt = `Extract structured info from the user's messages in JSON format like:
{
  name: "",
  city: "",
  preferences: [""],
  healthIssues: [""],
  interestedProducts: [""],
  phone: "${phone}"
}

User's messages:
${fullText}`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      }
    );

    let jsonText = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
    jsonText = jsonText.substring(start, end + 1);
    }

    let extracted = {};
    try {
    extracted = JSON.parse(jsonText);
    } catch (err) {
    console.error('JSON parse error:', err.message);
    }

    // const extracted = JSON.parse(jsonText);

    await UserInfo.findOneAndUpdate(
      { phone },
      { data: { ...extracted, extractedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error('Gemini extract error:', err.response?.data || err.message);
  }
}

//-----------------------------------------
// Start Server
//-----------------------------------------
app.listen(process.env.PORT, () => {
  console.log('Server running on port ' + process.env.PORT);
});
