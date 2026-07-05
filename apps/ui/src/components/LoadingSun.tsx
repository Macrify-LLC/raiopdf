import { SunMarkIcon } from "../icons";
import "./LoadingSun.css";

export interface LoadingSunProps {
  size?: number;
  label?: string;
}

export function LoadingSun({
  size = 16,
  label = "Working",
}: LoadingSunProps) {
  return (
    <span
      className="loading-sun"
      role="img"
      aria-label={label}
      style={{ width: size, height: size }}
    >
      <SunMarkIcon size={size} />
    </span>
  );
}
