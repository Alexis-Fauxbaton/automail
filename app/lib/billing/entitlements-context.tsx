import { createContext, useContext, type ReactNode } from "react";
import type { Entitlements } from "./entitlements";

const EntitlementsContext = createContext<Entitlements | null>(null);

export function EntitlementsProvider({
  value,
  children,
}: {
  value: Entitlements;
  children: ReactNode;
}) {
  return (
    <EntitlementsContext.Provider value={value}>
      {children}
    </EntitlementsContext.Provider>
  );
}

/**
 * Hook to read the current shop's entitlements. Throws if used outside
 * a provider — defensive: every page rendered under `/app/*` must have
 * the provider mounted by the root loader (`app.tsx`).
 */
export function useEntitlements(): Entitlements {
  const ctx = useContext(EntitlementsContext);
  if (!ctx) {
    throw new Error("useEntitlements must be used within EntitlementsProvider");
  }
  return ctx;
}
