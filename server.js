require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// הגדרות שליטה מה-ENV
const VOICE_NAME = process.env.MB_VOICE_NAME || 'Aoede'; 
const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';

const SYSTEM_INSTRUCTIONS = `
You are an AI assistant named ${BOT_NAME} for ${BUSINESS_NAME}.
You must be helpful and professional.
Respond in the language the user speaks to you (Hebrew, English, Russian, or Arabic).
Keep responses concise (1-3 sentences).
`.trim();

const app = express();
app.get('/', (req, res) => res.send('BluBinet Gemini Bot is Online'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

wss.on('connection', (ws) => {
    console.log('Twilio: Connected');
    let streamSid = null;
    let geminiWs = null;

    const connectToGemini = () => {
        // כתובת URL מעודכנת ופשוטה יותר עבור ה-Live API
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Gemini: Connection established');
            
            const setupMessage = {
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    generation_config: { 
                        response_modalities: ["audio"]
                    },
                    speech_config: {
                        voice_config: { 
                            prebuilt_voice_config: { 
                                voice_name: VOICE_NAME 
                            } 
                        }
                    }
                }
            };
            
            // שליחת ה-Setup
            geminiWs.send(JSON.stringify(setupMessage));

            // שליחת הוראות המערכת כהודעה ראשונה (או בתוך ה-Setup אם השרת תומך)
            const firstMessage = {
                client_content: {
                    turns: [{
                        role: "user",
                        parts: [{ text: SYSTEM_INSTRUCTIONS }]
                    }],
                    turn_complete: true
                }
            };
            geminiWs.send(JSON.stringify(firstMessage));
        });

        geminiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                // טיפול באודיו שחוזר מ-Gemini
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
            } catch (err) {
                console.error("Error processing Gemini message:", err);
            }
        });

        geminiWs.on('error', (error) => {
            console.error('Gemini WebSocket Error:', error.message);
        });

        geminiWs.on('close', (code, reason) => {
            console.log(`Gemini: Closed (Code: ${code})`);
        });
    };

    connectToGemini();

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log('Twilio: Stream started', streamSid);
            }
            
            if (msg.event === 'media' && geminiWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                    realtime_input: {
                        media_chunks: [{
                            data: msg.media.payload,
                            mime_type: "audio/mulaw"
                        }]
                    }
                };
                geminiWs.send(JSON.stringify(audioMessage));
            }
        } catch (err) {
            console.error("Error processing Twilio message:", err);
        }
    });

    ws.on('close', () => {
        console.log('Twilio: Connection closed');
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
