"use client"
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import ParticipantLayout from '@/components/layouts/ParticipantLayout';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress'; 
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, CheckCircle, Loader2, Mic, Volume2, Ear, Send, HelpCircle, PlayCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { Question as PrismaQuestion, PreGeneratedAudio, Questionnaire as PrismaQuestionnaire } from '@prisma/client'; // Prisma types
import { apiClient } from '@/lib/apiClient';
import Link from 'next/link';

// Type for question data coming from API (includes preGeneratedAudios)
type QuestionWithAudio = PrismaQuestion & {
    preGeneratedAudios: Pick<PreGeneratedAudio, 'audioPath' | 'languageCode'>[];
};
type FullQuestionnaire = PrismaQuestionnaire & {
    questions: QuestionWithAudio[];
};


// Constants for VAD (same as before)
const ENERGY_THRESHOLD = 10;
const SILENCE_DURATION_MS = 1300;
const VOICE_ACTIVITY_CHECK_INTERVAL_MS = 100;
const REQUIRED_CONSECUTIVE_SPEECH_INTERVALS = 3;

// App States for this page
type AudioPageState =
 | 'loading' // Initial loading of questionnaire
 | 'readyToStart' // Questionnaire loaded, user can start
 | 'startingAttempt' // Creating attempt record
 | 'presentingQuestion' // About to play question audio
 | 'playingAudio'
 | 'listening'
 | 'stoppingRecording'
 | 'transcribing' // Waiting for STT from FastAPI
 | 'awaitingConfirmation'
 | 'savingAnswer' // Saving answer to Next.js DB
 | 'complete'
 | 'error';

