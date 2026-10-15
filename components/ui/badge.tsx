import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow",
        outline: "text-foreground",
        success:
          "border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400",
        warning:
          "border-yellow-500/20 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
        danger:
          "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400",
        info:
          "border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400",
        purple:
          "border-purple-500/20 bg-purple-500/10 text-purple-600 dark:text-purple-400",
        gold:
          "border-money/20 bg-money/10 text-money",
        // Pipeline statuses
        hot: "border-red-500/30 bg-red-500/20 text-red-600 dark:text-red-400",
        warm: "border-orange-500/30 bg-orange-500/20 text-orange-600 dark:text-orange-400",
        cold: "border-gray-500/30 bg-gray-500/20 text-gray-600 dark:text-gray-400",
        open: "border-blue-500/30 bg-blue-500/20 text-blue-600 dark:text-blue-400",
        "on-hold": "border-yellow-500/30 bg-yellow-500/20 text-yellow-600 dark:text-yellow-400",
        chase: "border-purple-500/30 bg-purple-500/20 text-purple-600 dark:text-purple-400",
      },
      size: {
        default: "px-2.5 py-0.5 text-xs",
        sm: "px-2 py-0.5 text-[10px]",
        lg: "px-3 py-1 text-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

function Badge({ className, variant, size, dot, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {dot && (
        <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {children}
    </div>
  );
}

export { Badge, badgeVariants };
