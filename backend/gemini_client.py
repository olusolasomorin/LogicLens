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
                    "parts": [{"text": "You are a real-time math tutor. You must ALWAYS speak strictly in English. Watch the user's screen. Interrupt them politely if they make a logical or mathematical error. Do not give them the final answer, guide them to it. You can also describe how the user looks like physically"}]
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