export default function AudioQuestionnairePage() {
  const router = useRouter();
  const params = useParams();
const questionnaireId = params?.id; 

  const [pageState, setPageState] = useState<AudioPageState>('loading');
  const [waveformValues, setWaveformValues] = useState<number[]>([0, 0, 0, 0, 0,0,0,0,0,0,0]);
  const [questionnaire, setQuestionnaire] = useState<FullQuestionnaire | null>(null);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState<number>(-1);
  const [currentQuestion, setCurrentQuestion] = useState<QuestionWithAudio | null>(null);
  
  const [attemptId, setAttemptId] = useState<string | null>(null);
  
  const [transcribedText, setTranscribedText] = useState<string>('');
  const [parsedValue, setParsedValue] = useState<any | null>(null);
  const [isValueFound, setIsValueFound] = useState<boolean>(false);
  
  const [feedbackMessage, setFeedbackMessage] = useState<string>('');
  const [currentProgress, setCurrentProgress] = useState(0);

  // Refs for audio and VAD (same as before)
  const audioPlayerRef = useRef<HTMLAudioElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silenceAfterSpeechTimerRef = useRef<NodeJS.Timeout | null>(null);
  const activityCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const hasSpeechSustainedRef = useRef<boolean>(false);
  const consecutiveSpeechIntervalsCountRef = useRef<number>(0);
  const consecutiveSilenceIntervalsCountRef = useRef<number>(0);

  const showFeedback = (message: string, type: 'info' | 'error' | 'success' = 'info') => {
     console.log(`AUDIO_PAGE_FEEDBACK (${type}): ${message}`);
     setFeedbackMessage(message);
     if (type === 'error') toast.error(message);
     else if (type === 'success') toast.success(message);
     // else toast.message(message); // Or use sonner's default
  };
  
  // --- Audio Recording Logic ---
      const startRecording = async () => {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              console.warn("startRecording called while already recording.");
              return;
          }
          showFeedback('Attempting to access microphone...');
          try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              mediaStreamRef.current = stream; // Store the stream
  
              // --- Initialize Web Audio API for VAD ---
              if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
                audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
              }
              analyserRef.current = audioContextRef.current.createAnalyser();
              analyserRef.current.fftSize = 2048; // Standard FFT size
              analyserRef.current.smoothingTimeConstant = 0.5; // Adjust for responsiveness
  
              sourceNodeRef.current = audioContextRef.current.createMediaStreamSource(stream);
              sourceNodeRef.current.connect(analyserRef.current);
              // Note: Do NOT connect analyserRef.current to audioContextRef.current.destination
              // if you don't want to hear the microphone input through speakers (feedback loop).
  
              const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
  
              const mimeTypesToTry = [
                  'audio/webm;codecs=opus',
                  'audio/ogg;codecs=opus',
                  'audio/wav', // Some browsers might support this directly
                  // 'audio/mp4', // Less common for raw mic input
              ];
              let chosenMimeType = '';
              for (const mimeType of mimeTypesToTry) {
                  if (MediaRecorder.isTypeSupported(mimeType)) {
                      chosenMimeType = mimeType;
                      break;
                  }
              }
  
              const recorderOptions = chosenMimeType ? { mimeType: chosenMimeType } : {};
              if (chosenMimeType) console.log(`Using mimeType: ${chosenMimeType} for MediaRecorder.`);
              else console.log("Using browser default mimeType for MediaRecorder.");
  
              mediaRecorderRef.current = new MediaRecorder(stream, recorderOptions);
              audioChunksRef.current = []; // Reset chunks
  
              mediaRecorderRef.current.ondataavailable = (event) => {
                  if (event.data.size > 0) {
                      audioChunksRef.current.push(event.data);
                      console.log(`Audio data available, chunk size: ${event.data.size}, type: ${event.data.type}`);
                  } else {
                      console.log("Ondataavailable: chunk size is 0.");
                  }
              };
  
              mediaRecorderRef.current.onstop = async () => {
                  console.log("MediaRecorder.onstop triggered. State:", mediaRecorderRef.current?.state);
                  console.log("MediaRecorder.onstop: stopping silence detection.");
                  stopMediaTracksAndVAD();
                  showFeedback('Processing your answer...');
                  setPageState('transcribing');
  
                  if (audioChunksRef.current.length === 0) {
                      console.warn("No audio chunks recorded.");
                      showFeedback("No audio was recorded. Please ensure your microphone is working and try speaking again.", "info");
                      setPageState('listening'); // Go back to listening state
                      // Tracks will be stopped by the outer stopRecording or if startRecording is called again
                      return;
                  }
  
                  const recordedMimeType = mediaRecorderRef.current?.mimeType || 'application/octet-stream'; // Fallback
                  console.log(`Creating audio blob. Recorder mimeType: ${recordedMimeType}, Chunks: ${audioChunksRef.current.length}`);
  
                  const audioBlob = new Blob(audioChunksRef.current, { type: recordedMimeType });
                  // audioChunksRef.current = []; // Clear chunks now that blob is made
  
                  // DEBUG: Download blob locally
                  /* const downloadUrl = URL.createObjectURL(audioBlob);
                  const a = document.createElement('a');
                  a.style.display = 'none';
                  a.href = downloadUrl;
                  // Extract a reasonable extension
                  const ext = recordedMimeType.includes('wav') ? 'wav' :
                              recordedMimeType.includes('webm') ? 'webm' :
                              recordedMimeType.includes('ogg') ? 'ogg' : 'bin';
                  a.download = `frontend_recorded_audio_${new Date().toISOString()}.${ext}`;
                  document.body.appendChild(a);
                  a.click();
                  URL.revokeObjectURL(downloadUrl);
                  a.remove();
                  console.log(`DEBUG: Triggered browser download of audio. Size: ${audioBlob.size}, Type: ${audioBlob.type}`); */
  
                  if (audioBlob.size < 200) { // Heuristic, a WAV header alone is ~44 bytes
                      showFeedback("Recorded audio seems too short or empty. Please try again.", true);
                      setPageState('listening'); // Or an error state, then back to listening
                      return;
                  }
  
                  try {
                    const formData = new FormData();
                    formData.append('audio_file', audioBlob, `response.webm`);
                    formData.append('language', questionnaire.language);
                    console.log(currentQuestion);
                    formData.append('question', JSON.stringify(currentQuestion));
                    console.log('HAFAISFGAG')
                    console.log(JSON.parse(formData.get('question')))
                    const sttProxyResponse = await fetch(`/api/stt-proxy`, { // Call your Next.js STT Proxy
                        method: 'POST',
                        body: formData,
                    });
        
                    if (!sttProxyResponse.ok) {
                        const errData = await sttProxyResponse.json().catch(()=>({message: "STT Proxy request failed"}));
                        throw new Error(`Speech-to-text via proxy failed: ${errData.message || sttProxyResponse.statusText}`);
                    }
                    const result = await sttProxyResponse.json();
                      setTranscribedText(result.transcription);
                      setParsedValue(result.parsed_value);
                      setIsValueFound(result.value_found);
                      if (!result.value_found || result.error_message) {
                          showFeedback(result.error_message || "I couldn't understand a value. Please review.", true);
                      } else {
                          showFeedback(`I understood: ${result.parsed_value}. Is that correct?`);
                      }
                      setPageState('awaitingConfirmation');
                  } catch (error) {
                      console.error("Error submitting answer:", error);
                      const detail = error instanceof Error ? error.message : String(error);
                      showFeedback(`Error processing answer: ${detail}. Please try again.`, true);
                      setPageState('awaitingConfirmation'); // Still show what (if anything) was transcribed, or let user retry
                  } finally {
                       // Clear chunks here after API call and processing for the current recording
                      audioChunksRef.current = [];
                  }
              };
              
              mediaRecorderRef.current.onerror = (event) => {
                  console.error("MediaRecorder error:", event);
                  // @ts-ignore // MediaRecorderErrorEvent might not be typed well
                  showFeedback(`Audio recording error: ${event.error?.name} - ${event.error?.message}. Please try again.`, true);
                  setPageState('error'); // Or back to 'presentingQuestion'
                  stopMediaTracks(); // Clean up
              };
  
              //setIsSpeaking(false); // Reset: user hasn't started speaking in this recording yet
              let silenceStartTime: number | null = null;
              hasSpeechSustainedRef.current = false; // Reset for this recording session
              consecutiveSpeechIntervalsCountRef.current = 0;
              consecutiveSilenceIntervalsCountRef.current = 0;
  
  
              const checkForSilenceAndSpeech = () => {
                  if (!analyserRef.current || !mediaRecorderRef.current || mediaRecorderRef.current.state !== 'recording') {
                      if (activityCheckIntervalRef.current) clearInterval(activityCheckIntervalRef.current);
                      activityCheckIntervalRef.current = null;
                      return;
                  }

                  const segmentSize = Math.floor(dataArray.length / waveformValues.length);
                const barHeights = Array.from({ length: waveformValues.length }).map((_, i) => {
                const segment = dataArray.slice(i * segmentSize, (i + 1) * segmentSize);
                return segment.reduce((a, b) => a + b, 0) / segment.length;
                });
                setWaveformValues(barHeights);

  
                  analyserRef.current.getByteFrequencyData(dataArray);
                  let sum = 0;
                  for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                  const averageEnergy = sum / dataArray.length;
  
                  console.log(`Avg Energy: ${averageEnergy.toFixed(1)}, Sustained: ${hasSpeechSustainedRef.current}, Speech Cnt: ${consecutiveSpeechIntervalsCountRef.current}, Silence Cnt: ${consecutiveSilenceIntervalsCountRef.current}`);
  
                  if (averageEnergy > ENERGY_THRESHOLD) { // Sound detected in this interval
                      consecutiveSilenceIntervalsCountRef.current = 0; // Reset silence counter
                      if (silenceAfterSpeechTimerRef.current) { // If a silence timer was running, clear it
                          clearTimeout(silenceAfterSpeechTimerRef.current);
                          silenceAfterSpeechTimerRef.current = null;
                          console.log("Sound detected, cleared pending silence timer.");
                      }
  
                      if (!hasSpeechSustainedRef.current) {
                          consecutiveSpeechIntervalsCountRef.current++;
                          if (consecutiveSpeechIntervalsCountRef.current >= REQUIRED_CONSECUTIVE_SPEECH_INTERVALS) {
                              hasSpeechSustainedRef.current = true;
                              console.log("Sustained speech detected.");
                          }
                      }
                  } else { // Silence detected in this interval (averageEnergy <= ENERGY_THRESHOLD)
                      consecutiveSpeechIntervalsCountRef.current = 0; // Reset speech counter if silence occurs
  
                      if (hasSpeechSustainedRef.current) { // Only start silence timer if speech had previously been sustained
                          if (!silenceAfterSpeechTimerRef.current) { // And if timer isn't already running
                              console.log("Potential silence after sustained speech detected. Starting timer...");
                              silenceAfterSpeechTimerRef.current = setTimeout(() => {
                                  if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                                      console.log(`Silence persisted for ${SILENCE_DURATION_MS}ms after sustained speech. Stopping recording.`);
                                      stopRecording();
                                  }
                              }, SILENCE_DURATION_MS);
                          }
                      }
                  }
              };
  
              if (activityCheckIntervalRef.current) clearInterval(activityCheckIntervalRef.current);
              activityCheckIntervalRef.current = setInterval(checkForSilenceAndSpeech, VOICE_ACTIVITY_CHECK_INTERVAL_MS);
  
              mediaRecorderRef.current.start(); // Use default timeslice or e.g. start(1000) for 1s chunks
              console.log("MediaRecorder started. State:", mediaRecorderRef.current.state);
              setPageState('listening');
              showFeedback('Please speak your answer now...');
          } catch (err) {
              console.error("Error accessing/starting microphone:", err);
              const errorName = err instanceof Error ? err.name : "UnknownError";
              let userMessage = 'Could not access microphone.';
              if (errorName === 'NotFoundError') userMessage = 'Microphone not found. Please ensure it is connected.';
              else if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') userMessage = 'Microphone access denied. Please enable permissions in your browser settings.';
              
              showFeedback(userMessage, "error");
              setPageState('error');
              stopMediaTracks(); // Clean up if stream was partially acquired
          }
      };
  
      const stopMediaTracks = useCallback(() => {
          if (mediaStreamRef.current) {
              console.log("Stopping all media stream tracks.");
              mediaStreamRef.current.getTracks().forEach(track => track.stop());
              mediaStreamRef.current = null;
          }
      }, []);
  
      const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            console.log("Stopping MediaRecorder (manual or VAD triggered)...");
            showFeedback('Finishing recording...');
            setPageState('stoppingRecording');
            mediaRecorderRef.current.stop(); // This triggers 'onstop' which now also calls stopVADDetection
        } else if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
            // If somehow paused, also stop
            mediaRecorderRef.current.stop();
        } else {
            console.log("Stop recording called, but recorder not in a stoppable state. Current state:", mediaRecorderRef.current?.state);
        }
        // VAD timers are cleared by onstop (via stopVADDetection) or if startRecording fails.
        // We can also proactively clear them here if this is a manual override,
        // though onstop should handle it.
        if (activityCheckIntervalRef.current) clearInterval(activityCheckIntervalRef.current);
        if (silenceAfterSpeechTimerRef.current) clearTimeout(silenceAfterSpeechTimerRef.current);
    }, [showFeedback]);
  
    const stopVADDetection = useCallback(() => {
      if (activityCheckIntervalRef.current) clearInterval(activityCheckIntervalRef.current);
      if (silenceAfterSpeechTimerRef.current) clearTimeout(silenceAfterSpeechTimerRef.current);
      activityCheckIntervalRef.current = null;
      silenceAfterSpeechTimerRef.current = null;
      if (sourceNodeRef.current) { try { sourceNodeRef.current.disconnect(); } catch(e){} sourceNodeRef.current = null; }
      if (analyserRef.current) { try { analyserRef.current.disconnect(); } catch(e){} analyserRef.current = null; }
      
      hasSpeechSustainedRef.current = false;
      consecutiveSpeechIntervalsCountRef.current = 0;
      consecutiveSilenceIntervalsCountRef.current = 0; // Reset this too
      console.log("VAD detection resources stopped and reset.");
  }, []);
  
    const stopMediaTracksAndVAD = useCallback(() => { // Combined cleanup
        stopVADDetection();
        stopMediaTracks(); // Your existing function from useMicStream or similar
    }, [stopVADDetection, stopMediaTracks]);
  // --- Fetch Questionnaire Data ---
  useEffect(() => {
    if (questionnaireId && typeof questionnaireId === 'string') {
      const fetchQuestionnaire = async () => {
        setPageState('loading');
        showFeedback("Loading questionnaire...");
        try {
          const res = await fetch(`/api/questionnaires/${questionnaireId}/public`);
          if (!res.ok) throw new Error(`Failed to load questionnaire (status: ${res.status})`);
          const data: FullQuestionnaire = await res.json();
          setQuestionnaire(data);
          //setPageState('startingAttempt');
    showFeedback("Starting your session...");
    try {
      const res = await fetch('/api/attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionnaireId: data.id, mode: 'AUDIO' }),
      });
      if (!res.ok) throw new Error('Failed to start questionnaire attempt.');
      const datae = await res.json();
      setAttemptId(datae.attemptId);
      setCurrentQuestionIndex(0); // Start with the first question
      showFeedback("Session started. Let's begin!");
    } catch (error: any) {
      console.error(error);
      showFeedback(`Error: ${error.message}`, 'error');
      setPageState('error');
    }
          
        } catch (error: any) {
          console.error(error);
          showFeedback(`Error: ${error.message}`, 'error');
          setPageState('error');
        }
      };
      fetchQuestionnaire();
    }
  }, [questionnaireId]);

  // --- Start Attempt ---
  const handleStartAttempt = async () => {
    if (!questionnaire) return;
    setPageState('startingAttempt');
    showFeedback("Starting your session...");
    try {
      const res = await fetch('/api/attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionnaireId: questionnaire.id, mode: 'AUDIO' }),
      });
      if (!res.ok) throw new Error('Failed to start questionnaire attempt.');
      const data = await res.json();
      setAttemptId(data.attemptId);
      setCurrentQuestionIndex(0); // Start with the first question
      showFeedback("Session started. Let's begin!");
    } catch (error: any) {
      console.error(error);
      showFeedback(`Error: ${error.message}`, 'error');
      setPageState('error');
    }
  };

 // --- Load and Play Next Question ---
 useEffect(() => {
     if (attemptId && questionnaire && currentQuestionIndex >= 0 && currentQuestionIndex < questionnaire.questions.length) {
         const q = questionnaire.questions[currentQuestionIndex];
         setCurrentQuestion(q);
         setPageState('presentingQuestion');
         showFeedback(`Question ${currentQuestionIndex + 1}: ${q.text.substring(0,50)}...`);
         setCurrentProgress(((currentQuestionIndex + 1) / questionnaire.questions.length) * 100);

         // Find appropriate audio - assumes primary language of questionnaire
         const audio = q.preGeneratedAudios.find(a => a.languageCode === questionnaire.language);
         if (audioPlayerRef.current && audio?.audioPath) {
             console.log("Playing audio:", audio.audioPath);
             audioPlayerRef.current.src = audio.audioPath; // This is already a web-accessible path like /audio_cache/...
             audioPlayerRef.current.play()
                 .then(() => setPageState('playingAudio'))
                 .catch(e => {
                     console.error("Error playing question audio:", e);
                     showFeedback("Error playing question. Proceeding to listen.", 'error');
                     startRecording(); 
                 });
         } else {
             showFeedback(audio?.audioPath ? "Audio player not ready." : "No audio for this question. Please contact support.", 'error');
             // Potentially skip question or error out
             setPageState('error');
         }
     } else if (attemptId && questionnaire && currentQuestionIndex >= questionnaire.questions.length) {
         setPageState('complete');
         showFeedback("Questionnaire complete! Thank you.", 'success');
         setCurrentProgress(100);
         stopMediaTracksAndVAD(); // Ensure everything is off
     }
 }, [currentQuestionIndex, questionnaire]); // Added startRecording to deps

  const handleAudioPlaybackEnded = () => {
     if (pageState === 'playingAudio') {
         console.log("Audio playback ended, starting recording.");
         startRecording();
     }
  };

  const WaveformVisualizer = () => {
   return (
      <div className="flex items-end justify-center h-6 gap-[2px] w-16">
        {waveformValues.map((v, i) => (
          <div
            key={i}
            className="w-[3px] rounded-sm bg-blue-500 transition-all duration-75 ease-linear"
            style={{ height: `${Math.max(4, Math.min(24, v / 2))}px` }}
          />
        ))}
      </div>
   )
  };
  

 // --- Submit Transcribed Answer to FastAPI, then to Next.js Backend ---
 // This function is called from MediaRecorder.onstop in your startRecording VAD logic
 const processAndSubmitRecordedAudio = async (audioBlob: Blob) => {
     if (!attemptId || !currentQuestion) return;
     showFeedback("Transcribing your answer...");
     setPageState('transcribing');
     try {
         // 1. Send to FastAPI for STT
         const formData = new FormData();
         formData.append('audio_file', audioBlob, `response_${currentQuestion.id}.webm`);
         // Ensure your FastAPI STT endpoint URL is correct
         const sttResponse = await fetch(`${process.env.NEXT_PUBLIC_FASTAPI_URL || 'http://localhost:8000'}/api/answer/submit`, {
             method: 'POST',
             body: formData,
         });
         if (!sttResponse.ok) {
             const errData = await sttResponse.json().catch(()=>({detail: "STT request failed"}));
             throw new Error(`Speech-to-text failed: ${errData.detail || sttResponse.statusText}`);
         }
         const sttResult = await sttResponse.json();
         
         setTranscribedText(sttResult.transcription || "");
         setParsedValue(sttResult.parsed_value);
         setIsValueFound(sttResult.value_found);

         if (!sttResult.value_found || sttResult.error_message) {
             showFeedback(sttResult.error_message || "I couldn't understand a value. Please review.", 'error');
         } else {
             showFeedback(`I understood: ${sttResult.parsed_value}. Is that correct?`);
         }
         setPageState('awaitingConfirmation');

     } catch (error: any) {
         console.error("Error during STT or parsing:", error);
         showFeedback(`Error: ${error.message}`, 'error');
         // Allow user to retry saying the answer for the same question
         setPageState('awaitingConfirmation'); // Go to confirmation to allow retry
         setTranscribedText(""); // Clear transcription on STT error
         setIsValueFound(false);
         setParsedValue(null);
     }
 };
 // IMPORTANT: Your `startRecording`'s `MediaRecorder.onstop` should call `processAndSubmitRecordedAudio(audioBlob)`

  const handleConfirmAnswer = async (isConfirmedByUser: boolean) => {
     if (!attemptId || !currentQuestion) return;

     if (isConfirmedByUser && isValueFound) {
         setPageState('savingAnswer');
         showFeedback("Saving your answer...");
         try {
             const answerPayload = {
                 attemptId,
                 questionId: currentQuestion.id,
                 transcribedResponse: transcribedText,
                 parsedValue: String(parsedValue), // Ensure it's a string for DB if schema expects string
                 isConfirmed: true,
             };
             const res = await fetch(`/api/attempts/${attemptId}`, {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify(answerPayload),
             });
             if (!res.ok) throw new Error('Failed to save answer.');
             
             showFeedback("Answer saved.");
             setCurrentQuestionIndex(prev => prev + 1); // Move to next question

         } catch (error: any) {
             showFeedback(`Error saving answer: ${error.message}`, 'error');
             setPageState('awaitingConfirmation'); // Allow retry of confirmation/saving
         }
     } else { // User said "No, try again" or value wasn't found initially
         showFeedback('Okay, let\'s try that question again.');
         setTranscribedText('');
         setParsedValue(null);
         setIsValueFound(false);
         startRecording(); // Back to listening for same question
     }
  };

  // --- UI Rendering ---
  const renderPageContent = () => {
     // ... (Similar to POC's renderContent, but using pageState and new components)
     // Example for 'listening' state:
     if (pageState === 'listening') {
        return (
          <CardContent className="flex flex-col items-center justify-center min-w-[400px] space-y-4">
            
            <WaveformVisualizer/>
            <p className="text-lg text-slate-600 dark:text-slate-300 pt-6">{feedbackMessage || "Listening..."}</p>
            <Button variant="outline" onClick={stopRecording} className="mt-4">
              <Mic className="mr-2 h-4 w-4" /> Stop Manually
            </Button>
          </CardContent>
        );
      }

      if (pageState === 'transcribing') {
        return (
          <CardContent className="flex flex-col items-center justify-center min-h-[200px] space-y-4">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 rounded-full border-4 border-blue-500 animate-ping" />
              <div className="absolute inset-0 rounded-full border-4 border-blue-500" />
            </div>
            <p className="text-lg text-slate-600 dark:text-slate-300 pt-12">Transcribing your answer...</p>
          </CardContent>
        );
      }
     // Example for 'awaitingConfirmation':
     if (pageState === 'awaitingConfirmation') {
         return (
             <CardContent className="space-y-4">
                 <p className="text-lg">You said: <strong className="text-slate-700 dark:text-slate-200">"{transcribedText || "Nothing was transcribed."}"</strong></p>
                 {isValueFound && parsedValue !== null && (
                     <p className="text-lg">I understood the value: <strong className="text-blue-600 dark:text-blue-400">{String(parsedValue)}</strong></p>
                 )}
                 {!isValueFound && transcribedText && (
                     <p className="text-orange-600 dark:text-orange-400"><AlertCircle className="inline mr-1 h-5 w-5"/>I couldn't identify a specific value.</p>
                 )}
                 <p>Is this correct?</p>
                 <div className="flex justify-center gap-4 pt-2">
                     <Button onClick={() => handleConfirmAnswer(true)} disabled={!isValueFound} className="bg-green-500 hover:bg-green-600">
                         <CheckCircle className="mr-2 h-4 w-4"/> Yes, Correct
                     </Button>
                     <Button variant="destructive" onClick={() => handleConfirmAnswer(false)}>
                         <HelpCircle className="mr-2 h-4 w-4"/> No, Try Again
                     </Button>
                 </div>
             </CardContent>
         );
     }
     if (pageState === 'playingAudio') {
        return (
          <CardContent className="flex flex-col items-center justify-center min-h-[200px] space-y-4">
            
            <WaveformVisualizer />
            <p className="text-lg text-slate-600 dark:text-slate-300">Playing question...</p>
          </CardContent>
        );
      }
     // ... other states: loading, readyToStart, playingAudio, transcribing, complete, error ...
     if (pageState === 'loading') return <div className="flex justify-center items-center min-h-[200px]"><Loader2 className="h-12 w-12 animate-spin text-blue-600"/> <p className="ml-3 text-lg">Loading Questionnaire...</p></div>;
     if (pageState === 'readyToStart' && questionnaire) {
         return (
             <CardContent className="text-center space-y-6">
                 <p className="text-lg text-slate-700 dark:text-slate-200">{questionnaire.description || "Ready to begin?"}</p>
                 <Button size="lg" onClick={handleStartAttempt} className="bg-green-600 hover:bg-green-700">
                     <PlayCircle className="mr-2 h-6 w-6"/> Start Questionnaire
                 </Button>
             </CardContent>
         );
     }
      if (pageState === 'complete') {
         return (
             <CardContent className="text-center space-y-6">
                 <CheckCircle className="w-20 h-20 text-green-500 mx-auto"/>
                 <h2 className="text-2xl font-semibold">Questionnaire Complete!</h2>
                 <p className="text-slate-600 dark:text-slate-300">Thank you for your participation.</p>
                 <Link href="/questionnaires" passHref>
                     <Button variant="outline">Back to Questionnaires List</Button>
                 </Link>
             </CardContent>
         );
     }
     if (pageState === 'error') {
          return <CardContent className="text-center space-y-4"><AlertCircle className="w-12 h-12 text-red-500 mx-auto"/><p className="text-red-600 dark:text-red-400">{feedbackMessage || "An unknown error occurred."}</p><Button onClick={() => router.reload()} variant="outline">Try Reloading Page</Button></CardContent>;
     }

     // Default/Fallback for states like presentingQuestion, transcribing, etc.
     return <CardContent className="flex flex-col items-center justify-center min-h-[200px] space-y-4"><Loader2 className="h-10 w-10 animate-spin text-blue-600"/> <p className="text-slate-600 dark:text-slate-300">{feedbackMessage || "Please wait..."}</p></CardContent>;
  };

  return (
     <ParticipantLayout questionnaireTitle={questionnaire?.title}>
         <Card className="w-full shadow-xl dark:bg-slate-800">
             {(pageState !== 'loading' && pageState !== 'readyToStart' && pageState !== 'complete' && pageState !== 'error' && questionnaire) && (
                 <CardHeader className="pb-2">
                     <CardTitle className="text-lg sm:text-xl text-center text-slate-700 dark:text-slate-200">
                         Question {currentQuestionIndex + 1} of {questionnaire.questions.length}
                     </CardTitle>
                     <Progress value={currentProgress} className="w-full h-2 mt-2" />
                 </CardHeader>
             )}
             {renderPageContent()}
         </Card>
         <audio ref={audioPlayerRef} onEnded={handleAudioPlaybackEnded} style={{ display: 'none' }} />
     </ParticipantLayout>
  );
}