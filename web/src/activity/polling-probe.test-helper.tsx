import { useVisiblePolling } from "./use-visible-polling";

export function PollingProbe({ poll, interval }: { poll: () => Promise<void>; interval: number }) {
  useVisiblePolling(poll, interval);
  return null;
}
