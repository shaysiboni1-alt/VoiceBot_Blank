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
app.get('/', (req, res) => res.send('BluBinet Gemini Live is Active'));

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

// אתחול ה-SDK
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

wss.on('connection', async (ws) => {
    console.log('Twilio: Connected');
    let streamSid = null;
    let liveSession = null;

    // הגדרות המודל - שימוש בשם המדויק למניעת 404
    const config = {
        model: 'models/gemini-2.0-flash-exp', // שם המודל הנתמך ב-SDK v0.21.0
        systemInstruction: { 
            parts: [{ text: `את נציגה בשם ${BOT_NAME} עבור ${BUSINESS_NAME}. עני בעברית קצרה.` }] 
        },
        generationConfig: { 
            responseModalities: ['audio'] 
        },
        speechConfig: {
            voiceConfig: { 
                prebuiltVoiceConfig: { voiceName: 'Aoede' } 
            }
        }
    };

    try {
        // התחברות ל-Live API באמצעות המתודה הרשמית
        // שים לב: בגרסה v0.21.0, המתודה live.connect היא הנכונה ביותר
        liveSession = await genAI.live.connect(config);
        
        console.log('Gemini Live SDK: Connection Established');

        // טיפול בהודעות שחוזרות מג'מיני
        liveSession.on('message', (message) => {
            if (message.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                const audioData = message.serverContent.modelTurn.parts[0].inlineData.data;
                if (streamSid && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: audioData }
                    }));
                }
            }
        });

    } catch (err) {
        console.error('Critical Connection Error:', err.message);
    }

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log('Twilio Stream Started:', streamSid);
            }
            if (msg.event === 'media' && liveSession) {
                // שליחת אודיו מטוויליו לג'מיני
                liveSession.send({
                    realtimeInput: {
                        mediaChunks: [{
                            data: msg.media.payload,
                            mimeType: 'audio/mulaw'
                        }]
                    }
                });
            }
        } catch (e) { }
    });

    ws.on('close', () => {
        if (liveSession) liveSession.close();
        console.log('Twilio Connection Closed');
    });
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
