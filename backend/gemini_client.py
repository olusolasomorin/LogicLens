import os 
import websockets
import json
import math # 🛠️ NEW: Imported for the Python calculator tool
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

        # Send the initial setup message
        setup_message = {
            "setup": {
                "model": MODEL,
                # 🛠️ NEW: Tool Declaration telling Gemini it has a calculator
                "tools": [{
                    "functionDeclarations": [{
                        "name": "python_calculator",
                        "description": "Evaluates mathematical expressions using Python. Use this for ANY math calculation to ensure accuracy. Input should be a valid Python mathematical expression.",
                        "parameters": {
                            "type": "OBJECT",
                            "properties": {
                                "expression": {
                                    "type": "STRING",
                                    "description": "The math expression to evaluate, e.g., 'math.sqrt(8464)' or '25 * 43'."
                                }
                            },
                            "required": ["expression"]
                        }
                    }]
                }],
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
                # 🛠️ UPDATED: The new "Nova" Socratic Tutor prompt
                "systemInstruction": {
                    "parts": [{"text": """Your name is Lora. You are a highly capable, friendly, and patient multimodal AI mathematics tutor. You have access to a live video feed and audio stream of the student. Your goal is to help students solve any math problem by explaining it clearly, step-by-step, so they truly build their logical skills and understand the core concepts.
                    CORE BEHAVIORS:
                    1. PERSONA & TONE: You are warm, encouraging, and conversational. Treat the user like a capable student. Speak naturally, as if you are a human teacher sitting right across the desk from them.
                    2. MATH EXPLANATIONS: NEVER just give the final answer immediately. Guide the student through the problem logically. Break complex equations down into bite-sized pieces. Ask guiding questions like 'What do you think our first step should be?' to check their understanding.
                    3. VISUAL AWARENESS: Actively watch the video feed. If the student holds up a piece of paper with a math problem, points to an equation on their screen, or writes on a whiteboard, read the equation aloud to confirm you see it correctly, and use that visual context to solve the problem together.
                    4. EMOTIONAL ADAPTATION: Observe the student's facial expressions and body language. If they look confused, furrow their brow, or sound frustrated, gently pause and offer to explain the current step in a different, simpler way. If they smile or get it right, offer enthusiastic encouragement.
                    5. STRICTLY ENGLISH: You must listen, speak, and communicate entirely in English. If the student speaks another language, politely and warmly remind them that you are an English-speaking math tutor.
                    6. CONVERSATIONAL PACING: Keep your responses concise and formatted for speech. Do not use markdown, bullet points, or complex formatting that sounds robotic when spoken aloud. If the student interrupts you, stop speaking immediately, listen to their new question, and pivot smoothly."""}]
                }
            }
        }
        await self.ws.send(json.dumps(setup_message))

        #  Wait for the setup response
        setup_response = await self.ws.recv()
        print("Gemini Live Session Initialized:", setup_response)

    # 🛠️ NEW: Method to execute Python math and send it back to Gemini
    async def handle_tool_call(self, tool_call):
        responses = []
        for call in tool_call.get("functionCalls", []):
            name = call.get("name")
            call_id = call.get("id")
            args = call.get("args", {})

            if name == "python_calculator":
                expression = args.get("expression", "")
                print(f"\n🧠 Gemini is using the calculator for: {expression}")
                try:
                    # Safely evaluate the math expression using Python
                    result = eval(expression, {"__builtins__": None, "math": math})
                    output = str(result)
                    print(f"✅ Calculator Result: {output}\n")
                except Exception as e:
                    output = f"Error evaluating expression: {e}"
                    print(f"❌ Calculator Error: {output}\n")

                responses.append({
                    "id": call_id,
                    "response": {
                        "result": output
                    }
                })

        # Send the calculated answer back to Gemini so she can speak it out loud
        if responses:
            msg = {
                "toolResponse": {
                    "functionResponses": responses
                }
            }
            await self.ws.send(json.dumps(msg))


    async def send_audio(self, base64_audio):
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

                # 🛠️ NEW: Intercept tool calls before checking for audio!
                if "toolCall" in data:
                    await self.handle_tool_call(data["toolCall"])
                    continue # Tool calls do not contain audio chunks, so skip the rest of the loop

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