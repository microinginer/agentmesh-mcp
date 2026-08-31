import type { ReactNode } from "react";

import { ThemeProvider } from "@/components/theme-provider";

export interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
