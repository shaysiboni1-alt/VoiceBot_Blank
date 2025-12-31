require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// שליטה מה-ENV
const VOICE_NAME = process.env.MB_VOICE_NAME || 'Aoede'; 
const SPEECH_RATE = parseFloat(process.env.MB_VOICE_SPEECH_RATE || '1.0');
const LANGUAGES = (process.env.MB_LANGUAGES || 'he-IL').split(',');

const SYSTEM_INSTRUCTIONS = `
You are an AI assistant named ${process.env.MB_BOT_NAME || 'נטע'} for ${process.env.MB_BUSINESS_NAME || 'BluBinet'}.
You must be helpful and professional.
Language Policy: Support Hebrew, English, Russian, and Arabic. Always respond in the language the user speaks to you.
Keep responses concise (1-3 sentences).
`.trim();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

wss.on('connection', (ws) => {
    let streamSid = null;
    let geminiWs = null;

    const connectToGemini = () => {
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            const setupMessage = {
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    generation_config: { 
                        response_modalities: ["audio"],
                        speech_config: {
                            voice_config: { 
                                prebuilt_voice_config: { 
                                    voice_name: VOICE_NAME // שליטה מה-ENV
                                } 
                            },
                            // הגדרת מהירות דיבור
                            playback_rate: SPEECH_RATE 
                        }
                    },
                    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] }
                }
            };
            geminiWs.send(JSON.stringify(setupMessage));
        });

        geminiWs.on('message', (data) => {
            const response = JSON.parse(data);
            if (response.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                const audioBase64 = response.serverContent.modelTurn.parts[0].inlineData.data;
                if (streamSid) {
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: audioBase64 }
                    }));
                }
            }
            
            // זיהוי אם המודל סיים לדבר (מועיל לניהול תור)
            if (response.serverContent?.turnComplete) {
                console.log("Gemini finished speaking.");
            }
        });
    };

    connectToGemini();

    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') streamSid = msg.start.streamSid;
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
    });

    ws.on('close', () => geminiWs?.close());
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
