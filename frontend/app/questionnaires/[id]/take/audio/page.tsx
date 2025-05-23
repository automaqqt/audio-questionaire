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
// import { apiClient } from '@/lib/apiClient'; // Not used in this snippet, can be removed if not used elsewhere
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
 | 'awaitingConfirmation' // Processing response, playing feedback audio
 | 'savingAnswer' // Saving answer to Next.js DB
 | 'complete'
 | 'error';

// Paths to pre-generated feedback audio files (ensure these exist in your public folder)
const PREGEN_AUDIO_THANK_YOU_NEXT = '/system_feedback/thank_you_next_question';
const PREGEN_AUDIO_DID_NOT_UNDERSTAND = '/system_feedback/did_not_understand';


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

  // Refs for audio
  const audioPlayerRef = useRef<HTMLAudioElement>(null); // For question audio
  const feedbackAudioPlayerRef = useRef<HTMLAudioElement>(null); // For system feedback audio
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
              mediaStreamRef.current = stream;

              if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
                audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
              }
              analyserRef.current = audioContextRef.current.createAnalyser();
              analyserRef.current.fftSize = 2048;
              analyserRef.current.smoothingTimeConstant = 0.5;

              sourceNodeRef.current = audioContextRef.current.createMediaStreamSource(stream);
              sourceNodeRef.current.connect(analyserRef.current);

              const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);

              const mimeTypesToTry = [
                  'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/wav',
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
              audioChunksRef.current = [];

              mediaRecorderRef.current.ondataavailable = (event) => {
                  if (event.data.size > 0) {
                      audioChunksRef.current.push(event.data);
                  }
              };

              mediaRecorderRef.current.onstop = async () => {
                  console.log("MediaRecorder.onstop triggered.");
                  stopMediaTracksAndVAD(); // VAD and tracks are stopped first
                  // setPageState('transcribing'); // This will be set by handleRecordedAudioProcessing

                  if (audioChunksRef.current.length === 0) {
                      console.warn("No audio chunks recorded.");
                      showFeedback("No audio was recorded. Let's try that question again.", "info");
                      // Play "did not understand" and repeat question
                      if (feedbackAudioPlayerRef.current) {
                          feedbackAudioPlayerRef.current.src = `${PREGEN_AUDIO_DID_NOT_UNDERSTAND}_${questionnaire?.language}.wav`;
                          feedbackAudioPlayerRef.current.onended = () => {
                              handleConfirmAnswer(false); // This will trigger replayCurrentQuestion
                              if(feedbackAudioPlayerRef.current) feedbackAudioPlayerRef.current.onended = null;
                          };
                          feedbackAudioPlayerRef.current.play().catch(e => {
                              console.error("Error playing 'did not understand' audio (no chunks):", e);
                              handleConfirmAnswer(false); // Fallback
                          });
                      } else {
                          handleConfirmAnswer(false); // Fallback
                      }
                      return;
                  }

                  const recordedMimeType = mediaRecorderRef.current?.mimeType || 'application/octet-stream';
                  const audioBlob = new Blob(audioChunksRef.current, { type: recordedMimeType });
                  audioChunksRef.current = []; // Clear chunks now

                  if (audioBlob.size < 200) {
                      showFeedback("Recorded audio seems too short. Let's try that question again.", "error");
                       if (feedbackAudioPlayerRef.current) {
                          feedbackAudioPlayerRef.current.src = `${PREGEN_AUDIO_DID_NOT_UNDERSTAND}_${questionnaire?.language}.wav`;
                          feedbackAudioPlayerRef.current.onended = () => {
                              handleConfirmAnswer(false);
                              if(feedbackAudioPlayerRef.current) feedbackAudioPlayerRef.current.onended = null;
                          };
                          feedbackAudioPlayerRef.current.play().catch(e => {
                              console.error("Error playing 'did not understand' audio (short audio):", e);
                              handleConfirmAnswer(false);
                          });
                      } else {
                          handleConfirmAnswer(false);
                      }
                      return;
                  }
                  handleRecordedAudioProcessing(audioBlob);
              };

              mediaRecorderRef.current.onerror = (event) => {
                  console.error("MediaRecorder error:", event);
                  // @ts-ignore
                  showFeedback(`Audio recording error: ${event.error?.name}. Let's try that question again.`,  "error");
                  stopMediaTracksAndVAD(); // Clean up
                  // Play "did not understand" and repeat question
                  if (feedbackAudioPlayerRef.current) {
                      feedbackAudioPlayerRef.current.src = `${PREGEN_AUDIO_DID_NOT_UNDERSTAND}_${questionnaire?.language}.wav`;
                      feedbackAudioPlayerRef.current.onended = () => {
                          handleConfirmAnswer(false);
                          if(feedbackAudioPlayerRef.current) feedbackAudioPlayerRef.current.onended = null;
                      };
                      feedbackAudioPlayerRef.current.play().catch(e => {
                          console.error("Error playing 'did not understand' audio (recorder error):", e);
                          handleConfirmAnswer(false);
                      });
                  } else {
                      handleConfirmAnswer(false);
                  }
              };

              hasSpeechSustainedRef.current = false;
              consecutiveSpeechIntervalsCountRef.current = 0;
              consecutiveSilenceIntervalsCountRef.current = 0;

              const checkForSilenceAndSpeech = () => {
                  if (!analyserRef.current || !mediaRecorderRef.current || mediaRecorderRef.current.state !== 'recording') {
                      if (activityCheckIntervalRef.current) clearInterval(activityCheckIntervalRef.current);
                      activityCheckIntervalRef.current = null;
                      return;
                  }
                  analyserRef.current.getByteFrequencyData(dataArray);
                  const segmentSize = Math.floor(dataArray.length / waveformValues.length);
                  const barHeights = Array.from({ length: waveformValues.length }).map((_, i) => {
                      const segment = dataArray.slice(i * segmentSize, (i + 1) * segmentSize);
                      return segment.reduce((a, b) => a + b, 0) / segment.length;
                  });
                  setWaveformValues(barHeights);

                  let sum = 0;
                  for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                  const averageEnergy = sum / dataArray.length;

                  if (averageEnergy > ENERGY_THRESHOLD) {
                      consecutiveSilenceIntervalsCountRef.current = 0;
                      if (silenceAfterSpeechTimerRef.current) {
                          clearTimeout(silenceAfterSpeechTimerRef.current);
                          silenceAfterSpeechTimerRef.current = null;
                      }
                      if (!hasSpeechSustainedRef.current) {
                          consecutiveSpeechIntervalsCountRef.current++;
                          if (consecutiveSpeechIntervalsCountRef.current >= REQUIRED_CONSECUTIVE_SPEECH_INTERVALS) {
                              hasSpeechSustainedRef.current = true;
                          }
                      }
                  } else {
                      consecutiveSpeechIntervalsCountRef.current = 0;
                      if (hasSpeechSustainedRef.current) {
                          if (!silenceAfterSpeechTimerRef.current) {
                              silenceAfterSpeechTimerRef.current = setTimeout(() => {
                                  if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                                      stopRecording();
                                  }
                              }, SILENCE_DURATION_MS);
                          }
                      }
                  }
              };

              if (activityCheckIntervalRef.current) clearInterval(activityCheckIntervalRef.current);
              activityCheckIntervalRef.current = setInterval(checkForSilenceAndSpeech, VOICE_ACTIVITY_CHECK_INTERVAL_MS);

              mediaRecorderRef.current.start();
              setPageState('listening');
              showFeedback('Please speak your answer now...');
          } catch (err) {
              console.error("Error accessing/starting microphone:", err);
              const errorName = err instanceof Error ? err.name : "UnknownError";
              let userMessage = 'Could not access microphone.';
              if (errorName === 'NotFoundError') userMessage = 'Microphone not found.';
              else if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') userMessage = 'Microphone access denied.';
              showFeedback(`${userMessage} Please check permissions and reload.`, "error");
              setPageState('error');
              stopMediaTracksAndVAD();
          }
      };

      const stopMediaTracks = useCallback(() => {
          if (mediaStreamRef.current) {
              mediaStreamRef.current.getTracks().forEach(track => track.stop());
              mediaStreamRef.current = null;
          }
      }, []);

      const stopVADDetection = useCallback(() => {
        if (activityCheckIntervalRef.current) clearInterval(activityCheckIntervalRef.current);
        if (silenceAfterSpeechTimerRef.current) clearTimeout(silenceAfterSpeechTimerRef.current);
        activityCheckIntervalRef.current = null;
        silenceAfterSpeechTimerRef.current = null;
        if (sourceNodeRef.current) { try { sourceNodeRef.current.disconnect(); } catch(e){} sourceNodeRef.current = null; }
        if (analyserRef.current) { try { analyserRef.current.disconnect(); } catch(e){} analyserRef.current = null; }
        hasSpeechSustainedRef.current = false;
        consecutiveSpeechIntervalsCountRef.current = 0;
        consecutiveSilenceIntervalsCountRef.current = 0;
    }, []);

    const stopMediaTracksAndVAD = useCallback(() => {
        stopVADDetection();
        stopMediaTracks();
    }, [stopVADDetection, stopMediaTracks]);

    const stopRecording = useCallback(() => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
          showFeedback('Finishing recording...');
          setPageState('stoppingRecording'); // Indicates VAD might have triggered stop or manual stop
          mediaRecorderRef.current.stop(); // This triggers 'onstop'
      } else if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
          mediaRecorderRef.current.stop();
      }
      // VAD timers are cleared by onstop (via stopVADDetection) or if startRecording fails.
      // Proactively clear them here too for manual stop.
      if (activityCheckIntervalRef.current) clearInterval(activityCheckIntervalRef.current);
      if (silenceAfterSpeechTimerRef.current) clearTimeout(silenceAfterSpeechTimerRef.current);
  }, []);


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
          showFeedback("Starting your session...");
          try {
            const attemptRes = await fetch('/api/attempts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ questionnaireId: data.id, mode: 'AUDIO' }),
            });
            if (!attemptRes.ok) throw new Error('Failed to start questionnaire attempt.');
            const attemptData = await attemptRes.json();
            setAttemptId(attemptData.attemptId);
            setCurrentQuestionIndex(0);
            showFeedback("Session started. Let's begin!");
            // No longer 'readyToStart', directly to first question via useEffect on currentQuestionIndex
          } catch (error: any) {
            console.error(error);
            showFeedback(`Error starting session: ${error.message}`, 'error');
            setPageState('error');
          }
        } catch (error: any) {
          console.error(error);
          showFeedback(`Error loading questionnaire: ${error.message}`, 'error');
          setPageState('error');
        }
      };
      fetchQuestionnaire();
    }
  }, [questionnaireId]);


 // --- Utility to play question audio ---
 const playQuestionAudio = useCallback((question: QuestionWithAudio) => {
    if (!questionnaire || !audioPlayerRef.current) {
        showFeedback("Cannot play question audio: system not ready.", 'error');
        // Potentially try to go to listening if it's a retry, or error out
        if (pageState === 'presentingQuestion' && currentQuestionIndex >= 0) { // Check if it's a valid question presentation
             startRecording(); // Fallback: try to listen even if audio fails
        } else {
            setPageState('error');
        }
        return;
    }

    const audio = question.preGeneratedAudios.find(a => a.languageCode === questionnaire.language);
    if (audio?.audioPath) {
        console.log("Playing audio for question:", audio.audioPath);
        audioPlayerRef.current.src = audio.audioPath;
        audioPlayerRef.current.play()
            .then(() => setPageState('playingAudio'))
            .catch(e => {
                console.error("Error playing question audio:", e);
                showFeedback("Error playing question audio. Proceeding to listen.", 'error');
                startRecording(); // Attempt to continue by listening
            });
    } else {
        showFeedback(audio?.audioPath === undefined ? "No audio for this question." : "Audio player not ready for question.", 'error');
        // If audio is essential and missing/unplayable for a new question, it's a problem.
        // For an audio questionnaire, audio is critical.
        startRecording(); // Fallback: try to listen
    }
}, [questionnaire, pageState, currentQuestionIndex]); // Added dependencies

 // --- Load and Play Next/Current Question ---
 useEffect(() => {
     if (attemptId && questionnaire && currentQuestionIndex >= 0 && currentQuestionIndex < questionnaire.questions.length) {
         const q = questionnaire.questions[currentQuestionIndex];
         setCurrentQuestion(q);
         setPageState('presentingQuestion');
         showFeedback(`Question ${currentQuestionIndex + 1}: ${q.text.substring(0,50)}...`);
         setCurrentProgress(((currentQuestionIndex + 1) / questionnaire.questions.length) * 100);
         playQuestionAudio(q);
     } else if (attemptId && questionnaire && currentQuestionIndex >= questionnaire.questions.length) {
         setPageState('complete');
         showFeedback("Questionnaire complete! Thank you.", 'success');
         setCurrentProgress(100);
         stopMediaTracksAndVAD();
     }
 }, [currentQuestionIndex, questionnaire, attemptId]);


  const handleAudioPlaybackEnded = () => { // For question audio
     if (pageState === 'playingAudio') {
         console.log("Question audio playback ended, starting recording.");
         startRecording();
     }
  };

  const WaveformVisualizer = () => (
      <div className="flex items-end justify-center h-6 gap-[2px] w-16">
        {waveformValues.map((v, i) => (
          <div
            key={i}
            className="w-[3px] rounded-sm bg-blue-500 transition-all duration-75 ease-linear"
            style={{ height: `${Math.max(4, Math.min(24, v / 2))}px` }}
          />
        ))}
      </div>
  );

  // --- Process recorded audio, STT, and then decide next step ---
  const handleRecordedAudioProcessing = async (audioBlob: Blob) => {
    if (!currentQuestion || !questionnaire) {
        showFeedback("Cannot process audio: critical information missing. Please reload.", "error");
        setPageState('error');
        return;
    }
    setPageState('transcribing');
    showFeedback("Processing your answer...");

    try {
        const formData = new FormData();
        formData.append('audio_file', audioBlob, `response.webm`);
        formData.append('language', questionnaire.language);
        formData.append('question', JSON.stringify(currentQuestion));
        formData.append('options', JSON.stringify(currentQuestion.visualOptions));

        const sttProxyResponse = await fetch(`/api/stt-proxy`, {
            method: 'POST',
            body: formData,
        });

        if (!sttProxyResponse.ok) {
            const errData = await sttProxyResponse.json().catch(() => ({ message: "STT Proxy request failed with no JSON body" }));
            throw new Error(`Speech-to-text via proxy failed: ${errData.message || sttProxyResponse.statusText}`);
        }
        const result = await sttProxyResponse.json();

        setTranscribedText(result.transcription || "");
        setParsedValue(result.parsed_value);
        setIsValueFound(result.value_found);
        setPageState('awaitingConfirmation'); // Transition to this state while feedback audio plays

        if (result.value_found) {
            showFeedback(`Understood: ${result.parsed_value}. Thank you, let's go to the next question.`);
            if (feedbackAudioPlayerRef.current) {
                feedbackAudioPlayerRef.current.src = `${PREGEN_AUDIO_THANK_YOU_NEXT}_${questionnaire?.language}.wav`;
                feedbackAudioPlayerRef.current.onended = () => {
                    handleConfirmAnswer(true);
                    if(feedbackAudioPlayerRef.current) feedbackAudioPlayerRef.current.onended = null;
                };
                feedbackAudioPlayerRef.current.play().catch(e => {
                    console.error("Error playing 'thank you' audio:", e);
                    handleConfirmAnswer(true); // Fallback: proceed without audio
                });
            } else {
                handleConfirmAnswer(true); // Fallback: proceed without audio player ref
            }
        } else {
            showFeedback(result.error_message || "I did not understand you correctly, sorry. Let's try that question again.", "error");
            if (feedbackAudioPlayerRef.current) {
                feedbackAudioPlayerRef.current.src = `${PREGEN_AUDIO_DID_NOT_UNDERSTAND}_${questionnaire?.language}.wav`;
                feedbackAudioPlayerRef.current.onended = () => {
                    handleConfirmAnswer(false);
                    if(feedbackAudioPlayerRef.current) feedbackAudioPlayerRef.current.onended = null;
                };
                feedbackAudioPlayerRef.current.play().catch(e => {
                    console.error("Error playing 'did not understand' audio:", e);
                    handleConfirmAnswer(false); // Fallback: proceed to repeat
                });
            } else {
                handleConfirmAnswer(false); // Fallback: proceed to repeat
            }
        }
    } catch (error) {
        console.error("Error during STT or parsing:", error);
        const detail = error instanceof Error ? error.message : String(error);
        showFeedback(`Error processing answer: ${detail}. I did not understand you correctly, sorry. Let's try that question again.`, "error");
        setPageState('awaitingConfirmation'); // Still show this state briefly

        if (feedbackAudioPlayerRef.current) {
            feedbackAudioPlayerRef.current.src = `${PREGEN_AUDIO_DID_NOT_UNDERSTAND}_${questionnaire?.language}.wav`;
            feedbackAudioPlayerRef.current.onended = () => {
                handleConfirmAnswer(false); // Retry question
                if(feedbackAudioPlayerRef.current) feedbackAudioPlayerRef.current.onended = null;
            };
            feedbackAudioPlayerRef.current.play().catch(e => {
                console.error("Error playing 'did not understand' audio (on STT error):", e);
                handleConfirmAnswer(false); // Fallback: Retry question
            });
        } else {
            handleConfirmAnswer(false); // Fallback: Retry question
        }
    }
};


  const replayCurrentQuestion = useCallback(() => {
    if (attemptId && questionnaire && currentQuestion) {
        // State is already 'awaitingConfirmation' or similar, will be changed by playQuestionAudio
        showFeedback(`Repeating Question ${currentQuestionIndex + 1}. Please listen carefully.`, 'info');
        // Reset transcription from previous attempt for this question
        setTranscribedText('');
        setParsedValue(null);
        setIsValueFound(false);
        playQuestionAudio(currentQuestion);
    } else {
        showFeedback("Cannot repeat question, critical information missing. Please reload.", "error");
        setPageState('error');
    }
  }, [attemptId, questionnaire, currentQuestion, currentQuestionIndex, playQuestionAudio]);


  const handleConfirmAnswer = async (isConfirmedOrValueFound: boolean) => {
     if (!attemptId || !currentQuestion) return;

     if (isConfirmedOrValueFound) { // This means value was found and we are proceeding
         setPageState('savingAnswer');
         // Feedback message already set by handleRecordedAudioProcessing
         // showFeedback("Saving your answer...");
         try {
             const answerPayload = {
                 attemptId,
                 questionId: currentQuestion.id,
                 transcribedResponse: transcribedText,
                 parsedValue: String(parsedValue),
                 isConfirmed: true, // Implicitly confirmed by value_found
             };
             const res = await fetch(`/api/attempts/${attemptId}`, {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify(answerPayload),
             });
             if (!res.ok) throw new Error('Failed to save answer.');
             
             // showFeedback("Answer saved. Moving to next question."); // Feedback already given
             setCurrentQuestionIndex(prev => prev + 1);

         } catch (error: any) {
             showFeedback(`Error saving answer: ${error.message}. Let's try that question again.`, 'error');
             // If saving fails, repeat the question as we can't proceed.
             replayCurrentQuestion();
         }
     } else { // Value was NOT found, or an error occurred, and we need to repeat the question
         // Feedback message already set by handleRecordedAudioProcessing or STT error handling
         // showFeedback('Okay, let\'s try that question again.');
         replayCurrentQuestion();
     }
  };

  // --- UI Rendering ---
  const renderPageContent = () => {
     if (pageState === 'listening') {
        return (
          <CardContent className="flex flex-col items-center justify-center min-w-[400px] min-h-[200px] space-y-4">
            <WaveformVisualizer/>
            <p className="text-lg text-slate-600 dark:text-slate-300 pt-6">{feedbackMessage || "Listening..."}</p>
            <Button variant="outline" onClick={stopRecording} className="mt-4">
              <Mic className="mr-2 h-4 w-4" /> Stop Manually
            </Button>
          </CardContent>
        );
      }

      if (pageState === 'transcribing' || pageState === 'stoppingRecording') {
        return (
          <CardContent className="flex flex-col items-center justify-center min-h-[200px] space-y-4">
            <Loader2 className="h-10 w-10 animate-spin text-blue-600"/>
            <p className="text-lg text-slate-600 dark:text-slate-300 pt-6">
                {pageState === 'stoppingRecording' ? 'Finishing recording...' : feedbackMessage || "Transcribing your answer..."}
            </p>
          </CardContent>
        );
      }

     if (pageState === 'awaitingConfirmation') {
         return (
             <CardContent className="flex flex-col items-center justify-center min-h-[200px] space-y-4">
                 <Loader2 className="h-10 w-10 animate-spin text-blue-600"/>
                 <p className="text-lg text-slate-600 dark:text-slate-300 pt-6">
                     {feedbackMessage || "Processing your response..."}
                 </p>
                 {transcribedText && (
                      <p className="text-sm mt-2 text-center">You said: <strong className="text-slate-700 dark:text-slate-200">"{transcribedText}"</strong></p>
                 )}
                 {isValueFound && parsedValue !== null && (
                      <p className="text-sm mt-1 text-center">Understood value: <strong className="text-blue-600 dark:text-blue-400">{String(parsedValue)}</strong></p>
                 )}
             </CardContent>
         );
     }

     if (pageState === 'playingAudio' || pageState === 'presentingQuestion') {
        return (
          <CardContent className="flex flex-col items-center justify-center min-h-[200px] space-y-4">
            <WaveformVisualizer /> {/* Can show a static or gentle animation here */}
            <p className="text-lg text-slate-600 dark:text-slate-300">
                {pageState === 'playingAudio' ? 'Playing question...' : feedbackMessage || 'Getting next question...'}
            </p>
          </CardContent>
        );
      }

     if (pageState === 'loading') return <div className="flex justify-center items-center min-h-[200px]"><Loader2 className="h-12 w-12 animate-spin text-blue-600"/> <p className="ml-3 text-lg">Loading Questionnaire...</p></div>;
     
     // readyToStart is effectively skipped as we auto-start attempt now
     // if (pageState === 'readyToStart' && questionnaire) { ... }

      if (pageState === 'complete') {
         return (
             <CardContent className="text-center space-y-6 min-h-[200px] flex flex-col justify-center items-center">
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
          return <CardContent className="text-center space-y-4 min-h-[200px] flex flex-col justify-center items-center"><AlertCircle className="w-12 h-12 text-red-500 mx-auto"/><p className="text-red-600 dark:text-red-400">{feedbackMessage || "An unknown error occurred."}</p><Button onClick={() => router.refresh()} variant="outline">Try Reloading Page</Button></CardContent>;
     }

     // Fallback for states like savingAnswer or any unhandled intermediate state
     return <CardContent className="flex flex-col items-center justify-center min-h-[200px] space-y-4"><Loader2 className="h-10 w-10 animate-spin text-blue-600"/> <p className="text-slate-600 dark:text-slate-300">{feedbackMessage || "Please wait..."}</p></CardContent>;
  };

  return (
     <ParticipantLayout questionnaireTitle={questionnaire?.title}>
         <Card className="w-full shadow-xl dark:bg-slate-800">
             {(pageState !== 'loading' && pageState !== 'complete' && pageState !== 'error' && questionnaire && currentQuestionIndex >=0) && (
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
         <audio ref={feedbackAudioPlayerRef} style={{ display: 'none' }} />
     </ParticipantLayout>
  );
}