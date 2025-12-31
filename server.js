require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// הגדרות מה-ENV
const VOICE_NAME = process.env.MB_VOICE_NAME || 'Aoede'; 
const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';

const SYSTEM_INSTRUCTIONS = `
את נציגה בשם ${BOT_NAME} עבור ${BUSINESS_NAME}.
עני בעברית בלבד בצורה קצרה (1-2 משפטים).
תמכי גם באנגלית, רוסית וערבית אם פונים אלייך בשפות אלו.
`.trim();

const app = express();
app.get('/', (req, res) => res.send('BluBinet Gemini 2.0 Live is Running'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

wss.on('connection', (ws) => {
    console.log('Twilio: Connected');
    let streamSid = null;
    let geminiWs = null;

    const connectToGemini = () => {
        // הכתובת המדויקת שעובדת עם מפתחות AI Studio בגרסה 2.0
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Gemini: Socket Opened');
            const setup = {
                setup: {
                    model: "models/gemini-2.0-flash-exp", // המודל שמופיע אצלך ב-Playground
                    generation_config: { response_modalities: ["audio"] },
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: VOICE_NAME } }
                    },
                    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] }
                }
            };
            geminiWs.send(JSON.stringify(setup));
        });

        geminiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                if (response.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                    const audioBase64 = response.serverContent.modelTurn.parts[0].inlineData.data;
                    if (streamSid && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: audioBase64 }
                        }));
                    }
                }
            } catch (err) { console.error("Error parsing Gemini message"); }
        });

        geminiWs.on('error', (err) => console.error('Gemini Error:', err.message));
    };

    connectToGemini();

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log('Twilio Stream Started:', streamSid);
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
        } catch (e) { }
    });

    ws.on('close', () => {
        console.log('Twilio Closed');
        if (geminiWs) geminiWs.close();
    });
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
