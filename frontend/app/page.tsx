'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { apiClient, QuestionResponse, TranscribedApiResponse, AnswerPayload } from '../lib/apiClient'; // Ensure this path is correct
import styles from '../styles/Home.module.css'; // Ensure this path is correct

// Define AppState types
type AppState =
    | 'idle' // Initial state
    | 'loadingQuestionnaire'
    | 'questionnaireReady' // Questionnaire loaded, ready to start
    | 'presentingQuestion' // Fetching/preparing to play question audio
    | 'playingAudio'       // Question audio is actively playing
    | 'listening'          // Microphone is active, waiting for user to speak
    | 'stoppingRecording'  // Recording stop initiated, waiting for onstop
    | 'transcribing'       // Audio sent to backend, awaiting transcription
    | 'awaitingConfirmation' // Transcription received, user needs to confirm
    | 'savingAnswer'       // Confirmed answer being saved to backend
    | 'questionnaireComplete'
    | 'error';

interface QuestionnaireInfo {
    title: string;
    description: string;
    totalQuestions: number;
}

const ENERGY_THRESHOLD = 20; // TUNE THIS: 0-255. From getByteFrequencyData average.
const SILENCE_DURATION_MS = 1500;
const VOICE_ACTIVITY_CHECK_INTERVAL_MS = 200;
const MIN_SPEECH_DURATION_MS = 500; 

