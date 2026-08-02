import { useState } from "react";
import { DismissButton } from "./DismissButton";
import "./PackIntegrityBanner.css";

export function PackIntegrityBanner({ message }: { message: string | null }) {
  const [dismissedMessage, setDismissedMessage] = useState<string | null>(null);

  if (!message || dismissedMessage === message) {
    return null;
  }

  return (
    <div role="alert" className="pack-integrity-banner">
      <span>{message}</span>
      <DismissButton
        label="Close jurisdiction rules warning"
        onClick={() => setDismissedMessage(message)}
      />
    </div>
  );
}
