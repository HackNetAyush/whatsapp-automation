const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

//-----------------------------------------
// MongoDB Setup
//-----------------------------------------
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.error("Mongo Error:", err));

const chatSchema = new mongoose.Schema({
  phone: String,
  messages: [
    {
      role: String, // 'user' or 'model'
      text: String,
      timestamp: Date,
    },
  ],
});

const userInfoSchema = new mongoose.Schema({
  phone: String,
  data: {
    name: String,
    city: String,
    preferences: [String],
    healthIssues: [String],
    interestedProducts: [String],
    extractedAt: Date,
  },
});

const Chat = mongoose.model("Chat", chatSchema);
const UserInfo = mongoose.model("UserInfo", userInfoSchema);

//-----------------------------------------
// Testing Scripts
//-----------------------------------------

app.post("/test", async (req, res) => {
  try {
    const { wa, prompt } = req.body;
    console.log("Test request received:", { wa, prompt });
    // res.send("Test request received successfully!");

    const r = await messageHandler(wa, prompt);

    if (r.status === "success") {
      console.log("Test message processed successfully!");
      res.json({ status: "success", message: r.message });
    } else {
      console.error("Test message processing failed:", r.message);
      res.status(500).json({ status: "error", message: r.message });
    }
  } catch (err) {
    console.error("Test error:", err);
    res.status(500).send("Error processing test message");
  }
});

async function messageHandler(entry, prompt) {
  try {
    // const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;

    if (messages && messages.length > 0) {
      const msg = messages[0];
      const from = msg.from;
      const userMsg = msg.text?.body || "";
      const isReply = !!msg.context;
      const replyToMsgId = isReply ? msg.id : null;

      // Store user message
      await Chat.findOneAndUpdate(
        { phone: from },
        {
          $push: {
            messages: { role: "user", text: userMsg, timestamp: new Date() },
          },
        },
        { upsert: true }
      );

      // Generate Gemini reply with context
      const reply = await getGeminiReply(from, prompt);

      console.log("User message:", userMsg);
      console.log("Gemini reply:", reply);

      // Store Gemini's response
      await Chat.findOneAndUpdate(
        { phone: from },
        {
          $push: {
            messages: { role: "model", text: reply, timestamp: new Date() },
          },
        },
        { upsert: true }
      );

      // Send WhatsApp message
      await sendWhatsappMessage(from, reply, replyToMsgId);

      // Run data extraction and store user info
      await extractAndStoreUserInfo(from);
    }

    // res.sendStatus(200);
    // res.json({status: "success", message: "Message processed successfully!"});
    return { status: "success", message: "Message processed successfully!" };
  } catch (err) {
    console.error("Webhook error:", err);
    return { status: "error", message: "Error processing message" };
  }
}

//-----------------------------------------
// Webhook Verification
//-----------------------------------------

app.get("/", (req, res) => {
  res.send("Welcome to the WhatsApp Gemini Bot!");
});

//-----------------------------------------
// Gemini LLM with Context
//-----------------------------------------
async function getGeminiReply(phone, prompt) {
  const chat = await Chat.findOne({ phone });
  const history = chat?.messages || [];

  const contents = history.map((msg) => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: msg.text }],
  }));

  contents.unshift({
    role: "model",
    parts: [
      {
        text:
          prompt + "\n Note: Only give replies in less than 3000 characters. " ||
          "You are a helpful assistant. Reply to the user's messages.",
      },
    ],
  });

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents }
    );
    return (
      response.data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Sorry, I couldn't understand."
    );
  } catch (err) {
    console.error("Gemini error:", err.response?.data || err.message);
    return "Sorry, I couldn't reply right now.";
  }
}

//-----------------------------------------
// WhatsApp Reply Sender
//-----------------------------------------
async function sendWhatsappMessage(to, text, replyToMsgId = null) {
  const body = {
    messaging_product: "whatsapp",
    to,
    text: { body: text },
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
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("WhatsApp send error:", err.response?.data || err.message);
  }
}

//-----------------------------------------
// Extract Info with Gemini
//-----------------------------------------
async function extractAndStoreUserInfo(phone) {
  const chat = await Chat.findOne({ phone });
  if (!chat) return;

  const fullText = chat.messages
    .filter((m) => m.role === "user")
    .map((m) => m.text)
    .join("\n");

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
        contents: [{ parts: [{ text: prompt }] }],
      }
    );

    let jsonText =
      response.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      jsonText = jsonText.substring(start, end + 1);
    }

    let extracted = {};
    try {
      extracted = JSON.parse(jsonText);
    } catch (err) {
      console.error("JSON parse error:", err.message);
    }

    // const extracted = JSON.parse(jsonText);

    await UserInfo.findOneAndUpdate(
      { phone },
      { data: { ...extracted, extractedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error("Gemini extract error:", err.response?.data || err.message);
  }
}

//-----------------------------------------
// Start Server
//-----------------------------------------
app.listen(process.env.PORT, () => {
  console.log("Server running on port " + process.env.PORT);
});
