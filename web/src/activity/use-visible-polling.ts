import { useEffect, useRef } from "react";

const MAX_BACKOFF_MULTIPLIER = 8;

export function useVisiblePolling(poll: () => Promise<void>, interval: number): void {
  const latestPoll = useRef(poll);
  latestPoll.current = poll;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      const multiplier = Math.min(2 ** failures, MAX_BACKOFF_MULTIPLIER);
      timer = setTimeout(() => {
        timer = null;
        void latestPoll.current()
          .then(() => {
            failures = 0;
          })
          .catch(() => {
            failures += 1;
          })
          .finally(schedule);
      }, interval * multiplier);
    };

    const handleVisibility = () => schedule();
    document.addEventListener("visibilitychange", handleVisibility);
    schedule();
    return () => {
      stopped = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [interval]);
}
