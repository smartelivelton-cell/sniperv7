import React from 'react';
import { cn } from '@/lib/utils';
import { motion, HTMLMotionProps } from 'framer-motion';

// Premium Card
export function GlassCard({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div 
      className={cn(
        "bg-card/90 backdrop-blur-md border border-border/50 rounded-xl overflow-hidden",
        "shadow-lg shadow-black/50 relative group",
        className
      )}
      {...props}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
      {children}
    </div>
  );
}

// Premium Button
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => {
    const variants = {
      primary: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_15px_rgba(243,186,47,0.2)] hover:shadow-[0_0_20px_rgba(243,186,47,0.4)]",
      secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-border",
      danger: "bg-destructive/10 text-destructive border border-destructive/30 hover:bg-destructive/20 hover:border-destructive/50",
      success: "bg-success text-success-foreground hover:bg-success/90 shadow-[0_0_15px_rgba(0,255,136,0.2)]",
      ghost: "hover:bg-secondary text-foreground",
    };
    
    const sizes = {
      sm: "h-8 px-3 text-xs",
      md: "h-10 px-4 py-2",
      lg: "h-12 px-6 text-lg font-bold uppercase tracking-wider",
    };

    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-md font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

// Premium Input
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    return (
      <input
        className={cn(
          "flex h-10 w-full rounded-md border border-border bg-input/50 px-3 py-2 text-sm text-foreground font-mono placeholder:text-muted-foreground placeholder:font-sans focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 transition-colors",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

// Label
export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn("text-xs font-semibold leading-none text-muted-foreground uppercase tracking-wider mb-1.5 block", className)}
      {...props}
    />
  )
);
Label.displayName = "Label";

// Badge
export function Badge({ className, variant = 'default', children }: { className?: string, variant?: 'default' | 'success' | 'danger' | 'warning', children: React.ReactNode }) {
  const variants = {
    default: "bg-secondary text-secondary-foreground border border-border",
    success: "bg-success/10 text-success border border-success/30 text-glow-success",
    danger: "bg-destructive/10 text-destructive border border-destructive/30 text-glow-destructive",
    warning: "bg-primary/10 text-primary border border-primary/30 text-glow-primary",
  };
  
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold font-mono tracking-wider", variants[variant], className)}>
      {children}
    </span>
  );
}
