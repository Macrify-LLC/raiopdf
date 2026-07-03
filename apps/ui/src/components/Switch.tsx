import "./Switch.css";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean | undefined;
  id?: string | undefined;
  /**
   * Accessible name. Provide this OR `aria-labelledby` -- not both. Use
   * `label` for a standalone switch with no adjacent visible text; use
   * `aria-labelledby`/`aria-describedby` when the switch sits next to its
   * own `<strong>`/`<small>` pair (the Preferences row pattern), so the
   * accessible name and the on-screen copy can never drift apart.
   */
  label?: string | undefined;
  "aria-labelledby"?: string | undefined;
  "aria-describedby"?: string | undefined;
}

/**
 * A real on/off capability switch (`role="switch"`), not a decorative
 * checkbox reskin. Built as a button -- rather than a styled
 * `<input type="checkbox">` -- so the accessible state is `aria-checked`
 * and the hit target is the whole pill, not just a 16px box.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  id,
  label,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
}: SwitchProps) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabelledBy ? undefined : label}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      className="switch"
      data-checked={checked ? "true" : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__track">
        <span className="switch__thumb" />
      </span>
    </button>
  );
}
