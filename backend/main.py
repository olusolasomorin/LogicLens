from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from gemini_client import GeminiLiveSession
import asyncio
import json
import uvicorn
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {"status": "LogicLens Backend is live!"}

@app.websocket("/ws/tutor")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    gemini_session = GeminiLiveSession()
    await gemini_session.connect()

    async def receive_from_client():
        try:
            while True:
                data = await websocket.receive_text()
                
                # Safely parse JSON
                try:
                    message = json.loads(data)
                except json.JSONDecodeError:
                    print("Received invalid JSON from client")
                    continue

                if message.get("type") == "audio":
                    await gemini_session.send_audio(message["data"])
                elif message.get("type") == "video":
                    await gemini_session.send_video(message["data"])
                    
        except WebSocketDisconnect:
            print("Client disconnected normally.")
        except Exception as e:
            print(f"Error receiving from client: {e}")

    # async def send_to_client():
    #     try:
    #         async for audio_chunk in gemini_session.receive_audio_stream():
    #             await websocket.send_text(json.dumps({
    #                 "type": "audio_response",  
    #                 "data": audio_chunk 
    #             }))
    #     except Exception as e:
    #         print(f"Error sending to client: {e}")

    async def send_to_client():
        try:
            async for chunk in gemini_session.receive_audio_stream():
                # 🛠️ UPDATED: Route text and audio to the frontend separately
                if isinstance(chunk, dict) and chunk.get("type") == "text":
                    await websocket.send_text(json.dumps({
                        "type": "text_response",
                        "data": chunk["data"]
                    }))
                else:
                    await websocket.send_text(json.dumps({
                        "type": "audio_response",  
                        "data": chunk.get("data") if isinstance(chunk, dict) else chunk
                    }))
        except Exception as e:
            print(f"Error sending to client: {e}")

    # Use Tasks so we can control their lifecycle
    receive_task = asyncio.create_task(receive_from_client())
    send_task = asyncio.create_task(send_to_client())

    try:
        # Wait for either the receive loop or send loop to stop/crash
        done, pending = await asyncio.wait(
            [receive_task, send_task],
            return_when=asyncio.FIRST_COMPLETED
        )
        
        # Cancel whatever task is still running (e.g., stop sending if client disconnected)
        for task in pending:
            task.cancel()
            
    finally:
        # Guarantee that the Gemini session closes no matter how the loops exited
        print("Cleaning up Gemini session...")
        await gemini_session.close()


if __name__ == "__main__":
    # FIXED: passed host and port as keyword arguments
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)