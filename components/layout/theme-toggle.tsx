"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Laptop } from "lucide-react";
import { Button } from "@/components/ui/button";

// Light → dark → system. Renders a neutral icon until mounted so the server
// and client markup agree.
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const Icon = !mounted ? Laptop : theme === "light" ? Sun : theme === "dark" ? Moon : Laptop;
  return (
    <Button variant="ghost" size="icon-sm" aria-label={`Theme: ${mounted ? theme : "system"} — switch to ${next}`} title={`Theme: ${mounted ? theme : "system"}`} onClick={() => setTheme(next)}>
      <Icon className="h-4 w-4" />
    </Button>
  );
}
