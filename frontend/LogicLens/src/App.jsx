import React, { useState, useRef, useEffect } from 'react';
import { Bot, Video, Power, Mic, MicOff, Activity, SwitchCamera } from 'lucide-react';

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false); 
  const [mediaStream, setMediaStream] = useState(null); 
  const [facingMode, setFacingMode] = useState("user"); 
  const [isMuted, setIsMuted] = useState(false); 
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const streamIntervalRef = useRef(null);
  
  // Audio Refs
  const audioContextRef = useRef(null);
  const audioWorkletNodeRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef([]); 

  useEffect(() => {
    const BACKEND_URL = 'wss://my-uvicorn-backend-982983046376.us-west1.run.app/ws/tutor';

    wsRef.current = new WebSocket(BACKEND_URL);
    
    wsRef.current.onopen = () => {
      console.log('Connected to LogicLens Backend');
      setIsConnected(true);
    };

    wsRef.current.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'audio_response') {
        playAudioChunk(message.data);
      }
    };

    wsRef.current.onclose = () => setIsConnected(false);

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  useEffect(() => {
    if (videoRef.current && mediaStream) {
      videoRef.current.srcObject = mediaStream;
    }
  }, [videoRef.current, mediaStream]);

  const stopAudioPlayback = () => {
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Ignore if already finished
      }
    });
    activeSourcesRef.current = [];
    setIsAiSpeaking(false); 
    
    if (audioContextRef.current) {
      nextPlayTimeRef.current = audioContextRef.current.currentTime;
    }
  };

  const startMedia = async (targetFacingMode = facingMode) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: targetFacingMode }, 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000 
        } 
      });
      
      // 🛠️ NEW: If the user was muted before a camera switch, keep them muted!
      if (isMuted) {
        stream.getAudioTracks()[0].enabled = false;
      }

      setMediaStream(stream); 

      const AudioContext = window.AudioContext || window.webkitAudioContext;
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      
      const workletCode = `
        class PCMProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.isSpeaking = false;
            this.silenceFrames = 0;
            this.volumeThreshold = 0.03; 
          }

          process(inputs, outputs, parameters) {
            const input = inputs[0];
            if (input && input.length > 0) {
              const float32Data = input[0];
              const pcm16Data = new Int16Array(float32Data.length);
              let maxAmplitude = 0;
              
              for (let i = 0; i < float32Data.length; i++) {
                const val = float32Data[i];
                if (Math.abs(val) > maxAmplitude) maxAmplitude = Math.abs(val);
                pcm16Data[i] = Math.max(-1, Math.min(1, val)) * 0x7FFF;
              }

              if (maxAmplitude > this.volumeThreshold) {
                if (!this.isSpeaking) {
                  this.isSpeaking = true;
                  this.port.postMessage({ event: 'speech_started' });
                }
                this.silenceFrames = 0;
              } else {
                this.silenceFrames++;
                if (this.isSpeaking && this.silenceFrames > 60) {
                  this.isSpeaking = false;
                  this.port.postMessage({ event: 'speech_stopped' });
                }
              }
              
              this.port.postMessage({ event: 'audio_data', buffer: pcm16Data.buffer }, [pcm16Data.buffer]);
            }
            return true; 
          }
        }
        registerProcessor('pcm-processor', PCMProcessor);
      `;

      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);

      await audioContextRef.current.audioWorklet.addModule(workletUrl);

      const source = audioContextRef.current.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContextRef.current, 'pcm-processor');
      audioWorkletNodeRef.current = workletNode;
      
      source.connect(workletNode);

      workletNode.port.onmessage = (event) => {
        const { data } = event;
        
        if (data.event === 'speech_started') {
          setIsUserSpeaking(true);
          stopAudioPlayback(); 
        } else if (data.event === 'speech_stopped') {
          setIsUserSpeaking(false);
        } else if (data.event === 'audio_data') {
          if (wsRef.current?.readyState !== WebSocket.OPEN) return;

          const buffer = new Uint8Array(data.buffer);
          let binary = '';
          for (let i = 0; i < buffer.byteLength; i++) {
            binary += String.fromCharCode(buffer[i]);
          }
          const base64String = btoa(binary);

          wsRef.current.send(JSON.stringify({
            type: 'audio',
            data: base64String
          }));
        }
      };

    } catch (err) {
      console.error("Error accessing media devices:", err);
    }
  };

  const toggleCamera = async () => {
    if (!mediaStream) return;
    
    const newFacingMode = facingMode === "user" ? "environment" : "user";
    setFacingMode(newFacingMode);

    try {
      clearInterval(streamIntervalRef.current);
      if (audioWorkletNodeRef.current) {
        audioWorkletNodeRef.current.disconnect();
      }
      mediaStream.getTracks().forEach(track => track.stop());
      stopAudioPlayback(); 
      setMediaStream(null);

      await new Promise(resolve => setTimeout(resolve, 200));

      await startMedia(newFacingMode);
      
      // 🛠️ RE-ADDED: The quick-draw fix to prevent AI lag!
      setTimeout(() => {
        captureAndSendFrame();
      }, 800);
      
      streamIntervalRef.current = setInterval(captureAndSendFrame, 2000);
      
    } catch (err) {
      console.error("Nuclear switch failed:", err);
      alert("Camera switch failed. Please restart the session.");
    }
  };

  // 🛠️ NEW: Safe Mute Toggle Logic
  const toggleMute = () => {
    if (mediaStream) {
      const audioTrack = mediaStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled; // Silences the track without destroying it
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const playAudioChunk = (base64Audio) => {
    if (!audioContextRef.current) return;

    const binaryString = atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const pcm16Data = new Int16Array(bytes.buffer);
    const float32Data = new Float32Array(pcm16Data.length);
    for (let i = 0; i < pcm16Data.length; i++) {
      float32Data[i] = pcm16Data[i] / 0x7FFF;
    }

    const audioBuffer = audioContextRef.current.createBuffer(1, float32Data.length, 24000);
    audioBuffer.getChannelData(0).set(float32Data);

    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current.destination);

    activeSourcesRef.current.push(source);
    setIsAiSpeaking(true); 

    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
      if (activeSourcesRef.current.length === 0) {
        setIsAiSpeaking(false); 
      }
    };

    const currentTime = audioContextRef.current.currentTime;
    if (nextPlayTimeRef.current < currentTime) {
      nextPlayTimeRef.current = currentTime; 
    }
    source.start(nextPlayTimeRef.current);
    nextPlayTimeRef.current += audioBuffer.duration;
  };

  const captureAndSendFrame = () => {
    if (!videoRef.current || !canvasRef.current || wsRef.current?.readyState !== WebSocket.OPEN) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    
    const MAX_WIDTH = 640; 
    const scale = MAX_WIDTH / videoRef.current.videoWidth;
    
    canvas.width = MAX_WIDTH;
    canvas.height = videoRef.current.videoHeight * scale;
    
    context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    
    const base64Image = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
    
    wsRef.current.send(JSON.stringify({
      type: 'video',
      data: base64Image
    }));
  };

  const toggleTutoring = () => {
    if (isStreaming) {
      clearInterval(streamIntervalRef.current);
      if (audioWorkletNodeRef.current) {
        audioWorkletNodeRef.current.disconnect();
      }
      if (mediaStream) {
         mediaStream.getTracks().forEach(track => track.stop());
      }
      stopAudioPlayback(); 
      setMediaStream(null); 
      setIsStreaming(false);
      setIsUserSpeaking(false);
      setIsAiSpeaking(false);
      setIsMuted(false); // 🛠️ NEW: Reset mute state when hanging up
    } else {
      startMedia();
      streamIntervalRef.current = setInterval(captureAndSendFrame, 2000);
      setIsStreaming(true);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col font-sans">
      {/* HEADER */}
      <header className="px-6 py-4 flex items-center justify-between bg-gray-900 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <Bot className="text-blue-500" size={28} />
          <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
            LogicLens
          </h1>
        </div>
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold ${isConnected ? 'bg-green-950/50 text-green-400 border border-green-800/50' : 'bg-red-950/50 text-red-400 border border-red-800/50'}`}>
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'} animate-pulse`} />
          {isConnected ? 'Connected' : 'Disconnected'}
        </div>
      </header>

      {/* MAIN CONTENT */}
      <main className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 w-full max-w-5xl mx-auto h-[calc(100vh-80px)]">
        
        <canvas ref={canvasRef} className="hidden" />

        {!isStreaming ? (
          /* ================= IDLE STATE ================= */
          <div className="flex flex-col items-center justify-center space-y-8 animate-in fade-in zoom-in duration-500">
            <div className="relative flex items-center justify-center w-48 h-48 rounded-full bg-blue-900/20 border border-blue-500/30 shadow-[0_0_60px_-15px_rgba(59,130,246,0.4)]">
              <Bot size={80} className="text-blue-400" />
            </div>
            
            <div className="text-center space-y-2">
              <h2 className="text-3xl font-bold text-white">Ready for your session?</h2>
              <p className="text-gray-400 max-w-md">Allow camera and microphone access to begin an interactive multimodal session with your AI tutor.</p>
            </div>

            <button 
              onClick={toggleTutoring}
              disabled={!isConnected}
              className={`flex items-center gap-3 px-8 py-4 rounded-full font-bold text-lg transition-all duration-300 shadow-lg ${
                isConnected 
                  ? 'bg-blue-600 hover:bg-blue-500 hover:shadow-blue-600/50 hover:-translate-y-1 text-white' 
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              <Video size={24} />
              Start Session
            </button>
          </div>
        ) : (
          /* ================= ACTIVE CALL (SPLIT SCREEN) ================= */
          <div className="w-full h-full flex flex-col gap-4">
            
            {/* UPPER VIEW: USER CAMERA */}
            <div className="flex-1 relative bg-gray-900 rounded-3xl overflow-hidden border border-gray-800 shadow-xl group min-h-[40%]">
              <video 
                ref={videoRef} 
                autoPlay 
                playsInline 
                muted 
                className="w-full h-full object-cover transition-transform duration-300" 
                style={{ transform: facingMode === "user" ? "scaleX(-1)" : "none" }} 
              />
              
              {/* 🛠️ NEW: Interactive Mute Button Overlay */}
              <button
                onClick={toggleMute}
                className={`absolute top-4 left-4 backdrop-blur-md px-4 py-2 rounded-xl flex items-center gap-3 border transition-all active:scale-95 shadow-lg z-10 ${
                  isMuted ? 'bg-red-900/60 border-red-700/50' : 'bg-black/60 border-gray-700/50 hover:bg-black/80'
                }`}
                title={isMuted ? "Unmute Microphone" : "Mute Microphone"}
              >
                {isMuted ? (
                  <MicOff size={18} className="text-red-400" />
                ) : isUserSpeaking ? (
                  <Activity size={18} className="text-green-400 animate-pulse" />
                ) : (
                  <Mic size={18} className="text-gray-400" />
                )}
                <span className={`text-sm font-medium ${isMuted ? 'text-red-200' : 'text-gray-200'}`}>
                  {isMuted ? 'Muted' : 'You'}
                </span>
              </button>

              <button
                onClick={toggleCamera}
                className="absolute top-4 right-4 bg-black/60 backdrop-blur-md p-3 rounded-xl text-white hover:bg-black/80 hover:text-blue-400 transition-all active:scale-95 border border-gray-700/50 shadow-lg z-10"
                title="Switch Camera"
              >
                <SwitchCamera size={22} />
              </button>
            </div>

            {/* LOWER VIEW: AI AVATAR */}
            <div className="flex-1 relative bg-gray-900 rounded-3xl overflow-hidden border border-gray-800 shadow-xl flex flex-col items-center justify-center min-h-[40%]">
              
              <div className="relative flex items-center justify-center w-36 h-36">
                {isAiSpeaking && (
                  <>
                    <div className="absolute inset-0 rounded-full bg-blue-500/20 animate-[ping_1.5s_cubic-bezier(0,0,0.2,1)_infinite]"></div>
                    <div className="absolute inset-0 rounded-full bg-purple-500/20 animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] delay-150"></div>
                  </>
                )}
                
                <div className={`relative z-10 flex items-center justify-center w-32 h-32 rounded-full border-2 transition-all duration-300 ${isAiSpeaking ? 'bg-gray-800 border-blue-400 shadow-[0_0_40px_rgba(59,130,246,0.3)]' : 'bg-gray-800/50 border-gray-700'}`}>
                   <Bot size={56} className={`transition-colors duration-300 ${isAiSpeaking ? 'text-blue-400' : 'text-gray-500'}`} />
                </div>
              </div>

              <p className={`mt-6 font-medium tracking-wide transition-opacity duration-300 ${isAiSpeaking ? 'text-blue-400' : 'text-gray-500'}`}>
                {isAiSpeaking ? 'Lora is Speaking...' : 'Lora is Listening...'}
              </p>

              <button 
                onClick={toggleTutoring}
                className="mt-8 mb-6 bg-red-600/90 hover:bg-red-500 p-4 rounded-full shadow-lg hover:shadow-red-600/50 transition-all hover:-translate-y-1 backdrop-blur-sm"
                title="End Session"
              >
                <Power size={28} className="text-white" />
              </button>

            </div>
          </div>
        )}
      </main>
    </div>
  );
}


// import React, { useState, useRef, useEffect } from 'react';
// import { Bot, Video, Power, Mic, MicOff, Activity, SwitchCamera, MessageSquare, X } from 'lucide-react';

// export default function App() {
//   const [isConnected, setIsConnected] = useState(false);
//   const [isStreaming, setIsStreaming] = useState(false);
//   const [isUserSpeaking, setIsUserSpeaking] = useState(false);
//   const [isAiSpeaking, setIsAiSpeaking] = useState(false); 
//   const [mediaStream, setMediaStream] = useState(null); 
//   const [facingMode, setFacingMode] = useState("user"); 
//   const [isMuted, setIsMuted] = useState(false); 
  
//   // Chat Transcript State
//   const [messages, setMessages] = useState([]);
//   const [showChat, setShowChat] = useState(false);
//   const messagesEndRef = useRef(null);
  
//   const videoRef = useRef(null);
//   const canvasRef = useRef(null);
//   const wsRef = useRef(null);
//   const streamIntervalRef = useRef(null);
  
//   // Speech Recognition Ref
//   const recognitionRef = useRef(null);
//   const isStreamingRef = useRef(false); 

//   // Audio Refs
//   const audioContextRef = useRef(null);
//   const audioWorkletNodeRef = useRef(null);
//   const nextPlayTimeRef = useRef(0);
//   const activeSourcesRef = useRef([]); 

//   // Auto-scroll chat to bottom
//   useEffect(() => {
//     messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
//   }, [messages]);

//   useEffect(() => {
//     isStreamingRef.current = isStreaming;
//   }, [isStreaming]);

//   useEffect(() => {
//     const BACKEND_URL = 'wss://my-uvicorn-backend-982983046376.us-west1.run.app/ws/tutor';

//     wsRef.current = new WebSocket(BACKEND_URL);
    
//     wsRef.current.onopen = () => {
//       console.log('Connected to LogicLens Backend');
//       setIsConnected(true);
//     };

//     wsRef.current.onmessage = (event) => {
//       const message = JSON.parse(event.data);
//       if (message.type === 'audio_response') {
//         playAudioChunk(message.data);
//       } 
//       else if (message.type === 'text_response') {
//         setMessages(prev => {
//           const lastMsg = prev[prev.length - 1];
//           if (lastMsg && lastMsg.role === 'ai') {
//             const newMessages = [...prev];
//             newMessages[newMessages.length - 1].text += message.data;
//             return newMessages;
//           } else {
//             return [...prev, { role: 'ai', text: message.data }];
//           }
//         });
//       }
//     };

//     wsRef.current.onclose = () => setIsConnected(false);

//     return () => {
//       if (wsRef.current) wsRef.current.close();
//     };
//   }, []);

//   useEffect(() => {
//     if (videoRef.current && mediaStream) {
//       videoRef.current.srcObject = mediaStream;
//     }
//   }, [videoRef.current, mediaStream]);

//   const stopAudioPlayback = () => {
//     activeSourcesRef.current.forEach(source => {
//       try { source.stop(); source.disconnect(); } catch (e) {}
//     });
//     activeSourcesRef.current = [];
//     setIsAiSpeaking(false); 
    
//     if (audioContextRef.current) {
//       nextPlayTimeRef.current = audioContextRef.current.currentTime;
//     }
//   };

//   // 🛠️ NEW: Bulletproof Speech Recognition setup
//   const setupSpeechRecognition = () => {
//     const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
//     if (!SpeechRecognition) return; // Ignore if browser doesn't support it

//     if (!recognitionRef.current) {
//       recognitionRef.current = new SpeechRecognition();
//       recognitionRef.current.continuous = true;
//       recognitionRef.current.interimResults = false;
      
//       recognitionRef.current.onresult = (event) => {
//         let finalTranscript = "";
//         for (let i = event.resultIndex; i < event.results.length; ++i) {
//           if (event.results[i].isFinal) {
//             finalTranscript += event.results[i][0].transcript;
//           }
//         }
//         if (finalTranscript.trim()) {
//           setMessages(prev => [...prev, { role: 'user', text: finalTranscript.trim() }]);
//         }
//       };
      
//       // Auto-restart if it drops, but ONLY if we are still actively in a session
//       recognitionRef.current.onend = () => {
//         if (isStreamingRef.current) {
//           try { recognitionRef.current.start(); } catch(e){}
//         }
//       };
//     }

//     try {
//       recognitionRef.current.start();
//     } catch (e) {
//       // It's already running, safely ignore
//     }
//   };

//   const startMedia = async (targetFacingMode = facingMode) => {
//     try {
//       const stream = await navigator.mediaDevices.getUserMedia({ 
//         video: { facingMode: targetFacingMode }, 
//         audio: {
//           echoCancellation: true,
//           noiseSuppression: true,
//           sampleRate: 16000 
//         } 
//       });
      
//       if (isMuted) {
//         stream.getAudioTracks()[0].enabled = false;
//       }

//       setMediaStream(stream); 

//       // Initialize the new robust speech recognition
//       setupSpeechRecognition();

//       const AudioContext = window.AudioContext || window.webkitAudioContext;
//       audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      
//       const workletCode = `
//         class PCMProcessor extends AudioWorkletProcessor {
//           constructor() {
//             super();
//             this.isSpeaking = false;
//             this.silenceFrames = 0;
//             this.volumeThreshold = 0.03; 
//           }

//           process(inputs, outputs, parameters) {
//             const input = inputs[0];
//             if (input && input.length > 0) {
//               const float32Data = input[0];
//               const pcm16Data = new Int16Array(float32Data.length);
//               let maxAmplitude = 0;
              
//               for (let i = 0; i < float32Data.length; i++) {
//                 const val = float32Data[i];
//                 if (Math.abs(val) > maxAmplitude) maxAmplitude = Math.abs(val);
//                 pcm16Data[i] = Math.max(-1, Math.min(1, val)) * 0x7FFF;
//               }

//               if (maxAmplitude > this.volumeThreshold) {
//                 if (!this.isSpeaking) {
//                   this.isSpeaking = true;
//                   this.port.postMessage({ event: 'speech_started' });
//                 }
//                 this.silenceFrames = 0;
//               } else {
//                 this.silenceFrames++;
//                 if (this.isSpeaking && this.silenceFrames > 60) {
//                   this.isSpeaking = false;
//                   this.port.postMessage({ event: 'speech_stopped' });
//                 }
//               }
              
//               this.port.postMessage({ event: 'audio_data', buffer: pcm16Data.buffer }, [pcm16Data.buffer]);
//             }
//             return true; 
//           }
//         }
//         registerProcessor('pcm-processor', PCMProcessor);
//       `;

//       const blob = new Blob([workletCode], { type: 'application/javascript' });
//       const workletUrl = URL.createObjectURL(blob);

//       await audioContextRef.current.audioWorklet.addModule(workletUrl);

//       const source = audioContextRef.current.createMediaStreamSource(stream);
//       const workletNode = new AudioWorkletNode(audioContextRef.current, 'pcm-processor');
//       audioWorkletNodeRef.current = workletNode;
      
//       source.connect(workletNode);

//       workletNode.port.onmessage = (event) => {
//         const { data } = event;
//         if (data.event === 'speech_started') {
//           setIsUserSpeaking(true);
//           stopAudioPlayback(); 
//         } else if (data.event === 'speech_stopped') {
//           setIsUserSpeaking(false);
//         } else if (data.event === 'audio_data') {
//           if (wsRef.current?.readyState !== WebSocket.OPEN) return;

//           const buffer = new Uint8Array(data.buffer);
//           let binary = '';
//           for (let i = 0; i < buffer.byteLength; i++) {
//             binary += String.fromCharCode(buffer[i]);
//           }
//           const base64String = btoa(binary);

//           wsRef.current.send(JSON.stringify({ type: 'audio', data: base64String }));
//         }
//       };

//     } catch (err) {
//       console.error("Error accessing media devices:", err);
//     }
//   };

//   const toggleCamera = async () => {
//     if (!mediaStream) return;
//     const newFacingMode = facingMode === "user" ? "environment" : "user";
//     setFacingMode(newFacingMode);

//     try {
//       clearInterval(streamIntervalRef.current);
//       if (audioWorkletNodeRef.current) audioWorkletNodeRef.current.disconnect();
//       mediaStream.getTracks().forEach(track => track.stop());
      
//       // Notice we DO NOT stop recognitionRef here anymore! It stays alive to hear you while the camera flips.

//       stopAudioPlayback(); 
//       setMediaStream(null);

//       await new Promise(resolve => setTimeout(resolve, 200));
//       await startMedia(newFacingMode);
      
//       setTimeout(() => { captureAndSendFrame(); }, 800);
//       streamIntervalRef.current = setInterval(captureAndSendFrame, 2000);
      
//     } catch (err) {
//       console.error("Nuclear switch failed:", err);
//     }
//   };

//   const toggleMute = () => {
//     if (mediaStream) {
//       const audioTrack = mediaStream.getAudioTracks()[0];
//       if (audioTrack) {
//         audioTrack.enabled = !audioTrack.enabled; 
//         setIsMuted(!audioTrack.enabled);
//       }
//     }
//   };

//   const playAudioChunk = (base64Audio) => {
//     if (!audioContextRef.current) return;

//     const binaryString = atob(base64Audio);
//     const len = binaryString.length;
//     const bytes = new Uint8Array(len);
//     for (let i = 0; i < len; i++) {
//       bytes[i] = binaryString.charCodeAt(i);
//     }

//     const pcm16Data = new Int16Array(bytes.buffer);
//     const float32Data = new Float32Array(pcm16Data.length);
//     for (let i = 0; i < pcm16Data.length; i++) {
//       float32Data[i] = pcm16Data[i] / 0x7FFF;
//     }

//     const audioBuffer = audioContextRef.current.createBuffer(1, float32Data.length, 24000);
//     audioBuffer.getChannelData(0).set(float32Data);

//     const source = audioContextRef.current.createBufferSource();
//     source.buffer = audioBuffer;
//     source.connect(audioContextRef.current.destination);

//     activeSourcesRef.current.push(source);
//     setIsAiSpeaking(true); 

//     source.onended = () => {
//       activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
//       if (activeSourcesRef.current.length === 0) {
//         setIsAiSpeaking(false); 
//       }
//     };

//     const currentTime = audioContextRef.current.currentTime;
//     if (nextPlayTimeRef.current < currentTime) {
//       nextPlayTimeRef.current = currentTime; 
//     }
//     source.start(nextPlayTimeRef.current);
//     nextPlayTimeRef.current += audioBuffer.duration;
//   };

//   const captureAndSendFrame = () => {
//     if (!videoRef.current || !canvasRef.current || wsRef.current?.readyState !== WebSocket.OPEN) return;

//     const canvas = canvasRef.current;
//     const context = canvas.getContext('2d');
    
//     const MAX_WIDTH = 640; 
//     const scale = MAX_WIDTH / videoRef.current.videoWidth;
//     canvas.width = MAX_WIDTH;
//     canvas.height = videoRef.current.videoHeight * scale;
    
//     context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
//     const base64Image = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
    
//     wsRef.current.send(JSON.stringify({ type: 'video', data: base64Image }));
//   };

//   const toggleTutoring = () => {
//     if (isStreaming) {
//       clearInterval(streamIntervalRef.current);
//       if (audioWorkletNodeRef.current) audioWorkletNodeRef.current.disconnect();
//       if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
      
//       // Stop listening when we hang up
//       if (recognitionRef.current) {
//         recognitionRef.current.stop();
//       }

//       stopAudioPlayback(); 
//       setMediaStream(null); 
//       setIsStreaming(false);
//       setIsUserSpeaking(false);
//       setIsAiSpeaking(false);
//       setIsMuted(false); 
//       setShowChat(false); 
//     } else {
//       setMessages([]); 
//       startMedia();
//       streamIntervalRef.current = setInterval(captureAndSendFrame, 2000);
//       setIsStreaming(true);
//     }
//   };

//   return (
//     <div className="min-h-screen bg-gray-950 text-white flex flex-col font-sans">
//       <header className="px-6 py-4 flex items-center justify-between bg-gray-900 border-b border-gray-800">
//         <div className="flex items-center gap-3">
//           <Bot className="text-blue-500" size={28} />
//           <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
//             LogicLens
//           </h1>
//         </div>
//         <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold ${isConnected ? 'bg-green-950/50 text-green-400 border border-green-800/50' : 'bg-red-950/50 text-red-400 border border-red-800/50'}`}>
//           <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'} animate-pulse`} />
//           {isConnected ? 'Connected' : 'Disconnected'}
//         </div>
//       </header>

//       <main className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 w-full max-w-5xl mx-auto h-[calc(100vh-80px)] relative">
//         <canvas ref={canvasRef} className="hidden" />

//         {!isStreaming ? (
//           <div className="flex flex-col items-center justify-center space-y-8 animate-in fade-in zoom-in duration-500">
//             <div className="relative flex items-center justify-center w-48 h-48 rounded-full bg-blue-900/20 border border-blue-500/30 shadow-[0_0_60px_-15px_rgba(59,130,246,0.4)]">
//               <Bot size={80} className="text-blue-400" />
//             </div>
//             <div className="text-center space-y-2">
//               <h2 className="text-3xl font-bold text-white">Ready for your session?</h2>
//               <p className="text-gray-400 max-w-md">Allow camera and microphone access to begin an interactive multimodal session with your AI tutor.</p>
//             </div>
//             <button 
//               onClick={toggleTutoring}
//               disabled={!isConnected}
//               className={`flex items-center gap-3 px-8 py-4 rounded-full font-bold text-lg transition-all duration-300 shadow-lg ${
//                 isConnected ? 'bg-blue-600 hover:bg-blue-500 hover:-translate-y-1 text-white' : 'bg-gray-800 text-gray-500 cursor-not-allowed'
//               }`}
//             >
//               <Video size={24} /> Start Session
//             </button>
//           </div>
//         ) : (
//           <div className="w-full h-full flex flex-col gap-4 relative">
            
//             <button
//               onClick={() => setShowChat(!showChat)}
//               className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-blue-600/90 hover:bg-blue-500 backdrop-blur-md px-5 py-2.5 rounded-full text-white flex items-center gap-2 shadow-lg transition-all active:scale-95 border border-blue-400/50"
//             >
//               <MessageSquare size={18} />
//               <span className="text-sm font-bold tracking-wide">Transcript</span>
//             </button>

//             {showChat && (
//               <div className="absolute inset-0 z-50 bg-gray-950/95 backdrop-blur-xl flex flex-col rounded-3xl overflow-hidden border border-gray-800 animate-in fade-in zoom-in-95 duration-200">
//                 <div className="flex justify-between items-center p-4 border-b border-gray-800 bg-gray-900/50">
//                   <h3 className="font-bold flex items-center gap-2 text-gray-200">
//                     <MessageSquare size={18} className="text-blue-400" /> Session Transcript
//                   </h3>
//                   <button onClick={() => setShowChat(false)} className="p-2 bg-gray-800 hover:bg-gray-700 rounded-full text-gray-400 hover:text-white transition-colors">
//                     <X size={18} />
//                   </button>
//                 </div>
                
//                 {/* 🛠️ UPDATED: Added w-full and space-y-6 to force perfect alignment */}
//                 <div className="flex-1 overflow-y-auto p-4 space-y-6">
//                   {messages.length === 0 ? (
//                     <p className="text-center text-gray-500 mt-10 italic">Start speaking to see the transcript...</p>
//                   ) : (
//                     messages.map((msg, idx) => (
//                       <div key={idx} className={`w-full flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
//                         <span className={`text-xs font-semibold mb-1 px-1 ${msg.role === 'user' ? 'text-gray-400' : 'text-blue-400'}`}>
//                           {msg.role === 'user' ? 'You' : 'Nova'}
//                         </span>
//                         <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
//                           msg.role === 'user' 
//                             ? 'bg-gray-700 text-gray-100 rounded-tr-none shadow-md' 
//                             : 'bg-blue-900/30 border border-blue-800/50 text-blue-50 rounded-tl-none shadow-md'
//                         }`}>
//                           {msg.text}
//                         </div>
//                       </div>
//                     ))
//                   )}
//                   <div ref={messagesEndRef} />
//                 </div>
//               </div>
//             )}

//             <div className="flex-1 relative bg-gray-900 rounded-3xl overflow-hidden border border-gray-800 shadow-xl group min-h-[40%]">
//               <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover transition-transform duration-300" style={{ transform: facingMode === "user" ? "scaleX(-1)" : "none" }} />
              
//               <button onClick={toggleMute} className={`absolute top-4 left-4 backdrop-blur-md px-4 py-2 rounded-xl flex items-center gap-3 border transition-all active:scale-95 shadow-lg z-10 ${isMuted ? 'bg-red-900/60 border-red-700/50' : 'bg-black/60 border-gray-700/50 hover:bg-black/80'}`}>
//                 {isMuted ? <MicOff size={18} className="text-red-400" /> : isUserSpeaking ? <Activity size={18} className="text-green-400 animate-pulse" /> : <Mic size={18} className="text-gray-400" />}
//                 <span className={`text-sm font-medium ${isMuted ? 'text-red-200' : 'text-gray-200'}`}>{isMuted ? 'Muted' : 'You'}</span>
//               </button>

//               <button onClick={toggleCamera} className="absolute top-4 right-4 bg-black/60 backdrop-blur-md p-3 rounded-xl text-white hover:bg-black/80 hover:text-blue-400 transition-all active:scale-95 border border-gray-700/50 shadow-lg z-10">
//                 <SwitchCamera size={22} />
//               </button>
//             </div>

//             <div className="flex-1 relative bg-gray-900 rounded-3xl overflow-hidden border border-gray-800 shadow-xl flex flex-col items-center justify-center min-h-[40%]">
//               <div className="relative flex items-center justify-center w-36 h-36">
//                 {isAiSpeaking && (
//                   <>
//                     <div className="absolute inset-0 rounded-full bg-blue-500/20 animate-[ping_1.5s_cubic-bezier(0,0,0.2,1)_infinite]"></div>
//                     <div className="absolute inset-0 rounded-full bg-purple-500/20 animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] delay-150"></div>
//                   </>
//                 )}
//                 <div className={`relative z-10 flex items-center justify-center w-32 h-32 rounded-full border-2 transition-all duration-300 ${isAiSpeaking ? 'bg-gray-800 border-blue-400 shadow-[0_0_40px_rgba(59,130,246,0.3)]' : 'bg-gray-800/50 border-gray-700'}`}>
//                    <Bot size={56} className={`transition-colors duration-300 ${isAiSpeaking ? 'text-blue-400' : 'text-gray-500'}`} />
//                 </div>
//               </div>
//               <p className={`mt-6 font-medium tracking-wide transition-opacity duration-300 ${isAiSpeaking ? 'text-blue-400' : 'text-gray-500'}`}>
//                 {isAiSpeaking ? 'Lora is speaking...' : 'Listening...'}
//               </p>
//               <button onClick={toggleTutoring} className="mt-8 mb-6 bg-red-600/90 hover:bg-red-500 p-4 rounded-full shadow-lg hover:shadow-red-600/50 transition-all hover:-translate-y-1 backdrop-blur-sm">
//                 <Power size={28} className="text-white" />
//               </button>
//             </div>
//           </div>
//         )}
//       </main>
//     </div>
//   );
// }