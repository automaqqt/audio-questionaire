// components/participant/QuestionDisplay.tsx
"use client";

// Make sure QuestionWithAudioClientType uses the updated QuestionClientBase with typed visualOptions
import { QuestionWithAudioClientType, VisualOptionItem } from '@/types/questionnaire'; 
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"; 
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils"; // Shadcn utility for conditional classes

interface QuestionDisplayProps {
  question: QuestionWithAudioClientType;
  currentAnswer: string | undefined;
  onAnswerChange: (questionId: string, answer: string) => void;
  onNext: () => void;
  isSubmitted?: boolean;
}

// New helper to get options for scale questions, prioritizing visualOptions
const getScaleOptions = (question: QuestionWithAudioClientType): VisualOptionItem[] => {
  // 1. Prioritize structured visualOptions if available
  //const visualQ = new Array(question.visualOptions.slice(1,-1).split(","));
  const visualQ = JSON.parse(question.visualOptions)
  if (visualQ ) {
    // Ensure the items in visualOptions match VisualOptionItem structure
    // This might involve a type assertion or a mapping if the DB stores it slightly differently
    //console.log(visualQ)
    return visualQ.map((opt: VisualOptionItem) => ({
        value: String(opt.value), // Ensure value is string
        label: String(opt.label)  // Ensure label is string
    }));
  }

  // 2. Fallback: Generate from minValue, maxValue, and parse optionsText for labels
  if (question.minValue !== null && question.minValue !== undefined && 
      question.maxValue !== null && question.maxValue !== undefined) {
    const options: VisualOptionItem[] = [];
    const labelMap = new Map<string, string>();
    if (question.optionsText) {
        // Simple parser: "1=Label One, 2=Label Two" or "1: Label One; 2: Label Two"
        const parts = question.optionsText.matchAll(/(\d+)\s*[:=]\s*([^,;]+)/g);
        for (const match of parts) {
            labelMap.set(match[1].trim(), match[2].trim());
        }
    }

    for (let i = question.minValue; i <= question.maxValue; i++) {
      options.push({
        value: String(i),
        label: labelMap.get(String(i)) || String(i), // Use parsed label or just the number
      });
    }
    if (options.length > 0) return options;
  }
  
  // 3. Absolute Fallback (if no visualOptions and no min/max for a scale type - less ideal)
  // This case should ideally be prevented by good questionnaire design.
  // For now, return an empty array or a default if this scenario is possible.
  console.warn(`Question ${question.id} is type 'scale' but has no visualOptions or min/max values.`);
  return [];
};


export default function QuestionDisplay({ question, currentAnswer, onAnswerChange, onNext, isSubmitted }: QuestionDisplayProps) {
  if (!question) return null;

  const handleRadioChange = (value: string) => {
    onAnswerChange(question.id, value);
    onNext();
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    onAnswerChange(question.id, event.target.value);
  };

  const scaleOptions = question.type === "scale" ? getScaleOptions(question) : [];

  return (
    <div className="space-y-6 rounded-lg border bg-card text-card-foreground shadow-sm p-6 md:p-8">
      <div className="space-y-2">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-center">
          {question.text}
        </h2>
        {/* Display general optionsText if it exists, regardless of how options are generated */}
        {question.optionsText && !question.visualOptions && (
          <p className="text-sm text-muted-foreground text-center italic">{question.optionsText}</p>
        )}
      </div>

      {question.type === "scale" && scaleOptions.length > 0 && (
        <RadioGroup
          value={currentAnswer}
          onValueChange={handleRadioChange}
          // Dynamic grid columns based on number of options, up to a max
          className={cn(
            "grid gap-3 items-stretch justify-center pt-4", // items-stretch for equal height labels
            scaleOptions.length <= 3 ? "grid-cols-1 sm:grid-cols-" + scaleOptions.length :
            scaleOptions.length <= 5 ? "sm:grid-cols-3 md:grid-cols-" + scaleOptions.length :
            "sm:grid-cols-3 md:grid-cols-5" // Max 5 columns for larger screens
          )}
          disabled={isSubmitted}
          aria-label={`Options for: ${question.text}`}
        >
          {scaleOptions.map((option) => (
            <Label
              key={option.value}
              htmlFor={`${question.id}-${option.value}`}
              className={cn(
                `flex flex-col items-center justify-center space-y-1.5 rounded-md border-2 p-3 sm:p-4 text-center leading-tight transition-all`,
                `hover:border-primary dark:hover:border-primary`,
                currentAnswer === option.value 
                  ? 'border-primary ring-2 ring-primary ring-offset-background dark:border-primary' 
                  : 'border-muted hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-500',
                isSubmitted 
                  ? 'cursor-not-allowed opacity-60' 
                  : 'cursor-pointer'
              )}
            >
              <RadioGroupItem 
                value={option.value} 
                id={`${question.id}-${option.value}`} 
                className="sr-only" // Hide the actual radio dot, style the Label instead
              />
              {/* Option Label Text */}
              <span className="text-sm font-medium">{option.label}</span>
              {/* Optional: Display the numeric value if it's different from the label and desired */}
              {/* {option.label !== option.value && <span className="text-xs text-muted-foreground">({option.value})</span>} */}
            </Label>
          ))}
        </RadioGroup>
      )}

      {question.type === "text_input" && (
        <Input
          type="text"
          value={currentAnswer || ""}
          onChange={handleInputChange}
          placeholder="Type your answer here..."
          disabled={isSubmitted}
          className="mt-2"
          aria-label={`Answer for: ${question.text}`}
        />
      )}

      {question.type === "textarea" && (
        <Textarea
          value={currentAnswer || ""}
          onChange={handleInputChange}
          placeholder="Type your detailed answer here..."
          disabled={isSubmitted}
          className="mt-2 min-h-[100px]"
          aria-label={`Detailed answer for: ${question.text}`}
        />
      )}
      {/* Add more question types as needed */}
    </div>
  );
}