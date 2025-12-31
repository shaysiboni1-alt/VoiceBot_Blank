require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 1000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || process.env.MB_WEBHOOK_URL;

const SYSTEM_INSTRUCTIONS = `את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}". עני בעברית בלבד, קצר (1-2 משפטים). אל תברכי שוב.`.trim();

const app = express();
app.get('/', (req, res) => res.send('BluBinet Gemini 2.0 Raw is Active'));

app.post('/twilio-voice', (req, res) => {
    const host = req.headers.host;
    res.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response><Connect><Stream url="wss://${host}/twilio-media-stream" /></Connect></Response>
    `);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

wss.on('connection', (ws) => {
    console.log('Twilio: Connected');
    let streamSid = null;
    let geminiWs = null;

    const connectToGemini = () => {
        // הכתובת המדויקת ביותר ל-v1beta (מונע 404 ב-Paid Tier)
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Gemini: WebSocket Opened');
            // הודעת SETUP קריטית
            const setup = {
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    generation_config: { response_modalities: ["audio"] },
                    speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Aoede" } } },
                    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] }
                }
            };
            geminiWs.send(JSON.stringify(setup));
        });

        geminiWs.on('message', (data) => {
            const response = JSON.parse(data);
            if (response.setupComplete) console.log('Gemini: Setup Verified!');
            if (response.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                const audio = response.serverContent.modelTurn.parts[0].inlineData.data;
                if (streamSid && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: audio } }));
                }
            }
        });

        geminiWs.on('error', (e) => console.error('Gemini Error:', e.message));
    };

    connectToGemini();

    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') { streamSid = msg.start.streamSid; console.log('Twilio Started:', streamSid); }
        if (msg.event === 'media' && geminiWs?.readyState === WebSocket.OPEN) {
            geminiWs.send(JSON.stringify({
                realtime_input: { media_chunks: [{ data: msg.media.payload, mime_type: "audio/mulaw" }] }
            }));
        }
    });

    ws.on('close', () => {
        if (geminiWs) geminiWs.close();
        // שליחת ליד בניתוק (כמו ב-OpenAI)
        if (MAKE_WEBHOOK_URL) {
            fetch(MAKE_WEBHOOK_URL, { method: 'POST', body: JSON.stringify({ event: 'call_ended', bot: BOT_NAME }) }).catch(() => {});
        }
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
