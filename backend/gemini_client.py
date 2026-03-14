import os 
import websockets
import json
from dotenv import load_dotenv

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
# The specific wss endpoint for the Live API
HOST = "generativelanguage.googleapis.com"
MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025"
WS_URL = f"wss://{HOST}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={GEMINI_API_KEY}"

class GeminiLiveSession:
    def __init__(self):
        self.ws = None

    async def connect(self):
        self.ws = await websockets.connect(WS_URL, open_timeout=30)

        # Send the initial setup message (System Prompt defining the Tutor)
        setup_message = {
            "setup": {
                "model": MODEL,
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {
                        "voiceConfig": {
                            "prebuiltVoiceConfig": {
                                "voiceName": "Aoede" # Options: Puck, Charon, Kore, Fenrir, Aoede
                            }
                        }
                    }
                },
                "systemInstruction": {
                    "parts": [{"text": """You are a highly capable, real-time multimodal AI assistant. You have access to a live video feed and audio stream of the user. Your goal is to be exceptionally helpful, conversational, and intelligent across any topic they ask about—whether it is coding, history, math, science, or casual conversation. 
                    CORE BEHAVIORS:
                    1. CONVERSATIONAL PACING: You are speaking aloud. Keep your responses concise, natural, and conversational. Do not output long, paragraph-heavy monologues. Avoid using markdown, bullet points, or special formatting that sounds unnatural when spoken. 
                    2. VISUAL AWARENESS: Actively watch the user's video feed. Use visual context to inform your answers. If the user holds up an object, references something on their screen, or points to something, seamlessly incorporate that into your response.
                    3. DEMOGRAPHIC & EMOTIONAL ADAPTATION: Observe the user's physical appearance, perceived gender, facial expressions, and body language to personalize the interaction. If you perceive the user to be male or female, or if they look frustrated, happy, or confused, subtly adapt your tone, vocabulary, and examples to fit them perfectly. Use this visual information naturally; do not awkwardly announce what you see unless asked.
                    4. INTERRUPTION HANDLING: The user can interrupt you at any time. If they start speaking while you are talking, immediately yield the floor, listen to their new input, and pivot the conversation smoothly.
                    5. GENERAL INTELLIGENCE: When asked factual or complex questions, break the answers down simply and logically. If you do not know something, admit it gracefully. Always end your turns by naturally passing the conversation back to the user."""}]
                }
            }
        }
        await self.ws.send(json.dumps(setup_message))

        #  Wait for the setup response
        setup_response = await self.ws.recv()
        print("Gemini Live Session Initialized:", setup_response)

    async def send_audio(self, base64_audio):
        # Format the audio chunk for the live API
        msg = {
            "realtimeInput": {
                "mediaChunks": [{
                    "mimeType": "audio/pcm;rate=16000",
                    "data": base64_audio
                }]
            }
        }
        
        await self.ws.send(json.dumps(msg))

    async def send_video(self, base64_image):
        # Format the video frame for the Live API
        msg = {
            "realtimeInput": {
                "mediaChunks": [{
                    "mimeType": "image/jpeg",
                    "data": base64_image
                }]
            }
        }
        await self.ws.send(json.dumps(msg))


    async def receive_audio_stream(self):
        try:
            while True:
                response = await self.ws.recv()
                data = json.loads(response)

                # Tripwire: Print what Gemini is sending us!
                print("Received data from Gemini. Keys:", data.keys())

                # Extract the audio chunks from the server content
                if "serverContent" in data and "modelTurn" in data["serverContent"]:
                    parts = data["serverContent"]["modelTurn"]["parts"]
                    for part in parts:
                        if "inlineData" in part:
                            yield part["inlineData"]["data"]  # Yield the base64 audio to send to the frontend

        except websockets.exceptions.ConnectionClosed:
            print("WebSocket connection closed.")

    async def close(self):
        if self.ws:
            await self.ws.close()