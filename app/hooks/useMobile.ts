import { useEffect, useState } from "react";

/**
 * Returns true when the viewport width is ≤ breakpoint (default 768px).
 * Defaults to false on first render so SSR doesn't crash on missing `window`.
 */
export function useMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= breakpoint);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [breakpoint]);
  return isMobile;
}
