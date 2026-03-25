import { useState, useRef } from 'react';
import { Upload, X, Image as ImageIcon, Camera, Zap, Activity } from 'lucide-react';
import { Button, GlassCard } from '../ui/PremiumComponents';
import { fileToBase64 } from '@/lib/utils';
import { useAnalyzeCharts } from '@workspace/api-client-react';
import type { AnalyzeChartsBodyImagesItem } from '@workspace/api-client-react/src/generated/api.schemas';

const TIMEFRAMES = ['D1', 'H4', 'H1', 'M15', 'M5'];

interface Props {
  symbol: string;
  currentPrice: number;
  balance: number;
  dailyGoal: number;
  onAnalysisStart: () => void;
  onAnalysisComplete: (result: any) => void;
  onAnalysisError: (err: Error) => void;
}

export function ImageUploader({ symbol, currentPrice, balance, dailyGoal, onAnalysisStart, onAnalysisComplete, onAnalysisError }: Props) {
  const [images, setImages] = useState<Array<{ file: File; base64: string; timeframe: string; previewUrl: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const analyzeMutation = useAnalyzeCharts();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    
    const newFiles = Array.from(e.target.files);
    const availableSlots = 5 - images.length;
    const filesToProcess = newFiles.slice(0, availableSlots);

    const processed = await Promise.all(
      filesToProcess.map(async (file) => {
        const base64 = await fileToBase64(file);
        const previewUrl = URL.createObjectURL(file);
        // Auto-assign next available timeframe
        const usedTfs = images.map(img => img.timeframe);
        const nextTf = TIMEFRAMES.find(tf => !usedTfs.includes(tf)) || TIMEFRAMES[0];
        
        return { file, base64, timeframe: nextTf, previewUrl };
      })
    );

    setImages(prev => [...prev, ...processed]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index: number) => {
    setImages(prev => {
      const newImages = [...prev];
      URL.revokeObjectURL(newImages[index].previewUrl);
      newImages.splice(index, 1);
      return newImages;
    });
  };

  const handleAnalyze = async () => {
    if (images.length === 0) return;
    
    onAnalysisStart();
    
    const formattedImages: AnalyzeChartsBodyImagesItem[] = images.map(img => ({
      timeframe: img.timeframe,
      base64: img.base64,
      mediaType: img.file.type
    }));

    try {
      const result = await analyzeMutation.mutateAsync({
        data: {
          symbol,
          currentPrice,
          balance,
          dailyGoal,
          images: formattedImages
        }
      });
      onAnalysisComplete(result);
    } catch (err: any) {
      onAnalysisError(err);
    }
  };

  return (
    <GlassCard className="p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
            <Camera className="w-4 h-4" /> Vision Analysis
          </h3>
          <p className="text-xs text-muted-foreground mt-1">Upload chart screenshots for AI context</p>
        </div>
        
        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handleFileChange} 
          accept="image/*" 
          multiple 
          className="hidden" 
        />
        
        <Button 
          variant="secondary" 
          size="sm" 
          onClick={() => fileInputRef.current?.click()}
          disabled={images.length >= 5 || analyzeMutation.isPending}
        >
          <Upload className="w-4 h-4 mr-2" /> Add Image
        </Button>
      </div>

      {images.length > 0 ? (
        <div className="grid grid-cols-5 gap-2">
          {images.map((img, idx) => (
            <div key={idx} className="relative group rounded-md overflow-hidden border border-border aspect-square bg-secondary">
              <img src={img.previewUrl} alt={`Upload ${idx}`} className="w-full h-full object-cover opacity-80" />
              <button 
                onClick={() => removeImage(idx)}
                className="absolute top-1 right-1 bg-black/70 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3 text-white" />
              </button>
              <div className="absolute bottom-0 inset-x-0 bg-black/80 px-1 py-0.5">
                <select 
                  value={img.timeframe}
                  onChange={(e) => {
                    const newImages = [...images];
                    newImages[idx].timeframe = e.target.value;
                    setImages(newImages);
                  }}
                  className="w-full bg-transparent text-[10px] font-bold text-center outline-none cursor-pointer text-primary"
                >
                  {TIMEFRAMES.map(tf => <option key={tf} value={tf} className="bg-secondary">{tf}</option>)}
                </select>
              </div>
            </div>
          ))}
          {/* Empty slots placeholders */}
          {Array.from({ length: 5 - images.length }).map((_, i) => (
            <div key={`empty-${i}`} className="border border-dashed border-border/50 rounded-md aspect-square flex items-center justify-center opacity-30">
              <ImageIcon className="w-6 h-6 text-muted-foreground" />
            </div>
          ))}
        </div>
      ) : (
        <div 
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-border/50 rounded-lg p-6 flex flex-col items-center justify-center cursor-pointer hover:bg-secondary/20 transition-colors text-muted-foreground hover:text-foreground hover:border-primary/50"
        >
          <Upload className="w-8 h-8 mb-2 opacity-50" />
          <span className="text-sm font-medium">Click or drop screenshots</span>
          <span className="text-xs mt-1">D1, H4, H1, M15, M5</span>
        </div>
      )}

      <Button 
        variant="primary" 
        className="w-full relative overflow-hidden" 
        disabled={images.length === 0 || analyzeMutation.isPending}
        onClick={handleAnalyze}
      >
        {analyzeMutation.isPending ? (
          <span className="flex items-center animate-pulse">
            <Activity className="w-5 h-5 mr-2 animate-spin" /> ANALYZING PATTERNS...
          </span>
        ) : (
          <span className="flex items-center font-bold tracking-widest">
            <Zap className="w-4 h-4 mr-2" /> RUN AI SYNTHESIS
          </span>
        )}
      </Button>
    </GlassCard>
  );
}
