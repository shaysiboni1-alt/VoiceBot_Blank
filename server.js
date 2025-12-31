require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Config ---
const PORT = process.env.PORT || 1000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || process.env.MB_WEBHOOK_URL;

// --- Prompt ---
const SYSTEM_INSTRUCTIONS = `
את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
חוקים קבועים:
1) עני בעברית בלבד בצורה קצרה (1-2 משפטים).
2) אל תברכי שוב אחרי תחילת השיחה.
3) אם הלקוח אומר תודה/סיימנו, סיימי בנימוס.
${process.env.MB_BUSINESS_PROMPT || ''}
`.trim();

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('BluBinet Gemini Full Logic is Active'));

// Twilio TwiML
app.post('/twilio-voice', (req, res) => {
    const host = req.headers.host;
    res.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Connect>
                <Stream url="wss://${host}/twilio-media-stream" />
            </Connect>
        </Response>
    `);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

// --- Gemini Setup ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

wss.on('connection', async (ws) => {
    console.log('Twilio: Connected');
    let streamSid = null;
    let geminiWs = null;
    let conversationLog = [];

    // פונקציה לשליחת לידים (כמו שהיה לך ב-OpenAI)
    async function sendLead(text) {
        if (!MAKE_WEBHOOK_URL) return;
        try {
            fetch(MAKE_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: 'call_info',
                    bot: BOT_NAME,
                    business: BUSINESS_NAME,
                    text: text,
                    log: conversationLog
                })
            });
        } catch (e) { console.error('Webhook error'); }
    }

    const connectToGemini = () => {
        // שימוש ב-WebSocket הישיר לביצועי Realtime מקסימליים (למניעת דיליי)
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Gemini: Live Stream Opened');
            const setup = {
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    generation_config: { response_modalities: ["audio"] },
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: "Aoede" } }
                    },
                    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] }
                }
            };
            geminiWs.send(JSON.stringify(setup));
        });

        geminiWs.on('message', (data) => {
            const response = JSON.parse(data);
            
            // טיפול באודיו שחוזר
            if (response.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                const audio = response.serverContent.modelTurn.parts[0].inlineData.data;
                if (streamSid && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid,
                        media: { payload: audio }
                    }));
                }
            }

            // לוג שיחה ותמלול (בשביל הלידים)
            if (response.serverContent?.modelTurn?.parts?.[0]?.text) {
                const botText = response.serverContent.modelTurn.parts[0].text;
                conversationLog.push({ from: 'bot', text: botText });
            }
        });
    };

    connectToGemini();

    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            console.log('Twilio Started:', streamSid);
        }
        if (msg.event === 'media' && geminiWs?.readyState === WebSocket.OPEN) {
            geminiWs.send(JSON.stringify({
                realtime_input: {
                    media_chunks: [{
                        data: msg.media.payload,
                        mime_type: "audio/mulaw"
                    }]
                }
            }));
        }
    });

    ws.on('close', () => {
        console.log('Twilio Closed');
        sendLead('Call Ended'); // שליחת סיכום שיחה בניתוק
        if (geminiWs) geminiWs.close();
    });
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
