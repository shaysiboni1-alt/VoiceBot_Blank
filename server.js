require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const PORT = process.env.PORT || 1000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';

const app = express();
app.get('/', (req, res) => res.send('BluBinet Gemini Live SDK is Active'));

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

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

wss.on('connection', async (ws) => {
    console.log('Twilio: Connected');
    let streamSid = null;
    let session = null;

    const config = {
        model: 'models/gemini-2.0-flash-exp', // שימוש ב-2.0 היציב לחיבור ראשוני
        systemInstruction: { 
            parts: [{ text: `את נציגה בשם ${BOT_NAME} עבור ${BUSINESS_NAME}. עני בעברית קצרה וטבעית.` }] 
        },
        generationConfig: { 
            responseModalities: ['audio']
        }
    };

    try {
        // חיבור באמצעות ה-SDK הרשמי
        session = await genAI.getGenerativeModel({ model: config.model }).startChat();
        console.log('Gemini SDK: Chat session started');
        
        // הערה: ה-SDK של גוגל מתעדכן מהר. אם startChat לא מספיק, 
        // אנחנו נשתמש ב-live.connect כפי שמופיע בתיעוד החדש שלהם.
    } catch (err) {
        console.error('Critical Connection Error:', err);
    }

    ws.on('message', async (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log('Twilio Stream Started:', streamSid);
            }
            if (msg.event === 'media' && session) {
                // שליחת האודיו לעיבוד
                const result = await session.sendMessage([{
                    inlineData: {
                        data: msg.media.payload,
                        mimeType: 'audio/mulaw'
                    }
                }]);
                
                const responseAudio = result.response.audio(); // קבלת תגובת האודיו
                if (responseAudio && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: responseAudio.data }
                    }));
                }
            }
        } catch (e) { }
    });

    ws.on('close', () => {
        console.log('Twilio Closed');
    });
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
