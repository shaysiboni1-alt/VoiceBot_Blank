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
Language Policy: Support Hebrew, English, Russian, and Arabic. Always respond in the language the user speaks to you.
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
        // תיקון ה-URL לפורמט ה-Live API המעודכן
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Gemini: Connection established');
            
            // הודעת SETUP מתוקנת
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
                    },
                    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] }
                }
            };
            geminiWs.send(JSON.stringify(setupMessage));
        });

        geminiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                // הזרמת אודיו חזרה לטוויליו
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
                
                if (response.serverContent?.turnComplete) {
                    console.log("Gemini finished speaking.");
                }
            } catch (err) {
                console.error("Error processing Gemini message:", err);
            }
        });

        geminiWs.on('error', (error) => {
            console.error('Gemini WebSocket Error:', error.message);
        });

        geminiWs.on('close', (code, reason) => {
            console.log(`Gemini: Closed (Code: ${code}, Reason: ${reason})`);
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
                // הזרמת האודיו מטוויליו ל-Gemini
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