export default function HomePage() {
    const [appState, setAppState] = useState<AppState>('idle');
    const [questionnaireInfo, setQuestionnaireInfo] = useState<QuestionnaireInfo | null>(null);
    const [currentQuestion, setCurrentQuestion] = useState<QuestionResponse | null>(null);
    const [transcribedText, setTranscribedText] = useState<string>('');
    const [parsedValue, setParsedValue] = useState<any | null>(null);
    const [isValueFound, setIsValueFound] = useState<boolean>(false);
    const [feedbackMessage, setFeedbackMessage] = useState<string>('');
    const [errorMessage, setErrorMessage] = useState<string>(''); // For persistent error messages
    const [confirmedAnswers, setConfirmedAnswers] = useState<AnswerPayload[]>([]);

    const [isSpeaking, setIsSpeaking] = useState<boolean>(false); // To track if user has started speaking

    const analyserRef = useRef<AnalyserNode | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const silenceAfterSpeechTimerRef = useRef<NodeJS.Timeout | null>(null); // Renamed for clarity
    const activityCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const hasSpeechOccurredRef = useRef<boolean>(false); // Ref to track if speech has started in current recording
    const firstSoundTimeRef = useRef<number | null>(null);

    const audioPlayerRef = useRef<HTMLAudioElement>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const mediaStreamRef = useRef<MediaStream | null>(null); // To hold the stream for explicit stopping

    // --- Utility for setting feedback and error messages ---
    const showFeedback = (message: string, isError: boolean = false) => {
        console.log(`FEEDBACK (${isError ? 'ERROR' : 'INFO'}): ${message}`);
        setFeedbackMessage(message);
        if (isError) setErrorMessage(message);
        else setErrorMessage(''); // Clear previous errors on non-error feedback
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
                setAppState('transcribing');

                if (audioChunksRef.current.length === 0) {
                    console.warn("No audio chunks recorded.");
                    showFeedback("No audio was recorded. Please ensure your microphone is working and try speaking again.", true);
                    setAppState('listening'); // Go back to listening state
                    // Tracks will be stopped by the outer stopRecording or if startRecording is called again
                    return;
                }

                const recordedMimeType = mediaRecorderRef.current?.mimeType || 'application/octet-stream'; // Fallback
                console.log(`Creating audio blob. Recorder mimeType: ${recordedMimeType}, Chunks: ${audioChunksRef.current.length}`);

                const audioBlob = new Blob(audioChunksRef.current, { type: recordedMimeType });
                // audioChunksRef.current = []; // Clear chunks now that blob is made

                // DEBUG: Download blob locally
                const downloadUrl = URL.createObjectURL(audioBlob);
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
                console.log(`DEBUG: Triggered browser download of audio. Size: ${audioBlob.size}, Type: ${audioBlob.type}`);

                if (audioBlob.size < 200) { // Heuristic, a WAV header alone is ~44 bytes
                    showFeedback("Recorded audio seems too short or empty. Please try again.", true);
                    setAppState('listening'); // Or an error state, then back to listening
                    return;
                }

                try {
                    const result = await apiClient.submitAudioAnswer(audioBlob);
                    setTranscribedText(result.transcription);
                    setParsedValue(result.parsed_value);
                    setIsValueFound(result.value_found);
                    if (!result.value_found || result.error_message) {
                        showFeedback(result.error_message || "I couldn't understand a value. Please review.", true);
                    } else {
                        showFeedback(`I understood: ${result.parsed_value}. Is that correct?`);
                    }
                    setAppState('awaitingConfirmation');
                } catch (error) {
                    console.error("Error submitting answer:", error);
                    const detail = error instanceof Error ? error.message : String(error);
                    showFeedback(`Error processing answer: ${detail}. Please try again.`, true);
                    setAppState('awaitingConfirmation'); // Still show what (if anything) was transcribed, or let user retry
                } finally {
                     // Clear chunks here after API call and processing for the current recording
                    audioChunksRef.current = [];
                }
            };
            
            mediaRecorderRef.current.onerror = (event) => {
                console.error("MediaRecorder error:", event);
                // @ts-ignore // MediaRecorderErrorEvent might not be typed well
                showFeedback(`Audio recording error: ${event.error?.name} - ${event.error?.message}. Please try again.`, true);
                setAppState('error'); // Or back to 'presentingQuestion'
                stopMediaTracks(); // Clean up
            };

            setIsSpeaking(false); // Reset: user hasn't started speaking in this recording yet
            let silenceStartTime: number | null = null;

            const checkForSilence = () => {
              if (!analyserRef.current || !mediaRecorderRef.current || mediaRecorderRef.current.state !== 'recording') {
                  if (activityCheckIntervalRef.current) clearInterval(activityCheckIntervalRef.current);
                  activityCheckIntervalRef.current = null; // Ensure it's cleared
                  return;
              }

              analyserRef.current.getByteFrequencyData(dataArray);
              let sum = 0;
              for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
              const averageEnergy = sum / dataArray.length;

              console.log("Avg Energy:", averageEnergy.toFixed(2)); // For debugging

              if (averageEnergy > ENERGY_THRESHOLD) { // Sound detected
                  if (!hasSpeechOccurredRef.current) {
                      // This is the first significant sound detected
                      if (!firstSoundTimeRef.current) {
                          firstSoundTimeRef.current = Date.now(); // Mark when sound started
                      }
                      // Optional: wait for MIN_SPEECH_DURATION_MS before flagging as "speech"
                      if (Date.now() - (firstSoundTimeRef.current || Date.now()) >= MIN_SPEECH_DURATION_MS) {
                          hasSpeechOccurredRef.current = true;
                          console.log("Speech activity started (met min duration).");
                      }
                  }
                  // If sound, clear any pending silence timer
                  if (silenceAfterSpeechTimerRef.current) {
                      clearTimeout(silenceAfterSpeechTimerRef.current);
                      silenceAfterSpeechTimerRef.current = null;
                  }
              } else if (hasSpeechOccurredRef.current && averageEnergy <= ENERGY_THRESHOLD) { // Silence AFTER speech has occurred
                  if (!silenceAfterSpeechTimerRef.current) { // Start silence timer only if not already running
                      console.log("Potential silence after speech started...");
                      silenceAfterSpeechTimerRef.current = setTimeout(() => {
                          if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                              console.log(`Silence persisted for ${SILENCE_DURATION_MS}ms. Stopping recording automatically.`);
                              stopRecording(); // Call your existing stopRecording function
                          }
                      }, SILENCE_DURATION_MS);
                  }
              } else if (!hasSpeechOccurredRef.current && averageEnergy <= ENERGY_THRESHOLD) {
                  // If still in initial silence, reset firstSoundTimeRef so min duration check restarts
                  firstSoundTimeRef.current = null;
              }
          };

          if (activityCheckIntervalRef.current) clearInterval(activityCheckIntervalRef.current);
          activityCheckIntervalRef.current = setInterval(checkForSilence, VOICE_ACTIVITY_CHECK_INTERVAL_MS);

            mediaRecorderRef.current.start(); // Use default timeslice or e.g. start(1000) for 1s chunks
            console.log("MediaRecorder started. State:", mediaRecorderRef.current.state);
            setAppState('listening');
            showFeedback('Please speak your answer now...');
        } catch (err) {
            console.error("Error accessing/starting microphone:", err);
            const errorName = err instanceof Error ? err.name : "UnknownError";
            let userMessage = 'Could not access microphone.';
            if (errorName === 'NotFoundError') userMessage = 'Microphone not found. Please ensure it is connected.';
            else if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') userMessage = 'Microphone access denied. Please enable permissions in your browser settings.';
            
            showFeedback(userMessage, true);
            setAppState('error');
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
          setAppState('stoppingRecording');
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

    const stopVADDetection = useCallback(() => { // Renamed for clarity
      if (activityCheckIntervalRef.current) {
          clearInterval(activityCheckIntervalRef.current);
          activityCheckIntervalRef.current = null;
      }
      if (silenceAfterSpeechTimerRef.current) {
          clearTimeout(silenceAfterSpeechTimerRef.current);
          silenceAfterSpeechTimerRef.current = null;
      }
      if (sourceNodeRef.current) {
          try { sourceNodeRef.current.disconnect(); } catch(e) {}
          sourceNodeRef.current = null;
      }
      if (analyserRef.current) {
          try { analyserRef.current.disconnect(); } catch(e) {}
          analyserRef.current = null;
      }
      hasSpeechOccurredRef.current = false; // Reset for next recording
      firstSoundTimeRef.current = null; // Reset
      console.log("VAD detection resources stopped and reset.");
  }, []);

  const stopMediaTracksAndVAD = useCallback(() => { // Combined cleanup
      stopVADDetection();
      stopMediaTracks(); // Your existing function from useMicStream or similar
  }, [stopVADDetection, stopMediaTracks]);


    // --- Questionnaire Flow Logic ---
    const handleLoadQuestionnaire = async () => {
        setAppState('loadingQuestionnaire');
        showFeedback('Loading questionnaire...');
        try {
            const data = await apiClient.loadQuestionnaire(); // Using default filename from apiClient
            setQuestionnaireInfo({
                title: data.title,
                description: data.description,
                totalQuestions: data.total_questions,
            });
            setAppState('questionnaireReady');
            showFeedback(`Questionnaire "${data.title}" loaded. Click Start.`);
            setConfirmedAnswers([]);
            setCurrentQuestion(null); // Reset current question
        } catch (error) {
            console.error("Error loading questionnaire:", error);
            showFeedback(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
            setAppState('error');
        }
    };

    const handleStartQuestionnaire = () => {
        fetchNextQuestion();
    };
    
    const fetchNextQuestion = async () => {
        setAppState('presentingQuestion');
        showFeedback('Loading next question...');
        try {
            const questionData = await apiClient.getNextQuestion();
            if (questionData.completed) {
                setAppState('questionnaireComplete');
                showFeedback(questionData.message || 'Questionnaire complete! Thank you.');
                setCurrentQuestion(null);
                stopMediaTracks(); // Ensure mic is off
            } else {
                setCurrentQuestion(questionData);
                showFeedback(`Question ${questionData.question_number} of ${questionData.total_questions}. Reading question...`);
                setTranscribedText('');
                setParsedValue(null);
                setIsValueFound(false);
                setErrorMessage(''); // Clear previous errors for new question

                if (audioPlayerRef.current && questionData.audio_url) {
                    const fullAudioUrl = `http://localhost:8000${questionData.audio_url}`; // Assuming backend is on 8000
                    console.log("Playing audio from:", fullAudioUrl);
                    audioPlayerRef.current.src = fullAudioUrl;
                    audioPlayerRef.current.play()
                        .then(() => {
                            console.log("Audio playback started.");
                            setAppState('playingAudio');
                        })
                        .catch(e => {
                            console.error("Error playing audio:", e);
                            showFeedback("Error playing question audio. Proceeding to listen.", true);
                            startRecording(); // Fallback if audio play fails
                        });
                } else {
                    console.warn("Audio player not ready or no audio URL. Proceeding directly to listen.");
                    startRecording();
                }
            }
        } catch (error) {
            console.error("Error fetching next question:", error);
            showFeedback(`Error fetching question: ${error instanceof Error ? error.message : String(error)}`, true);
            setAppState('error');
            stopMediaTracks();
        }
    };

    const handleAudioEnded = () => {
        console.log("Question audio playback ended.");
        if (appState === 'playingAudio') {
           startRecording(); // Automatically start recording after question audio finishes
        }
    };

    const handleConfirmValue = async (isUserCorrectConfirmation: boolean) => {
        if (!currentQuestion) {
            console.error("handleConfirmValue called without currentQuestion.");
            return;
        }

        if (isUserCorrectConfirmation && isValueFound) {
            setAppState('savingAnswer');
            showFeedback('Saving answer...');
            const answerToConfirm: AnswerPayload = {
                question_id: currentQuestion.question_id,
                question_text: currentQuestion.question_text,
                transcribed_response: transcribedText,
                parsed_value: parsedValue,
                is_confirmed: true,
            };
            try {
                await apiClient.confirmAnswer(answerToConfirm);
                setConfirmedAnswers(prev => [...prev, answerToConfirm]);
                showFeedback('Answer saved.');
                fetchNextQuestion();
            } catch (error) {
                console.error("Error confirming answer:", error);
                showFeedback(`Error saving: ${error instanceof Error ? error.message : String(error)}. Please try again.`, true);
                setAppState('awaitingConfirmation'); // Stay on confirmation
            }
        } else {
            // User said "No, try again" OR value wasn't found and they implicitly want to retry
            showFeedback('Okay, let\'s try that question again. Please speak your answer.');
            setTranscribedText('');
            setParsedValue(null);
            setIsValueFound(false);
            setErrorMessage(''); // Clear error for retry
            startRecording(); // Go back to listening for the same question
        }
    };
    
    const handleDownloadResults = async () => {
        showFeedback('Preparing results for download...');
        try {
            await apiClient.downloadResults();
            showFeedback('Results download initiated.');
        } catch (error) {
            console.error("Error downloading results:", error);
            showFeedback(`Download error: ${error instanceof Error ? error.message : String(error)}`, true);
        }
    };

    const handleReset = async () => {
        showFeedback('Resetting application...');
        stopRecording(); // Stop any active recording
        stopMediaTracks(); // Ensure microphone is off

        if (audioPlayerRef.current) { // Stop any playing audio
            audioPlayerRef.current.pause();
            audioPlayerRef.current.src = '';
        }
        try {
            await apiClient.resetState(); // Call backend reset
        } catch (error) {
            console.warn("Error resetting backend state, continuing with frontend reset:", error);
            // Proceed with frontend reset even if backend reset fails for POC
        } finally {
            setAppState('idle');
            setQuestionnaireInfo(null);
            setCurrentQuestion(null);
            setTranscribedText('');
            setParsedValue(null);
            setIsValueFound(false);
            setFeedbackMessage('Application reset. Load a new questionnaire.');
            setErrorMessage('');
            setConfirmedAnswers([]);
            audioChunksRef.current = []; // Clear any stray chunks
            console.log("Application state reset.");
        }
    };

    // Effect to clean up media stream on component unmount
    useEffect(() => {
      return () => {
          console.log("HomePage unmounting. Cleaning up media and VAD.");
          // Ensure recorder is stopped first (will trigger its onstop which calls stopVADDetection)
          if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
              try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Error stopping MR on unmount:", e); }
          } else {
              // If recorder was already inactive or null, VAD might still need explicit cleanup
              stopVADDetection();
          }
          stopMediaTracks(); // Stop the media stream tracks
          
          if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
              try { audioContextRef.current.close(); } catch(e) { console.warn("Error closing AC on unmount:", e); }
              audioContextRef.current = null;
          }
      };
  }, [stopVADDetection, stopMediaTracks]);


    // --- UI Rendering ---
    const renderContent = () => {
        switch (appState) {
            case 'idle':
                return <button onClick={handleLoadQuestionnaire} className={`${styles.buttonBase} ${styles.actionButton}`}>Load Questionnaire</button>;
            case 'loadingQuestionnaire':
                return <p>Loading Questionnaire...</p>;
            case 'questionnaireReady':
                  return questionnaireInfo && (
                      // Use the new class for this section
                      <div className={styles.questionnaireInfoDisplay}> 
                          <h2>{questionnaireInfo.title}</h2>
                          <p>{questionnaireInfo.description}</p>
                          <p>Total Questions: {questionnaireInfo.totalQuestions}</p>
                          <button onClick={handleStartQuestionnaire} className={`${styles.buttonBase} ${styles.actionButton}`}>Start Questionnaire</button>
                      </div>
                  );
                  case 'transcribing':
              case 'listening':
                return currentQuestion && ( // Added currentQuestion check for safety
                    <div className={styles.questionArea}>
                        {/* ... existing question text ... */}
                        <div>
                            {appState === 'transcribing' && <p><em>(Processing your answer...)</em></p>}
                            {appState === 'listening' && <p><em>(Listening for your answer... Microphone is ON)</em></p>}
                            {/* Ensure this button uses a suitable class, e.g., actionButton or a specific one */}
                            {appState === 'listening' &&<button onClick={stopRecording} className={`${styles.buttonBase} ${styles.retryButton}`}>Stop Recording</button>}
                        </div>
                    </div>
                );
                case 'presentingQuestion':
                  case 'playingAudio':
            case 'stoppingRecording':
            
                return currentQuestion && (
                    <div className={styles.questionArea}>
                        <h3>Question {currentQuestion.question_number} of {currentQuestion.total_questions}</h3>
                        <p className={styles.questionText}>{currentQuestion.question_text}</p>
                        {currentQuestion.options_text && <p className={styles.optionsText}>{currentQuestion.options_text}</p>}
                        
                        {appState === 'playingAudio' && <p><em>(Playing question audio...)</em></p>}
                        
                        {appState === 'stoppingRecording' && <p><em>(Finishing recording...)</em></p>}
                        
                    </div>
                );
                case 'awaitingConfirmation':
                  return (
                      <div className={styles.confirmationArea}>
                          <h4>Review Your Answer:</h4>
                          <p><strong>You said:</strong> "{transcribedText}"</p>
                          {isValueFound && parsedValue !== null && (
                              <p><strong>I understood the value:</strong> {String(parsedValue)}</p>
                          )}
                          {!isValueFound && transcribedText && <p><strong>I couldn't identify a specific value from your response.</strong></p>}
                          {!transcribedText && <p><strong>No speech was transcribed.</strong></p>}
                          
                          <p>Is this correct?</p>
                          {/* Use buttonGroup for layout */}
                          <div className={styles.buttonGroup}>
                              <button onClick={() => handleConfirmValue(true)} disabled={!isValueFound && parsedValue === null} className={`${styles.buttonBase} ${styles.confirmButton}`}>Yes, Confirm Value</button>
                              <button onClick={() => handleConfirmValue(false)} className={`${styles.buttonBase} ${styles.retryButton}`}>No, Try Again</button>
                          </div>
                      </div>
                  );
            case 'savingAnswer':
                 return <p>Saving answer...</p>;
                 case 'questionnaireComplete':
                  return (
                      <div className={styles.completeArea}>
                          <h2>Questionnaire Complete!</h2>
                          <p>{feedbackMessage}</p> {/* Will show completion message */}
                           {/* Use buttonGroup for layout if desired, or just stack them */}
                          <div className={styles.buttonGroup}>
                              <button onClick={handleDownloadResults} className={`${styles.buttonBase} ${styles.actionButton}`}>Download Results (CSV)</button>
                              <button onClick={handleReset} className={`${styles.buttonBase} ${styles.secondaryButton}`}>Start New Questionnaire</button>
                          </div>
                      </div>
                  );
            case 'error':
                 return (
                    <div className={styles.errorArea}>
                        <h3>An Error Occurred</h3>
                        {/* ErrorMessage is already displayed in the feedback area */}
                        <button onClick={handleReset} className={`${styles.buttonBase} ${styles.actionButton}`}>Reset Application</button>
                        {/* Optionally add a button to retry the last sensible action */}
                    </div>
                );
            default:
                return <p>Loading or unknown state...</p>;
        }
    };

    return (
      <div className={styles.container}>
          <header className={styles.header}>
              <h1>Voice Questionnaire App</h1> {/* Simplified title */}
              <button 
                  onClick={handleReset} 
                  className={`${styles.buttonBase} ${styles.secondaryButton}`} // Use secondary style for less emphasis
                  disabled={appState === 'idle' && !questionnaireInfo}
              >
                  Reset / New
              </button>
          </header>

          <main className={styles.main}>
              <div className={styles.statusArea}>
                  <p><strong>Status:</strong> {appState}</p>
                  {/* Conditionally apply errorFeedback class */}
                  {feedbackMessage && <p className={`${styles.feedback} ${errorMessage ? styles.errorFeedback : ''}`}>{feedbackMessage}</p>}
              </div>
              
              {renderContent()}
              
              <audio ref={audioPlayerRef} onEnded={handleAudioEnded} style={{ display: 'none' }} />
          </main>

          <footer className={styles.footer}>
              <p>© {new Date().getFullYear()} Florian Kümmel</p> {/* Example footer text */}
          </footer>
      </div>
  );
}